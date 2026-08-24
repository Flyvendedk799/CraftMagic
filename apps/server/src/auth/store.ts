/**
 * Database access for users and sessions.
 *
 * Same two properties as `agent/store.ts`, for the same reasons:
 *   * A session token is only ever stored as its SHA-256 digest. Lookup is by digest, so the
 *     plaintext exists exactly once — in the `Set-Cookie` that created it. A dumped database
 *     is then a list of hashes, not a drawer of working cookies.
 *   * Expiry is enforced in the WHERE clause, not by a sweep. The sweep exists to keep the
 *     table small; if it never ran, an expired session would still fail to authenticate.
 *
 * Passwords are argon2id, hashed in `routes.ts` rather than here — the hash parameters are a
 * policy decision, and this layer should not be the place someone has to look for them.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/pool.js';

export interface UserRow {
	id: string;
	email: string;
	dailyGenQuota: number;
	/** May change the AI provider and its key. The first account to register gets it. */
	isAdmin: boolean;
}

export interface CreatedSession {
	/** The only time this value exists in plaintext. Never log it. */
	token: string;
	expiresAt: Date;
}

/**
 * Long enough that signing in is a rare event, short enough that a stolen cookie is not a
 * permanent credential. Renewed on nothing: a sliding window would mean an attacker with a
 * live cookie never loses it.
 */
export const SESSION_TTL_DAYS = 30;

/** Postgres' unique-violation SQLSTATE — the only insert failure `register` treats as normal. */
const UNIQUE_VIOLATION = '23505';

function sha256(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

export class AuthStore {
	constructor(private readonly db: Db) {}

	/**
	 * Create an account, or return null when the email is already taken.
	 *
	 * The duplicate is detected by letting the unique index reject it rather than by a SELECT
	 * first: two simultaneous signups on the same address would both pass a pre-check.
	 */
	async createUser(email: string, passwordHash: string): Promise<UserRow | null> {
		try {
			// The first account to register becomes the admin. On a fresh install there is
			// nobody to grant it, and a bootstrap password in the environment is one more
			// secret that tends to stay at its default. Evaluated inside the INSERT so it
			// cannot disagree with the row being written.
			const { rows } = await this.db.query<{
				id: string;
				email: string;
				daily_gen_quota: number;
				is_admin: boolean;
			}>(
				`INSERT INTO users (email, password_hash, is_admin)
				 VALUES ($1, $2, NOT EXISTS (SELECT 1 FROM users))
				 RETURNING id, email, daily_gen_quota, is_admin`,
				[email, passwordHash],
			);
			const row = rows[0]!;
			return {
				id: row.id,
				email: row.email,
				dailyGenQuota: row.daily_gen_quota,
				isAdmin: row.is_admin,
			};
		} catch (err) {
			if ((err as { code?: string }).code === UNIQUE_VIOLATION) return null;
			throw err;
		}
	}

	/** The hash comes back with the user because login needs both and one round trip is enough. */
	async userByEmail(email: string): Promise<(UserRow & { passwordHash: string }) | null> {
		const { rows } = await this.db.query<{
			id: string;
			email: string;
			password_hash: string;
			daily_gen_quota: number;
			is_admin: boolean;
		}>(`SELECT id, email, password_hash, daily_gen_quota, is_admin FROM users WHERE email = $1`, [
			email,
		]);
		const row = rows[0];
		if (!row) return null;
		return {
			id: row.id,
			email: row.email,
			dailyGenQuota: row.daily_gen_quota,
			isAdmin: row.is_admin,
			passwordHash: row.password_hash,
		};
	}

	async createSession(userId: string, userAgent: string | null): Promise<CreatedSession> {
		// 32 bytes from the CSPRNG, base64url so it survives a cookie header unescaped. Same
		// size and encoding as an agent token; there is no reason for the two to differ.
		const token = randomBytes(32).toString('base64url');
		const { rows } = await this.db.query<{ expires_at: Date }>(
			`INSERT INTO sessions (user_id, token_hash, expires_at, user_agent)
			 VALUES ($1, $2, now() + ($3 || ' days')::interval, $4)
			 RETURNING expires_at`,
			[userId, sha256(token), String(SESSION_TTL_DAYS), userAgent?.slice(0, 200) ?? null],
		);
		return { token, expiresAt: rows[0]!.expires_at };
	}

	async userBySessionToken(token: string): Promise<UserRow | null> {
		const { rows } = await this.db.query<{
			id: string;
			email: string;
			daily_gen_quota: number;
			is_admin: boolean;
		}>(
			`SELECT u.id, u.email, u.daily_gen_quota, u.is_admin
			 FROM sessions s
			 JOIN users u ON u.id = s.user_id
			 WHERE s.token_hash = $1 AND s.expires_at > now()`,
			[sha256(token)],
		);
		const row = rows[0];
		if (!row) return null;
		return {
			id: row.id,
			email: row.email,
			dailyGenQuota: row.daily_gen_quota,
			isAdmin: row.is_admin,
		};
	}

	async deleteSession(token: string): Promise<void> {
		await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
	}

	/**
	 * Make sure a named account is an admin.
	 *
	 * `ADMIN_EMAIL` exists because "the first account to register" is only reliable when the
	 * first account really is the operator's. Here it was not: verification runs created
	 * throwaway accounts against the live database minutes before the real one, so a test
	 * account inherited the flag. Naming the address makes it deterministic regardless of the
	 * order accounts appear in, and it grants rather than revokes — an admin promoted through
	 * the database stays one.
	 *
	 * Returns true when it changed something, so boot can say so rather than acting silently.
	 */
	async ensureAdmin(email: string): Promise<boolean> {
		const { rowCount } = await this.db.query(
			'UPDATE users SET is_admin = true WHERE lower(email) = lower($1) AND NOT is_admin',
			[email],
		);
		return (rowCount ?? 0) > 0;
	}

	/** Housekeeping only — expiry is already enforced by `userBySessionToken`. */
	async sweepExpiredSessions(): Promise<number> {
		const { rowCount } = await this.db.query('DELETE FROM sessions WHERE expires_at < now()');
		return rowCount ?? 0;
	}
}
