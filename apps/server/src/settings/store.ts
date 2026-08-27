/**
 * Runtime settings, including the AI provider credential.
 *
 * Two properties matter here:
 *
 *   * **Secrets are encrypted at rest.** This table holds a key that can spend money, and a
 *     database dump is a far more ordinary accident than a compromised host. AES-256-GCM with
 *     a key derived from `SESSION_SECRET`, stored as `iv:tag:ciphertext`. GCM rather than CBC
 *     so a tampered value fails to decrypt instead of decrypting to garbage.
 *   * **A secret is never read back out to a caller.** The admin page shows a masked hint
 *     (`sk-ant-…9ZQ`) built from the plaintext, and there is no route that returns the whole
 *     value. Nothing needs it except the code that calls the provider.
 *
 * Rotating `SESSION_SECRET` makes stored secrets unreadable. That is the honest trade for not
 * introducing a second secret to manage, and `get` treats a failed decrypt as "unset" rather
 * than throwing, so the app falls back to the environment instead of failing to boot.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { isSubscription, wireOf, type ProviderId } from '../generate/pricing.js';

export const SETTING_KEYS = {
  provider: 'ai.provider',
  model: 'ai.model',
  anthropicKey: 'ai.anthropic.apiKey',
  openaiKey: 'ai.openai.apiKey',
} as const;

export interface AiSettings {
  provider: ProviderId;
  model: string;
  /**
   * The key for the selected provider.
   *
   * Null for the two subscription providers, and that is not "unset": their credential is the
   * local `claude` or `codex` login, which is read at call time and never stored here. A
   * caller deciding whether generation can run has to ask `ready` rather than this.
   */
  apiKey: string | null;
  /** Where that key came from, so the admin page can say so rather than implying it is unset. */
  keySource: 'settings' | 'environment' | 'subscription' | 'none';
  /**
   * Whether the selected provider has everything it needs.
   *
   * A metered provider needs a key; a subscription provider needs a login on this machine.
   * One question, because every caller asks the same one and none of them should have to
   * know which kind of provider is selected to ask it.
   */
  ready: boolean;
  /** Masked for display: enough to recognise a key, never enough to use one. */
  anthropicKeyHint: string | null;
  openaiKeyHint: string | null;
}

/**
 * What a provider runs by default.
 *
 * A subscription is bound to a plan rather than to a rate card, so the default is the model
 * that plan is actually good for: the Claude Code plan bills Opus and Sonnet the same way, and
 * Codex is a ChatGPT plan whose model list is its own.
 */
export function defaultModelFor(provider: ProviderId): string {
  switch (provider) {
    case 'openai':
      return 'gpt-5';
    case 'codex':
      return 'gpt-5-codex';
    case 'claude-code':
      return 'claude-sonnet-5';
    default:
      return 'claude-sonnet-5';
  }
}

/** Recognisable but useless: first 7 characters and last 4. */
export function maskKey(key: string): string {
  if (key.length <= 14) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

export class SettingsStore {
  private readonly cipherKey: Buffer;

  constructor(
    private readonly db: Db,
    sessionSecret: string,
  ) {
    // Hashed rather than used raw: the secret is an arbitrary-length string and AES needs
    // exactly 32 bytes.
    this.cipherKey = createHash('sha256').update(`craftmagic-settings:${sessionSecret}`).digest();
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.cipherKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), encrypted.toString('hex')].join(':');
  }

  private decrypt(stored: string): string | null {
    const parts = stored.split(':');
    if (parts.length !== 3) return null;
    try {
      const [ivHex, tagHex, dataHex] = parts as [string, string, string];
      const decipher = createDecipheriv('aes-256-gcm', this.cipherKey, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
    } catch {
      // Wrong SESSION_SECRET, or a tampered row. Either way this value is not usable, and
      // reporting "unset" lets the environment fallback take over instead of a boot failure.
      return null;
    }
  }

  private async readAll(): Promise<Map<string, { value: string; isSecret: boolean }>> {
    const { rows } = await this.db.query<{ key: string; value: string; is_secret: boolean }>(
      'SELECT key, value, is_secret FROM settings',
    );
    return new Map(rows.map((r) => [r.key, { value: r.value, isSecret: r.is_secret }]));
  }

  private plain(
    all: Map<string, { value: string; isSecret: boolean }>,
    key: string,
  ): string | null {
    const row = all.get(key);
    if (!row) return null;
    return row.isSecret ? this.decrypt(row.value) : row.value;
  }

  /**
   * The effective AI configuration.
   *
   * Settings win over the environment, so changing the key on the admin page takes effect
   * without a redeploy; the environment still works for a fresh install that has no admin yet.
   */
  async effective(env: { anthropicKey?: string; openaiKey?: string; model?: string }): Promise<AiSettings> {
    const all = await this.readAll();

    const storedAnthropic = this.plain(all, SETTING_KEYS.anthropicKey);
    const storedOpenai = this.plain(all, SETTING_KEYS.openaiKey);
    const anthropicKey = storedAnthropic ?? env.anthropicKey ?? null;
    const openaiKey = storedOpenai ?? env.openaiKey ?? null;

    const provider = (this.plain(all, SETTING_KEYS.provider) as ProviderId | null) ?? 'anthropic';
    const model = this.plain(all, SETTING_KEYS.model) ?? env.model ?? defaultModelFor(provider);

    // A subscription provider has no key of its own: its credential is the local CLI login,
    // and whether that exists is a question for the credential reader, not for this table.
    if (isSubscription(provider)) {
      return {
        provider,
        model,
        apiKey: null,
        keySource: 'subscription',
        // Resolved by the caller, which is the only place that can read a keychain. Reported
        // as not-ready here so a caller that forgets to overlay it fails closed.
        ready: false,
        anthropicKeyHint: anthropicKey ? maskKey(anthropicKey) : null,
        openaiKeyHint: openaiKey ? maskKey(openaiKey) : null,
      };
    }

    const apiKey = wireOf(provider) === 'openai' ? openaiKey : anthropicKey;
    const stored = wireOf(provider) === 'openai' ? storedOpenai : storedAnthropic;

    return {
      provider,
      model,
      apiKey,
      keySource: stored ? 'settings' : apiKey ? 'environment' : 'none',
      ready: apiKey !== null,
      anthropicKeyHint: anthropicKey ? maskKey(anthropicKey) : null,
      openaiKeyHint: openaiKey ? maskKey(openaiKey) : null,
    };
  }

  async put(key: string, value: string, isSecret: boolean, updatedBy: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO settings (key, value, is_secret, updated_at, updated_by)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             is_secret = EXCLUDED.is_secret,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by`,
      [key, isSecret ? this.encrypt(value) : value, isSecret, updatedBy],
    );
  }

  async clear(key: string): Promise<void> {
    await this.db.query('DELETE FROM settings WHERE key = $1', [key]);
  }
}
