/**
 * The per-account credential store.
 *
 * One behaviour here is worth more than the rest and is why this file exists: a burst of
 * concurrent generations must trigger exactly one token exchange. The providers rotate the
 * refresh token on exchange, so a second refresh racing the first is handed a token that has
 * already been spent — and the user is logged out an hour later, on a schedule nobody can
 * reproduce and with nothing in the logs tying it to the three requests that caused it.
 *
 * The database is faked rather than mocked per-call: the store's own SQL is the thing under
 * test as much as its control flow, and a fake that actually stores rows catches a write that
 * never lands.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/pool.js';
import { ClaudeAccountStore } from './accountStore.js';
import { ClaudeCodeAuthError } from './claudeCode.js';

const HOUR = 3_600_000;
const SECRET = 'a-session-secret-with-real-entropy';

interface Row {
  payload: string;
  plan: string | null;
  expires_at: string;
}

/** Just enough Postgres for the three statements this store runs. */
function fakeDb(): Db & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  const db = {
    rows,
    async query(text: string, values: unknown[] = []) {
      const userId = String(values[0]);
      if (text.includes('SELECT')) {
        const row = rows.get(userId);
        return { rows: row ? [row] : [] };
      }
      if (text.includes('INSERT')) {
        rows.set(userId, {
          payload: String(values[1]),
          plan: values[2] === null ? null : String(values[2]),
          expires_at: String(values[3]),
        });
        return { rows: [] };
      }
      if (text.includes('DELETE')) {
        rows.delete(userId);
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  return db as unknown as Db & { rows: Map<string, Row> };
}

function tokenResponse(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const identity = (over: Partial<Parameters<ClaudeAccountStore['save']>[1]> = {}) => ({
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + HOUR,
  scopes: ['user:inference'],
  subscriptionType: 'max' as string | null,
  ...over,
});

describe('ClaudeAccountStore', () => {
  it('saves a credential without writing the token in the clear', async () => {
    const db = fakeDb();
    const store = new ClaudeAccountStore(db, SECRET);
    await store.save('u1', identity());

    const row = db.rows.get('u1')!;
    expect(row.payload).not.toContain('access-1');
    expect(row.payload).not.toContain('refresh-1');
    // The plan and the expiry are deliberately outside the sealed blob, so a status page
    // costs no decryption.
    expect(row.plan).toBe('max');
  });

  it('reports a connection, and says "expired" rather than showing a green light', async () => {
    const now = Date.now();
    const store = new ClaudeAccountStore(fakeDb(), SECRET);

    await store.save('u1', identity({ expiresAt: now + HOUR }));
    expect(await store.status('u1', now)).toMatchObject({ connected: true, plan: 'max', expired: false });

    await store.save('u1', identity({ expiresAt: now - 1 }));
    expect(await store.status('u1', now)).toMatchObject({ connected: true, expired: true });
  });

  it('hands back the stored token while it is live, without touching the network', async () => {
    const now = Date.now();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const store = new ClaudeAccountStore(fakeDb(), SECRET);
      await store.save('u1', identity({ expiresAt: now + HOUR }));

      expect(await store.token('u1', () => now)).toBe('access-1');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('refreshes an expired token and writes the rotated refresh token back', async () => {
    const now = Date.now();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }),
      );
    try {
      const db = fakeDb();
      const store = new ClaudeAccountStore(db, SECRET);
      await store.save('u1', identity({ expiresAt: now - 1 }));

      expect(await store.token('u1', () => now)).toBe('access-2');

      // A rotated refresh token that is not persisted works exactly once, and then logs the
      // user out an hour later for reasons nobody can reconstruct.
      const reread = new ClaudeAccountStore(db, SECRET);
      expect(await reread.status('u1', now)).toMatchObject({ expiresAt: now + HOUR, expired: false });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('runs one exchange for a burst of concurrent callers', async () => {
    const now = Date.now();
    let issued = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      issued++;
      return tokenResponse({
        access_token: `access-${issued + 1}`,
        refresh_token: `refresh-${issued + 1}`,
        expires_in: 3600,
      });
    });
    try {
      const store = new ClaudeAccountStore(fakeDb(), SECRET);
      await store.save('u1', identity({ expiresAt: now - 1 }));

      // Three generations fired from one page. Registering the in-flight promise after the
      // row read — which is the obvious way to write it — lets all three past the dedup check
      // while the map is still empty, and two of them end up presenting a token the third has
      // already rotated away.
      const tokens = await Promise.all([
        store.token('u1', () => now),
        store.token('u1', () => now),
        store.token('u1', () => now),
      ]);

      expect(issued).toBe(1);
      expect(tokens).toEqual(['access-2', 'access-2', 'access-2']);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('lets a later caller refresh again once the first has finished', async () => {
    let clock = Date.now();
    let issued = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      issued++;
      return tokenResponse({
        access_token: `access-${issued + 1}`,
        refresh_token: `refresh-${issued + 1}`,
        expires_in: 3600,
      });
    });
    try {
      const store = new ClaudeAccountStore(fakeDb(), SECRET);
      await store.save('u1', identity({ expiresAt: clock - 1 }));

      expect(await store.token('u1', () => clock)).toBe('access-2');
      // The dedup entry must be cleared on completion, or the account would be pinned to its
      // first refreshed token for the life of the process.
      clock += 2 * HOUR;
      expect(await store.token('u1', () => clock)).toBe('access-3');
      expect(issued).toBe(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('refuses with a reconnect error when nothing is stored', async () => {
    const store = new ClaudeAccountStore(fakeDb(), SECRET);
    await expect(store.token('nobody')).rejects.toBeInstanceOf(ClaudeCodeAuthError);
    expect(await store.status('nobody')).toMatchObject({ connected: false });
  });

  it('treats an unreadable credential as a reconnect, not as a crash', async () => {
    const db = fakeDb();
    await new ClaudeAccountStore(db, SECRET).save('u1', identity());

    // What a rotated SESSION_SECRET looks like from here.
    const rotated = new ClaudeAccountStore(db, 'a-different-session-secret');
    expect(await rotated.status('u1')).toMatchObject({ connected: false });
    await expect(rotated.token('u1')).rejects.toThrow(/could not be read/i);
  });

  it('forgets an account completely', async () => {
    const store = new ClaudeAccountStore(fakeDb(), SECRET);
    await store.save('u1', identity());
    await store.forget('u1');
    expect(await store.status('u1')).toMatchObject({ connected: false });
  });
});
