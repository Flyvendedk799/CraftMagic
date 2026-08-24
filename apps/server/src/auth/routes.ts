/**
 * Accounts.
 *
 *   POST /api/auth/register   email + password, signs you in
 *   POST /api/auth/login      same, against an existing account
 *   POST /api/auth/logout     invalidates this session server-side
 *   GET  /api/me              who am I, and what is left of today's quota
 *
 * ## Ownership policy
 *
 * The line is drawn at **server state, money, and anybody's game**:
 *
 *   * **Anonymous** — the editor, the sample builds, the `.schem` and program downloads and
 *     the printable guide. All of it runs in the browser, stores nothing, spends nothing and
 *     cannot reach a Minecraft world. Someone should be able to land on the site and play.
 *   * **Account required** — the library, pairing, agents, jobs, and both generation
 *     endpoints.
 *   * **Agent token, no session, ever** — `POST /api/agent/claim` and the schematic fetch.
 *     Those callers are a Minecraft server.
 *
 * An earlier draft let signed-out callers act in an "anonymous scope" that owned the rows
 * whose `user_id` is null. That is wrong on a public deployment for a reason worth writing
 * down, because it is not obvious and it is not recoverable: *every* signed-out visitor
 * resolves to the same scope. One person pairs their world while signed out; the next
 * stranger to open the site sees it in their list and can send a bot into their game. The
 * same reasoning applies to generation — an anonymous caller has no identity to meter, so the
 * per-user quota does not exist for them and one loop drains the month's balance.
 *
 * So ownership is a **gate as well as a filter**. `OwnerScope` stays nullable because rows
 * written before accounts existed still have a null owner and the `builds` predicate must be
 * able to express that, but no route ever passes one.
 *
 * Password hashing lives in `password.ts` — argon2id, and why.
 */

import type { FastifyPluginAsync } from 'fastify';
import {
	burnVerifyTime,
	hashPassword,
	isAcceptablePassword,
	MAX_PASSWORD,
	MIN_PASSWORD,
	verifyPassword,
} from './password.js';
import type { Auth } from './session.js';
import type { AuthStore } from './store.js';
import type { GenerationQuota } from '../generate/quota.js';

export interface AuthRoutesOptions {
	store: AuthStore | null;
	auth: Auth;
	quota: GenerationQuota | null;
}

const MAX_EMAIL = 254;

/**
 * Not a validator — nothing short of sending mail validates an address. It only rejects the
 * shapes that are certainly a typo, so the unique index is not filled with them.
 */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function authRoutes(options: AuthRoutesOptions): FastifyPluginAsync {
	return async (app) => {
		const { store, auth, quota } = options;

		function requireDb(reply: { code: (n: number) => { send: (b: unknown) => unknown } }): boolean {
			if (store) return true;
			reply.code(503).send({ error: 'no_database', message: 'this server has no database configured' });
			return false;
		}

		function readCredentials(
			body: unknown,
		): { email: string; password: string } | { error: string; message: string } {
			const input = body as { email?: unknown; password?: unknown } | null;

			const email = typeof input?.email === 'string' ? input.email.trim() : '';
			if (email.length === 0 || email.length > MAX_EMAIL || !EMAIL_SHAPE.test(email)) {
				return { error: 'bad_email', message: 'that does not look like an email address' };
			}

			const password = typeof input?.password === 'string' ? input.password : '';
			if (!isAcceptablePassword(password)) {
				return {
					error: 'bad_password',
					message: `password must be between ${MIN_PASSWORD} and ${MAX_PASSWORD} characters`,
				};
			}

			return { email, password };
		}

		async function me(userId: string, email: string, dailyGenQuota: number, isAdmin: boolean) {
			const used = quota ? await quota.usedToday(userId) : 0;
			return {
				user: {
					id: userId,
					email,
					dailyGenQuota,
					generationsUsedToday: used,
					generationsLeftToday: Math.max(0, dailyGenQuota - used),
					// Drives whether the UI offers the settings link at all. Not a security
					// boundary — every admin route checks the flag server-side.
					isAdmin,
				},
			};
		}

		app.post('/api/auth/register', async (request, reply) => {
			if (!requireDb(reply)) return;

			const credentials = readCredentials(request.body);
			if ('error' in credentials) return reply.code(400).send(credentials);

			const hash = await hashPassword(credentials.password);
			const user = await store!.createUser(credentials.email, hash);

			// 409 discloses that the address is registered. That is unavoidable in a signup form
			// without email verification — the alternative, "we've sent you a mail", is a lie
			// when no mail is sent. Login below does not leak the same fact.
			if (!user) {
				return reply.code(409).send({ error: 'email_taken', message: 'that email is already registered' });
			}

			const session = await store!.createSession(user.id, request.headers['user-agent'] ?? null);
			auth.setSessionCookie(request, reply, session.token);

			app.log.info({ userId: user.id }, 'account created');
			return reply.code(201).send(await me(user.id, user.email, user.dailyGenQuota, user.isAdmin));
		});

		app.post('/api/auth/login', async (request, reply) => {
			if (!requireDb(reply)) return;

			const credentials = readCredentials(request.body);
			// Deliberately the same answer as a wrong password: a 400 here would say "that
			// address is not one of ours" for anything malformed, and more usefully for the
			// attacker, would distinguish it from a rejected-but-well-formed guess.
			if ('error' in credentials) {
				return reply.code(401).send({ error: 'invalid_credentials', message: 'wrong email or password' });
			}

			const found = await store!.userByEmail(credentials.email);
			const ok = found
				? await verifyPassword(found.passwordHash, credentials.password)
				: await burnVerifyTime(credentials.password);

			if (!found || !ok) {
				return reply.code(401).send({ error: 'invalid_credentials', message: 'wrong email or password' });
			}

			const session = await store!.createSession(found.id, request.headers['user-agent'] ?? null);
			auth.setSessionCookie(request, reply, session.token);

			return me(found.id, found.email, found.dailyGenQuota, found.isAdmin);
		});

		app.post('/api/auth/logout', async (request, reply) => {
			// The cookie is cleared whatever happens, so a stale or unknown token still logs the
			// browser out rather than leaving it stuck holding something the server rejects.
			const token = auth.tokenOf(request);
			if (store && token) await store.deleteSession(token);
			auth.clearSessionCookie(reply);
			return { ok: true };
		});

		app.get('/api/me', async (request, reply) => {
			const user = await auth.requireUser(request, reply);
			if (!user) return;
			return me(user.id, user.email, user.dailyGenQuota, user.isAdmin);
		});
	};
}

