import { createHash, randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeTestDb, openTestDb } from '../testing/harness.js';
import { hashPassword } from './password.js';
import { AuthStore } from './store.js';

const db = await openTestDb();
const withDb = db ? describe : describe.skip;

afterAll(async () => {
	if (db) await closeTestDb();
});

/** A fresh account per test, so nothing depends on the order they run in. */
async function newUser(store: AuthStore) {
	const email = `session-test-${Date.now()}-${randomBytes(4).toString('hex')}@example.test`;
	const user = await store.createUser(email, await hashPassword('a-perfectly-fine-password'));
	if (!user) throw new Error('could not create a test user');
	return user;
}

withDb('AuthStore sessions', () => {
	it('resolves a valid token to its user', async () => {
		const store = new AuthStore(db!);
		const user = await newUser(store);

		const session = await store.createSession(user.id, 'vitest');
		const found = await store.userBySessionToken(session.token);

		expect(found?.id).toBe(user.id);
		expect(found?.email).toBe(user.email);
		expect(found?.dailyGenQuota).toBe(30);
	});

	it('stores only a SHA-256 of the token, never the token', async () => {
		const store = new AuthStore(db!);
		const user = await newUser(store);
		const session = await store.createSession(user.id, 'vitest');

		const { rows } = await db!.query<{ token_hash: Buffer }>(
			'SELECT token_hash FROM sessions WHERE user_id = $1',
			[user.id],
		);
		const stored = rows[0]!.token_hash;

		expect(stored).toEqual(createHash('sha256').update(session.token).digest());
		expect(stored.length).toBe(32);
		// The digest of a base64url token could not contain it, but assert it anyway: this is
		// the property that makes a leaked database a list of hashes rather than a drawer of
		// working cookies, and it is worth failing loudly if the column ever changes meaning.
		expect(stored.toString('utf8')).not.toContain(session.token);
		expect(stored.toString('base64url')).not.toContain(session.token);

		// And the plaintext appears nowhere else in the row either.
		const whole = await db!.query('SELECT * FROM sessions WHERE user_id = $1', [user.id]);
		expect(JSON.stringify(whole.rows)).not.toContain(session.token);
	});

	it('rejects an unknown token', async () => {
		const store = new AuthStore(db!);
		expect(await store.userBySessionToken(randomBytes(32).toString('base64url'))).toBeNull();
	});

	it('rejects a tampered token', async () => {
		const store = new AuthStore(db!);
		const user = await newUser(store);
		const session = await store.createSession(user.id, 'vitest');

		// One character changed. Lookup is by digest, so this cannot near-miss.
		const tampered = `${session.token.slice(0, -1)}${session.token.endsWith('A') ? 'B' : 'A'}`;
		expect(tampered).not.toBe(session.token);
		expect(await store.userBySessionToken(tampered)).toBeNull();

		// The real one still works, so the test proves rejection rather than a broken session.
		expect((await store.userBySessionToken(session.token))?.id).toBe(user.id);
	});

	it('rejects an expired session even though the row is still there', async () => {
		const store = new AuthStore(db!);
		const user = await newUser(store);

		const token = randomBytes(32).toString('base64url');
		await db!.query(
			`INSERT INTO sessions (user_id, token_hash, expires_at)
			 VALUES ($1, $2, now() - interval '1 second')`,
			[user.id, createHash('sha256').update(token).digest()],
		);

		expect(await store.userBySessionToken(token)).toBeNull();

		// Expiry is enforced in the WHERE clause, not by the sweep — so the row being present
		// is the point, not an oversight. If this row were missing the test would prove nothing.
		const present = await db!.query('SELECT 1 FROM sessions WHERE user_id = $1', [user.id]);
		expect(present.rowCount).toBe(1);
	});

	it('expires 30 days out', async () => {
		const store = new AuthStore(db!);
		const user = await newUser(store);
		const session = await store.createSession(user.id, 'vitest');

		const days = (session.expiresAt.getTime() - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(29.9);
		expect(days).toBeLessThan(30.1);
	});

	it('deletes one session without touching the others', async () => {
		const store = new AuthStore(db!);
		const user = await newUser(store);
		const first = await store.createSession(user.id, 'browser one');
		const second = await store.createSession(user.id, 'browser two');

		await store.deleteSession(first.token);

		expect(await store.userBySessionToken(first.token)).toBeNull();
		// Signing out of one browser must not sign you out of the others.
		expect((await store.userBySessionToken(second.token))?.id).toBe(user.id);
	});

	it('sweeps expired rows and leaves live ones', async () => {
		const store = new AuthStore(db!);
		const user = await newUser(store);
		const live = await store.createSession(user.id, 'vitest');
		await db!.query(
			`INSERT INTO sessions (user_id, token_hash, expires_at)
			 VALUES ($1, $2, now() - interval '1 day')`,
			[user.id, createHash('sha256').update(randomBytes(32).toString('base64url')).digest()],
		);

		expect(await store.sweepExpiredSessions()).toBeGreaterThanOrEqual(1);

		const remaining = await db!.query('SELECT 1 FROM sessions WHERE user_id = $1', [user.id]);
		expect(remaining.rowCount).toBe(1);
		expect((await store.userBySessionToken(live.token))?.id).toBe(user.id);
	});

	it('refuses a duplicate email rather than creating a second account', async () => {
		const store = new AuthStore(db!);
		const user = await newUser(store);
		const again = await store.createUser(user.email, await hashPassword('a-different-password'));
		expect(again).toBeNull();
	});

	it('treats email as case-insensitive, because people do', async () => {
		const store = new AuthStore(db!);
		const user = await newUser(store);
		const found = await store.userByEmail(user.email.toUpperCase());
		expect(found?.id).toBe(user.id);
	});
});
