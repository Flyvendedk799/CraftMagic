/**
 * Cross-site request guard.
 *
 * `SameSite=Lax` stops a cross-site POST from carrying the session cookie in every browser
 * that honours it, but it is not the whole story: it does nothing for a browser that predates
 * it or has it disabled, and "Lax" deliberately still sends the cookie on top-level GET
 * navigations, which is why this only guards mutations.
 *
 * A **missing** `Origin` is allowed, and that is the load-bearing decision here. The mod, the
 * verification drivers and every curl invocation send no `Origin` at all; browsers, which are
 * the only clients that can be tricked into making a request on someone else's behalf, always
 * send one on a cross-origin request and cannot forge it. So "no Origin" means "not a
 * browser-driven cross-site request", and rejecting it would break the in-game feature to
 * defend against an attacker that does not exist.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface OriginGuardOptions {
	publicOrigin: string;
	/**
	 * Loopback origins on any port are accepted outside production, because the Vite dev
	 * server proxies `/api` from :5183 and its port is configurable. In production the only
	 * accepted origins are the configured one and the host actually asked for.
	 */
	isProduction: boolean;
}

export function originGuard(options: OriginGuardOptions) {
	return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
		if (!MUTATING.has(request.method)) return;

		const origin = request.headers.origin;
		// Absent is allowed; the literal string "null" is not. They look similar and mean
		// opposite things: absent is a non-browser client, whereas `Origin: null` is what a
		// browser sends from an *opaque* origin — a sandboxed iframe, a `data:` URL, a
		// cross-origin redirect chain. Those are browser contexts an attacker can create, so
		// folding them in with "no Origin" would hand a bypass to exactly the callers this
		// guard exists for. Nothing legitimate here ever has one: the mod sends no header at
		// all, and the site's own pages send their real origin.
		if (typeof origin !== 'string') return;

		if (origin !== 'null' && isAllowed(origin, request, options)) return;

		// 403 rather than 400: the request is well-formed and the caller is simply not
		// permitted to make it from there.
		await reply.code(403).send({ error: 'bad_origin', message: 'cross-site request refused' });
	};
}

function isAllowed(origin: string, request: FastifyRequest, options: OriginGuardOptions): boolean {
	if (origin === options.publicOrigin) return true;

	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}

	// Same-origin as whatever host the client actually addressed, so a deployment behind a
	// second hostname does not need PUBLIC_ORIGIN updated before logins work.
	if (url.host === request.headers.host) return true;

	if (!options.isProduction && isLoopback(url.hostname)) return true;

	return false;
}

function isLoopback(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}
