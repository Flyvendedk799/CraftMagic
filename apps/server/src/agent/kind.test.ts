/**
 * What a saved build says it is, and what happens when it says something else.
 *
 * `kind` is the only thing separating a structure from an interior, and the difference is
 * load-bearing the moment a component shelf filters on it: without it the shelf offering
 * "things to place" offers rooms and furniture too. So the round trip is pinned in both
 * directions — what goes in comes back out, from the single read *and* from the listing,
 * because a shelf reads the listing and would otherwise have to download every set of voxels
 * in the library to learn what each one is.
 *
 * The 400 is the case worth writing a test for. A rejected save is a visible failure someone
 * fixes; a silently-coerced one answers 201, writes a healthy-looking row, and files the
 * build in the wrong drawer forever — the only symptom arrives months later as an interior
 * sitting in the structure shelf with nothing left to explain how it got there.
 *
 * Driven through `app.inject()` like the rest: the store's SQL is not where this goes wrong,
 * the route forgetting to pass the value through is.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expand, samples } from '@craftmagic/core';
import { buildTestApp, closeTestDb, openTestDb, type TestApp } from '../testing/harness.js';

const db = await openTestDb();
const withDb = db ? describe : describe.skip;

let harness: TestApp;
let user: { cookie: string; id: string; email: string };

/** A real expanded build, so the save exercises the voxel path rather than a stub. */
const { grid } = expand(samples.cottage!);
const gridBody = { size: grid.size, palette: grid.palette, voxels: Array.from(grid.voxels) };

beforeAll(async () => {
	if (!db) return;
	harness = await buildTestApp(db);
	user = await harness.signUp('kind');
});

afterAll(async () => {
	if (!db) return;
	await harness?.app.close();
	await closeTestDb();
});

/** Save into the library. `kind` omitted entirely when it is undefined, not sent as null. */
async function save(name: string, kind?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
	return harness.call('POST', '/api/builds', {
		cookie: user.cookie,
		body: {
			name,
			library: true,
			program: samples.cottage,
			grid: gridBody,
			...(kind === undefined ? {} : { kind }),
		},
	});
}

withDb('a build knows which tier it belongs to', () => {
	for (const kind of ['structure', 'interior'] as const) {
		it(`round-trips ${kind}`, async () => {
			const saved = await save(`Round Trip ${kind}`, kind);
			expect(saved.status).toBe(201);

			const read = await harness.call('GET', `/api/builds/${saved.body.id}`, { cookie: user.cookie });
			expect(read.status).toBe(200);
			expect(read.body.kind).toBe(kind);
		});
	}

	it('defaults to structure when the field is absent', async () => {
		// Absent means an older client that predates the field, and every build that existed
		// before it was a structure. Defaulting is correct here and only here.
		const saved = await save('No Kind Sent');
		expect(saved.status).toBe(201);

		const read = await harness.call('GET', `/api/builds/${saved.body.id}`, { cookie: user.cookie });
		expect(read.body.kind).toBe('structure');
	});

	it('carries the kind in the listing, not only on the full read', async () => {
		const structure = await save('Shelf Structure', 'structure');
		const interior = await save('Shelf Interior', 'interior');

		const list = await harness.call('GET', '/api/builds', { cookie: user.cookie });
		expect(list.status).toBe(200);

		const byId = new Map(
			(list.body.builds as { id: string; kind: string }[]).map((b) => [b.id, b.kind]),
		);
		expect(byId.get(structure.body.id as string)).toBe('structure');
		expect(byId.get(interior.body.id as string)).toBe('interior');
	});
});

withDb('an unknown kind is refused rather than coerced', () => {
	it('400s on junk instead of quietly saving a structure', async () => {
		// Every one of these would be a 201 under a `?? 'structure'` default, and the row it
		// wrote would be indistinguishable from a real structure afterwards.
		for (const junk of ['world', 'World', 'STRUCTURE', '', 'interiors', 42, true, {}, []]) {
			const attempt = await save('Junk Kind', junk);
			expect(attempt.status, `kind=${JSON.stringify(junk)} was accepted`).toBe(400);
			expect(attempt.body.error).toBe('bad_kind');
		}
	});

	it('refuses "world" specifically, because a world is not a build', async () => {
		// A world has no voxels and `builds.voxels` is NOT NULL. If this ever starts passing,
		// the fix is a worlds table, not a third value in the CHECK constraint.
		const attempt = await save('A World', 'world');
		expect(attempt.status).toBe(400);
	});

	it('writes nothing when it rejects', async () => {
		const before = await harness.call('GET', '/api/builds', { cookie: user.cookie });
		await save('Rejected Row', 'nonsense');
		const after = await harness.call('GET', '/api/builds', { cookie: user.cookie });

		expect((after.body.builds as unknown[]).length).toBe((before.body.builds as unknown[]).length);
	});
});
