/**
 * The `claude_oauth` table, as an `ai-auth` credential store.
 *
 * The library ships a Postgres adapter of its own, and this deliberately does not use it. That
 * one owns its schema — a `key`/`payload`/`meta` table it expects to have created — and this
 * deployment already has rows in a table of its own shape, holding credentials real people
 * connected. Adopting the library's schema would mean a data migration whose failure mode is
 * silently signing everybody out of a subscription they have to go and reconnect.
 *
 * So the adapter goes the other way: the table stays exactly as it is, and forty lines map it
 * onto the interface. Which is the argument for the interface. The library asks for three
 * methods and does not care what is behind them, so "keep the schema you have" costs one small
 * file instead of a migration.
 *
 * The same reasoning covers the encryption. The store is constructed with the label the old
 * code derived its key from — `craftmagic-claude-oauth` — because the label is part of the
 * key, and changing it would make every stored credential unreadable.
 */

import type { CredentialStore, StoredRecord } from '@flyvendedk799/ai-auth';
import type { Db } from '../../db/pool.js';

/** Matches what `ClaudeAccountStore` puts in `meta`, which is what this has to map to columns. */
interface ClaudeMeta {
  plan: string | null;
  expiresAt: number;
}

export class ClaudeOauthTableStore implements CredentialStore {
  constructor(private readonly db: Db) {}

  /**
   * The library prefixes its keys (`claude:<id>`); the column holds a bare user id.
   *
   * Stripping rather than widening the column: the prefix exists so that several kinds of
   * credential can share one table, and this table only ever holds one kind.
   */
  private userId(key: string): string {
    return key.startsWith('claude:') ? key.slice('claude:'.length) : key;
  }

  async read(key: string): Promise<StoredRecord | null> {
    const { rows } = await this.db.query<{ payload: string; plan: string | null; expires_at: string }>(
      'SELECT payload, plan, expires_at FROM claude_oauth WHERE user_id = $1',
      [this.userId(key)],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      payload: row.payload,
      meta: { plan: row.plan, expiresAt: Number(row.expires_at) } satisfies ClaudeMeta,
    };
  }

  async write(key: string, record: StoredRecord): Promise<void> {
    const meta = record.meta as unknown as ClaudeMeta;
    await this.db.query(
      `INSERT INTO claude_oauth (user_id, payload, plan, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE
         SET payload = EXCLUDED.payload,
             plan = EXCLUDED.plan,
             expires_at = EXCLUDED.expires_at,
             updated_at = now()`,
      [this.userId(key), record.payload, meta.plan ?? null, Math.round(Number(meta.expiresAt) || 0)],
    );
  }

  async delete(key: string): Promise<void> {
    await this.db.query('DELETE FROM claude_oauth WHERE user_id = $1', [this.userId(key)]);
  }
}

/**
 * The label the credentials in this table were encrypted under.
 *
 * Not a preference. `SecretBox` derives its key as `sha256(label + ':' + secret)`, so this
 * string is half of the key to every row that already exists. Changing it does not fail — it
 * decrypts to nothing, every connected account reads as disconnected, and the only clue is
 * that people have to sign in again for no stated reason.
 */
export const CLAUDE_SECRET_LABEL = 'craftmagic-claude-oauth';
