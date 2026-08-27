/**
 * One account's Claude subscription, stored and kept fresh.
 *
 * The machine-local reader in `claudeCode.ts` deliberately never refreshes: that credential
 * belongs to the `claude` CLI, and rotating its refresh token would break the CLI's own
 * session. This one is the opposite case in every respect. The credential was minted *for*
 * this app by a login the user did here, no CLI is holding a second copy, and nothing else
 * will ever refresh it — so refreshing is not just safe, it is the only thing keeping the
 * account connected past the first hour.
 *
 * Which means the rotated refresh token has to be written back. A refresh that returns a new
 * refresh token and drops it on the floor works exactly once and then logs the user out for
 * reasons nobody can reconstruct.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Db } from '../../db/pool.js';
import { ClaudeCodeAuthError, refreshClaudeCodeToken, type ClaudeCodeIdentity } from './claudeCode.js';

/** Refresh this far ahead of expiry so a generation never races the exchange. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface StoredPayload {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
}

export interface ClaudeAccountStatus {
  connected: boolean;
  plan: string | null;
  expiresAt: number | null;
  expired: boolean;
  scopes: string[];
}

export class ClaudeAccountStore {
  private readonly cipherKey: Buffer;
  /** One in-flight refresh per user, so a burst of generations triggers one exchange. */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly db: Db,
    sessionSecret: string,
  ) {
    // Same derivation as the settings table, with a different label so the two cannot be
    // swapped: a ciphertext from one must not decrypt under the other's key.
    this.cipherKey = createHash('sha256').update(`craftmagic-claude-oauth:${sessionSecret}`).digest();
  }

  private encrypt(value: StoredPayload): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.cipherKey, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('hex')].join(':');
  }

  private decrypt(stored: string): StoredPayload | null {
    const parts = stored.split(':');
    if (parts.length !== 3) return null;
    try {
      const [ivHex, tagHex, dataHex] = parts as [string, string, string];
      const decipher = createDecipheriv('aes-256-gcm', this.cipherKey, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(dataHex, 'hex')),
        decipher.final(),
      ]).toString('utf8');
      const parsed: unknown = JSON.parse(plain);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const value = parsed as Partial<StoredPayload>;
      if (typeof value.accessToken !== 'string') return null;
      return {
        accessToken: value.accessToken,
        refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : null,
        scopes: Array.isArray(value.scopes) ? value.scopes.filter((s): s is string => typeof s === 'string') : [],
      };
    } catch {
      // A rotated SESSION_SECRET, or a tampered row. Reading it as "not connected" sends the
      // user through the login again, which is a working recovery; throwing here would take
      // the whole page down for a credential that is merely unreadable.
      return null;
    }
  }

  async save(
    userId: string,
    identity: { accessToken: string; refreshToken: string | null; expiresAt: number; scopes: string[]; subscriptionType: string | null },
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO claude_oauth (user_id, payload, plan, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE
         SET payload = EXCLUDED.payload,
             plan = EXCLUDED.plan,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()`,
      [
        userId,
        this.encrypt({
          accessToken: identity.accessToken,
          refreshToken: identity.refreshToken,
          scopes: identity.scopes,
        }),
        identity.subscriptionType,
        Math.round(identity.expiresAt),
      ],
    );
  }

  async forget(userId: string): Promise<void> {
    await this.db.query('DELETE FROM claude_oauth WHERE user_id = $1', [userId]);
  }

  async status(userId: string, now = Date.now()): Promise<ClaudeAccountStatus> {
    const { rows } = await this.db.query<{ payload: string; plan: string | null; expires_at: string }>(
      'SELECT payload, plan, expires_at FROM claude_oauth WHERE user_id = $1',
      [userId],
    );
    const row = rows[0];
    if (!row) return { connected: false, plan: null, expiresAt: null, expired: false, scopes: [] };

    const payload = this.decrypt(row.payload);
    if (!payload) return { connected: false, plan: null, expiresAt: null, expired: false, scopes: [] };

    const expiresAt = Number(row.expires_at);
    return {
      connected: true,
      plan: row.plan,
      expiresAt,
      // Reported rather than hidden. It is not a failure — a refresh happens on the next
      // call — but a status line that says "connected" while the token is dead is a status
      // line that will look like a lie the first time something goes wrong.
      expired: expiresAt - EXPIRY_BUFFER_MS <= now,
      scopes: payload.scopes,
    };
  }

  /**
   * A usable access token for this account, refreshing if it has gone stale.
   *
   * Deduped per user: a page that fires three generations at once must not race three
   * refreshes against each other, because the loser of that race is holding a refresh token
   * the winner has already rotated away.
   */
  async token(userId: string, now = () => Date.now()): Promise<string> {
    const existing = this.refreshing.get(userId);
    if (existing) return existing;

    const { rows } = await this.db.query<{ payload: string; plan: string | null; expires_at: string }>(
      'SELECT payload, plan, expires_at FROM claude_oauth WHERE user_id = $1',
      [userId],
    );
    const row = rows[0];
    if (!row) throw new ClaudeCodeAuthError('This account has no Claude subscription connected.', true);

    const payload = this.decrypt(row.payload);
    if (!payload) {
      throw new ClaudeCodeAuthError(
        'The stored Claude credential could not be read. Connect the subscription again.',
        true,
      );
    }

    const expiresAt = Number(row.expires_at);
    if (expiresAt - EXPIRY_BUFFER_MS > now()) return payload.accessToken;

    const work = (async () => {
      const identity: ClaudeCodeIdentity = {
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        expiresAt,
        subscriptionType: row.plan,
        scopes: payload.scopes,
        source: 'file',
      };
      const refreshed = await refreshClaudeCodeToken(identity, { now });
      // Written back before it is handed out: the rotated refresh token is the only one that
      // will work next time, and losing it costs the user a re-login for no visible reason.
      await this.save(userId, {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
        scopes: refreshed.scopes,
        subscriptionType: refreshed.subscriptionType,
      });
      return refreshed.accessToken;
    })();

    this.refreshing.set(userId, work);
    try {
      return await work;
    } finally {
      this.refreshing.delete(userId);
    }
  }
}
