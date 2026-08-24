import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { originGuard } from './origin.js';

const PUBLIC_ORIGIN = 'https://craftmagic.example';

/** Just enough of a request for the guard, which only reads a method and two headers. */
function request(method: string, headers: Record<string, string>): FastifyRequest {
	return { method, headers } as unknown as FastifyRequest;
}

function reply(): FastifyReply & { statusCode: number | null; payload: Record<string, unknown> | null } {
	const captured = {
		statusCode: null as number | null,
		payload: null as Record<string, unknown> | null,
		code(status: number) {
			captured.statusCode = status;
			return captured;
		},
		async send(body: Record<string, unknown>) {
			captured.payload = body;
			return captured;
		},
	};
	return captured as unknown as FastifyReply & { statusCode: number | null; payload: Record<string, unknown> | null };
}

async function run(
	method: string,
	headers: Record<string, string>,
	isProduction = true,
): Promise<number | null> {
	const guarded = reply();
	await originGuard({ publicOrigin: PUBLIC_ORIGIN, isProduction })(request(method, headers), guarded);
	return guarded.statusCode;
}

describe('originGuard', () => {
	it('refuses a mutation from a foreign origin', async () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			expect(
				await run(method, { origin: 'https://evil.example', host: 'craftmagic.example' }),
			).toBe(403);
		}
	});

	it('allows the configured public origin', async () => {
		expect(await run('POST', { origin: PUBLIC_ORIGIN, host: 'craftmagic.example' })).toBeNull();
	});

	it('allows the host the client actually addressed', async () => {
		// So a deployment reachable at a second hostname does not need PUBLIC_ORIGIN updated
		// before anyone can log in.
		expect(
			await run('POST', { origin: 'https://other.example', host: 'other.example' }),
		).toBeNull();
	});

	it('allows a request with no Origin at all', async () => {
		// The mod, the verification drivers and curl send none. Browsers — the only clients
		// that can be tricked into acting on someone else's behalf — always send one on a
		// cross-origin request and cannot forge it, so "absent" means "not a browser".
		expect(await run('POST', { host: 'craftmagic.example' })).toBeNull();
	});

	it('refuses the literal string "null", which a sandboxed frame sends', async () => {
		// `Origin: null` comes from a sandboxed iframe or a data: URL. Treating it as absent
		// would hand exactly those contexts a bypass.
		expect(await run('POST', { origin: 'null', host: 'craftmagic.example' })).toBe(403);
	});

	it('does not guard reads', async () => {
		// SameSite=Lax already withholds the cookie on a cross-site read, and guarding GET
		// would break the mod's schematic fetch for no gain.
		expect(await run('GET', { origin: 'https://evil.example', host: 'craftmagic.example' })).toBeNull();
		expect(await run('HEAD', { origin: 'https://evil.example', host: 'craftmagic.example' })).toBeNull();
	});

	it('refuses a malformed Origin', async () => {
		expect(await run('POST', { origin: 'not a url', host: 'craftmagic.example' })).toBe(403);
	});

	it('accepts loopback on any port outside production, and not inside it', async () => {
		// The Vite dev server proxies /api from a configurable port, so dev cannot pin one.
		expect(await run('POST', { origin: 'http://localhost:5183', host: 'localhost:3016' }, false)).toBeNull();
		expect(await run('POST', { origin: 'http://127.0.0.1:9999', host: 'localhost:3016' }, false)).toBeNull();
		expect(await run('POST', { origin: 'http://localhost:5183', host: 'craftmagic.example' }, true)).toBe(403);
	});
});
