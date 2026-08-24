/**
 * The difference between a multi-user app and a data leak.
 *
 * Every case here is "user A tries to touch user B's thing", plus "a signed-out stranger
 * tries to touch anything". Driven through `app.inject()` rather than against the store,
 * because the store is not where this goes wrong — a scoped query is useless if the route
 * forgot to pass the scope, and only a request catches that.
 *
 * The anonymous cases are not paperwork. An earlier draft of this feature let a signed-out
 * caller act in a shared "anonymous scope", which meant one visitor's paired Minecraft world
 * appeared in the next visitor's list and could be built in by them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expand, samples } from '@craftmagic/core';
import { buildTestApp, closeTestDb, openTestDb, TEST_ORIGIN, type TestApp } from '../testing/harness.js';

const db = await openTestDb();
const withDb = db ? describe : describe.skip;

let harness: TestApp;
let alice: { cookie: string; id: string; email: string };
let bob: { cookie: string; id: string; email: string };

/** A real expanded build, so the voxel round-trip is exercised rather than a stub. */
const { grid } = expand(samples.cottage!);
const gridBody = { size: grid.size, palette: grid.palette, voxels: Array.from(grid.voxels) };

beforeAll(async () => {
	if (!db) return;
	harness = await buildTestApp(db);
	alice = await harness.signUp('alice');
	bob = await harness.signUp('bob');
});

afterAll(async () => {
	if (!db) return;
	await harness?.app.close();
	await closeTestDb();
});

/** Save a build owned by whoever the cookie belongs to. */
async function saveBuild(cookie: string, name: string, library = true): Promise<string> {
	const saved = await harness.call('POST', '/api/builds', {
		cookie,
		body: { name, library, program: samples.cottage, grid: gridBody },
	});
	expect(saved.status).toBe(201);
	return saved.body.id as string;
}

/** Pair a world the way the site and the mod do together, and return its agent id. */
async function pairWorld(cookie: string): Promise<{ agentId: string; agentToken: string }> {
	const minted = await harness.call('POST', '/api/agent/pair-codes', { cookie });
	expect(minted.status).toBe(201);

	// No cookie: this is the mod's half, and it has none.
	const claimed = await harness.call('POST', '/api/agent/claim', {
		body: { code: minted.body.code, mcVersion: '26.2', modVersion: 'vitest', envType: 'integrated' },
	});
	expect(claimed.status).toBe(200);
	return { agentId: claimed.body.agentId as string, agentToken: claimed.body.agentToken as string };
}

withDb('ownership — builds', () => {
	it('lists only your own', async () => {
		const mine = await saveBuild(alice.cookie, 'Alice Cottage');
		await saveBuild(bob.cookie, 'Bob Cottage');

		const list = await harness.call('GET', '/api/builds', { cookie: alice.cookie });
		const ids = (list.body.builds as { id: string; name: string }[]).map((b) => b.id);

		expect(ids).toContain(mine);
		expect((list.body.builds as { name: string }[]).every((b) => b.name === 'Alice Cottage')).toBe(true);
	});

	it("404s rather than 403s on someone else's build", async () => {
		const bobs = await saveBuild(bob.cookie, "Bob's Private Build");

		for (const [method, body] of [
			['GET', undefined],
			['PATCH', { name: 'Mine Now' }],
			['DELETE', undefined],
		] as const) {
			const attempt = await harness.call(method, `/api/builds/${bobs}`, { cookie: alice.cookie, body });
			// 404, not 403: a 403 would confirm the id names a real build belonging to somebody.
			expect(attempt.status, `${method} leaked existence`).toBe(404);
		}

		// And none of the three actually did anything.
		const still = await harness.call('GET', `/api/builds/${bobs}`, { cookie: bob.cookie });
		expect(still.status).toBe(200);
		expect(still.body.name).toBe("Bob's Private Build");
	});

	it('lets the owner do all three', async () => {
		const mine = await saveBuild(alice.cookie, 'Alice Renameable');

		const renamed = await harness.call('PATCH', `/api/builds/${mine}`, {
			cookie: alice.cookie,
			body: { name: 'Renamed By Owner' },
		});
		expect(renamed.status).toBe(200);
		expect(renamed.body.name).toBe('Renamed By Owner');

		const read = await harness.call('GET', `/api/builds/${mine}`, { cookie: alice.cookie });
		expect(read.body.name).toBe('Renamed By Owner');
		expect((read.body.grid as { voxels: number[] }).voxels.length).toBe(
			grid.size.x * grid.size.y * grid.size.z,
		);

		expect((await harness.call('DELETE', `/api/builds/${mine}`, { cookie: alice.cookie })).status).toBe(200);
		expect((await harness.call('GET', `/api/builds/${mine}`, { cookie: alice.cookie })).status).toBe(404);
	});

	it('keeps send-to-game transport rows out of the library', async () => {
		// Every "Build here" click writes a row, because the mod fetches builds by id over
		// HTTPS. Those are transport, not saved work, and a library full of them is useless.
		const transport = await saveBuild(alice.cookie, 'Transport Row', false);
		const list = await harness.call('GET', '/api/builds', { cookie: alice.cookie });
		const ids = (list.body.builds as { id: string }[]).map((b) => b.id);
		expect(ids).not.toContain(transport);
	});
});

withDb('ownership — agents', () => {
	it("does not show one user another's paired worlds", async () => {
		const mine = await pairWorld(alice.cookie);
		const theirs = await pairWorld(bob.cookie);

		const list = await harness.call('GET', '/api/agent/agents', { cookie: alice.cookie });
		const ids = (list.body.agents as { id: string }[]).map((a) => a.id);

		expect(ids).toContain(mine.agentId);
		expect(ids).not.toContain(theirs.agentId);
	});

	it("404s on revoking someone else's world, and does not revoke it", async () => {
		const theirs = await pairWorld(bob.cookie);

		const attempt = await harness.call('DELETE', `/api/agent/agents/${theirs.agentId}`, {
			cookie: alice.cookie,
		});
		expect(attempt.status).toBe(404);

		const bobsList = await harness.call('GET', '/api/agent/agents', { cookie: bob.cookie });
		expect((bobsList.body.agents as { id: string }[]).map((a) => a.id)).toContain(theirs.agentId);
	});
});

withDb('ownership — jobs', () => {
	it("refuses to build your build in someone else's world", async () => {
		const theirs = await pairWorld(bob.cookie);
		const mine = await saveBuild(alice.cookie, 'Alice Build');

		// The case that matters most: this is a bot walking into a stranger's game.
		const attempt = await harness.call('POST', '/api/agent/jobs', {
			cookie: alice.cookie,
			body: { agentId: theirs.agentId, buildId: mine },
		});
		expect(attempt.status).toBe(404);
		expect(attempt.body.error).toBe('unknown_agent');
	});

	it("refuses to build someone else's build in your own world", async () => {
		const mine = await pairWorld(alice.cookie);
		const theirs = await saveBuild(bob.cookie, 'Bob Build');

		const attempt = await harness.call('POST', '/api/agent/jobs', {
			cookie: alice.cookie,
			body: { agentId: mine.agentId, buildId: theirs },
		});
		expect(attempt.status).toBe(404);
		expect(attempt.body.error).toBe('unknown_build');
	});

	it('allows your own build in your own world, and hides the job from everyone else', async () => {
		const mine = await pairWorld(alice.cookie);
		const build = await saveBuild(alice.cookie, 'Alice Buildable');

		const queued = await harness.call('POST', '/api/agent/jobs', {
			cookie: alice.cookie,
			body: { agentId: mine.agentId, buildId: build },
		});
		expect(queued.status).toBe(202);
		const jobId = queued.body.id as string;

		expect((await harness.call('GET', `/api/agent/jobs/${jobId}`, { cookie: alice.cookie })).status).toBe(200);
		expect((await harness.call('GET', `/api/agent/jobs/${jobId}`, { cookie: bob.cookie })).status).toBe(404);
		expect((await harness.call('POST', `/api/agent/jobs/${jobId}/cancel`, { cookie: bob.cookie })).status).toBe(404);
	});
});

withDb('the agent-token scheme is separate from the session scheme', () => {
	it('lets the mod fetch its own schematic with no cookie at all', async () => {
		const mine = await pairWorld(alice.cookie);
		const build = await saveBuild(alice.cookie, 'For The Mod');
		const queued = await harness.call('POST', '/api/agent/jobs', {
			cookie: alice.cookie,
			body: { agentId: mine.agentId, buildId: build },
		});
		const jobId = queued.body.id as string;

		// No cookie. A Minecraft server has none and never will, so a session check on this
		// route would kill send-to-game end to end.
		const fetched = await harness.app.inject({
			method: 'GET',
			url: `/api/agent/jobs/${jobId}/schem`,
			headers: { authorization: `Bearer ${mine.agentToken}` },
		});
		expect(fetched.statusCode).toBe(200);
		const bytes = fetched.rawPayload;
		expect(bytes[0]).toBe(0x1f);
		expect(bytes[1]).toBe(0x8b);
	});

	it('does not accept a session cookie in place of an agent token', async () => {
		const mine = await pairWorld(alice.cookie);
		const build = await saveBuild(alice.cookie, 'Cookie Is Not A Token');
		const queued = await harness.call('POST', '/api/agent/jobs', {
			cookie: alice.cookie,
			body: { agentId: mine.agentId, buildId: build },
		});

		// Otherwise any signed-in user could read any build by guessing a job id.
		const attempt = await harness.call('GET', `/api/agent/jobs/${queued.body.id}/schem`, {
			cookie: alice.cookie,
		});
		expect(attempt.status).toBe(401);
	});

	it("refuses another world's token on this job", async () => {
		const mine = await pairWorld(alice.cookie);
		const theirs = await pairWorld(bob.cookie);
		const build = await saveBuild(alice.cookie, 'Wrong World');
		const queued = await harness.call('POST', '/api/agent/jobs', {
			cookie: alice.cookie,
			body: { agentId: mine.agentId, buildId: build },
		});

		const attempt = await harness.app.inject({
			method: 'GET',
			url: `/api/agent/jobs/${queued.body.id}/schem`,
			headers: { authorization: `Bearer ${theirs.agentToken}` },
		});
		expect(attempt.statusCode).toBe(403);
	});
});

withDb('signed out', () => {
	it('cannot reach anything that owns state, spends money, or touches a game', async () => {
		const routes: [('GET' | 'POST' | 'PATCH' | 'DELETE'), string][] = [
			['GET', '/api/me'],
			['GET', '/api/builds'],
			['POST', '/api/builds'],
			['GET', '/api/builds/00000000-0000-0000-0000-000000000000'],
			['PATCH', '/api/builds/00000000-0000-0000-0000-000000000000'],
			['DELETE', '/api/builds/00000000-0000-0000-0000-000000000000'],
			['POST', '/api/agent/pair-codes'],
			['GET', '/api/agent/agents'],
			['DELETE', '/api/agent/agents/00000000-0000-0000-0000-000000000000'],
			['POST', '/api/agent/jobs'],
			['GET', '/api/agent/jobs/00000000-0000-0000-0000-000000000000'],
			['POST', '/api/agent/jobs/00000000-0000-0000-0000-000000000000/cancel'],
			['GET', '/api/agent/jobs/00000000-0000-0000-0000-000000000000/events'],
		];

		for (const [method, url] of routes) {
			const anonymous = await harness.call(method, url, { body: method === 'GET' ? undefined : {} });
			expect(anonymous.status, `${method} ${url} was reachable signed out`).toBe(401);
		}
	});

	it('can still claim a pair code, because that caller is the mod', async () => {
		const minted = await harness.call('POST', '/api/agent/pair-codes', { cookie: alice.cookie });
		const claimed = await harness.call('POST', '/api/agent/claim', {
			body: { code: minted.body.code, mcVersion: '26.2', modVersion: 'vitest', envType: 'dedicated' },
		});
		expect(claimed.status).toBe(200);
		expect(typeof claimed.body.agentToken).toBe('string');
	});

	it('gets an agent owned by whoever minted the code', async () => {
		// This is the whole mechanism by which a world becomes "yours" without the mod ever
		// knowing an account exists.
		const minted = await harness.call('POST', '/api/agent/pair-codes', { cookie: bob.cookie });
		const claimed = await harness.call('POST', '/api/agent/claim', {
			body: { code: minted.body.code, mcVersion: '26.2', modVersion: 'vitest', envType: 'dedicated' },
		});

		const owner = await db!.query<{ user_id: string | null }>('SELECT user_id FROM agents WHERE id = $1', [
			claimed.body.agentId,
		]);
		expect(owner.rows[0]?.user_id).toBe(bob.id);
	});
});

withDb('the cross-site guard, on real routes', () => {
	it('refuses a mutation carrying a foreign Origin even with a valid cookie', async () => {
		const attempt = await harness.call('POST', '/api/builds', {
			cookie: alice.cookie,
			headers: { origin: 'https://evil.example' },
			body: { name: 'Drive By', library: true, grid: gridBody },
		});
		expect(attempt.status).toBe(403);
		expect(attempt.body.error).toBe('bad_origin');
	});

	it('allows the same mutation from the real origin', async () => {
		const allowed = await harness.call('POST', '/api/builds', {
			cookie: alice.cookie,
			headers: { origin: TEST_ORIGIN },
			body: { name: 'Same Origin', library: true, grid: gridBody },
		});
		expect(allowed.status).toBe(201);
	});
});
