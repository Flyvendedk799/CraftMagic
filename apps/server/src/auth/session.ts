/**
 * Session cookies, the request → user lookup, and the cross-site guard.
 *
 * This is a plain object handed to the route plugins rather than a Fastify decorator on
 * purpose. `decorateRequest` respects plugin encapsulation, so a decorator registered inside
 * one plugin is invisible to the next one — which fails at runtime, on the route that needed
 * it, rather than at build time. Passing the helper explicitly in the options object matches
 * how `store`, `hub` and `ledger` are already wired, and TypeScript checks it.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthStore, UserRow } from './store.js';
import { SESSION_TTL_DAYS } from './store.js';

export const SESSION_COOKIE = 'cm_session';

/**
 * The owner a query is scoped to.
 *
 * Nullable only because rows written before accounts existed have a null `user_id`, and the
 * `builds` scoping predicate still has to be able to express that. **No route hands a null
 * here.** Every request that touches owned data now resolves to a real user id — an anonymous
 * scope would be a single shared pool that every signed-out visitor to a public deployment
 * lands in, which is how a stranger ends up looking at somebody else's paired Minecraft world.
 */
export type OwnerScope = string | null;

export interface Auth {
	/** The signed-in user, or null. Never throws; an unreachable database is "signed out". */
	currentUser(request: FastifyRequest): Promise<UserRow | null>;
	/** The signed-in user, or null having already sent a 401. */
	requireUser(request: FastifyRequest, reply: FastifyReply): Promise<UserRow | null>;
	setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string): void;
	clearSessionCookie(reply: FastifyReply): void;
	tokenOf(request: FastifyRequest): string | null;
}

/**
 * A request is https if its own socket is, or if a terminating proxy says so.
 *
 * `x-forwarded-proto` is trusted here without `trustProxy` because of what it can do: it can
 * only ever *add* the `Secure` attribute. A forged header makes the attacker's own cookie
 * refuse to travel over http — it can never strip `Secure` from a genuinely https request,
 * because that path does not consult the header at all.
 */
function isSecureRequest(request: FastifyRequest): boolean {
	if (request.protocol === 'https') return true;
	const forwarded = request.headers['x-forwarded-proto'];
	const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
	return typeof first === 'string' && first.split(',')[0]?.trim() === 'https';
}

export function createAuth(store: AuthStore | null): Auth {
	/**
	 * The user is resolved at most once per request.
	 *
	 * Ownership is checked on nearly every route, several of which look it up more than once
	 * (a job verifies both a build and an agent). Without this, one request would be several
	 * identical session queries.
	 */
	const cache = new WeakMap<FastifyRequest, UserRow | null>();

	function tokenOf(request: FastifyRequest): string | null {
		const raw = request.cookies?.[SESSION_COOKIE];
		return typeof raw === 'string' && raw.length > 0 ? raw : null;
	}

	async function currentUser(request: FastifyRequest): Promise<UserRow | null> {
		const cached = cache.get(request);
		if (cached !== undefined) return cached;

		let user: UserRow | null = null;
		const token = tokenOf(request);
		if (store && token) user = await store.userBySessionToken(token);

		cache.set(request, user);
		return user;
	}

	return {
		currentUser,
		tokenOf,

		async requireUser(request, reply) {
			const user = await currentUser(request);
			if (user) return user;
			await reply.code(401).send({ error: 'unauthorized', message: 'sign in to do that' });
			return null;
		},

		setSessionCookie(request, reply, token) {
			reply.setCookie(SESSION_COOKIE, token, {
				httpOnly: true,
				sameSite: 'lax',
				path: '/',
				// Omitted rather than false on plain http: a `Secure` cookie is simply dropped by
				// the browser, which would make local development look like a broken login.
				secure: isSecureRequest(request),
				maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
			});
		},

		clearSessionCookie(reply) {
			// Path must match the one it was set with or the browser keeps the original cookie.
			reply.clearCookie(SESSION_COOKIE, { path: '/' });
		},
	};
}
