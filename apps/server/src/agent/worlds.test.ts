/**
 * A world survives the trip to Postgres and back, or it is refused on the way in.
 *
 * The heightfield is the whole reason this file exists. It is the one part of a world that
 * travels as bytes rather than as json, and binary transport has a signature failure: it
 * loses information without ever failing. The two shapes it takes here are the two that
 * actually happen.
 *
 * The first is sign. Minecraft y runs -64..320, so heights are `Int16Array` — and a
 * heightfield read back through a `Uint16Array`, or written with `setUint16`, is byte-for-byte
 * identical for every world whose ground is above sea level. A test on a fresh flat world
 * passes. A real one comes back with the seabed at 65,472 blocks. So the fixture below is
 * painted with negatives on purpose, including `minY - 1`, the value that means "no column
 * here at all".
 *
 * The second is length. `heights` is `size_x * size_z * 2` bytes and nothing in the blob says
 * so; a stride that disagrees with the extent beside it does not corrupt one column, it
 * shifts every column after the gap, and the map comes back sheared — which still looks like
 * terrain. That is why the route refuses rather than clamps, and why the refusal is pinned
 * here in both directions.
 *
 * Driven through `app.inject()` like `kind.test.ts`: the SQL is not where this goes wrong,
 * the route forgetting a length check is.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, worldToJSON, WORLD_LIMITS, type WorldDocJSON } from '@craftmagic/core';
import { buildTestApp, closeTestDb, openTestDb, type TestApp } from '../testing/harness.js';

const db = await openTestDb();
const withDb = db ? describe : describe.skip;

let harness: TestApp;
let user: { cookie: string; id: string; email: string };
let stranger: { cookie: string; id: string; email: string };

const SIZE = { x: 24, z: 16 };
const MIN_Y = -64;
const MAX_Y = 192;

/**
 * Heights spanning everything a column is allowed to be.
 *
 * `-65` is `minY - 1`: an empty column, the void showing through. `-64` is the floor, `192`
 * the ceiling, and the rest are ordinary ground. Every one of the negatives is a value an
 * unsigned round trip turns into a five-digit number.
 */
const HEIGHTS = [-65, -64, -63, -32, -1, 0, 1, 62, 63, 128, 191, 192];

/** `raise` shifts every column, so two payloads can differ without changing anything else. */
function paint(name: string, raise = 0): WorldDocJSON & { name: string } {
	const doc = createWorld({ size: SIZE, minY: MIN_Y, maxY: MAX_Y, seaLevel: 62 });
	for (let i = 0; i < doc.terrain.height.length; i++) {
		doc.terrain.height[i] = HEIGHTS[i % HEIGHTS.length]! + raise;
		doc.terrain.strata[i] = i % doc.settings.strata.length;
	}
	return { ...worldToJSON(doc), name };
}

/** Int16 little-endian out of the base64 the route sends, the way a browser would read it. */
function readHeights(base64: string): Int16Array {
	const bytes = Buffer.from(base64, 'base64');
	const out = new Int16Array(bytes.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2);
	return out;
}

async function save(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
	return harness.call('POST', '/api/worlds', { cookie: user.cookie, body });
}

beforeAll(async () => {
	if (!db) return;
	harness = await buildTestApp(db);
	user = await harness.signUp('worlds');
	stranger = await harness.signUp('worlds-stranger');
});

afterAll(async () => {
	if (!db) return;
	await harness?.app.close();
	await closeTestDb();
});

withDb('a heightfield comes back exactly as it went in', () => {
	it('keeps negative heights, byte for byte', async () => {
		const payload = paint('Sunken Valley');
		const saved = await save(payload);
		expect(saved.status).toBe(201);

		const read = await harness.call('GET', `/api/worlds/${saved.body.id}`, { cookie: user.cookie });
		expect(read.status).toBe(200);

		const terrain = read.body.terrain as { x: number; z: number; height: string; strata: string };
		// The base64 itself, so a re-encode that changes the bytes cannot pass by agreeing
		// with a decoder that has the same bug in it.
		expect(terrain.height).toBe(payload.terrain.height);
		expect(terrain.strata).toBe(payload.terrain.strata);

		const heights = readHeights(terrain.height);
		expect(heights.length).toBe(SIZE.x * SIZE.z);
		for (let i = 0; i < heights.length; i++) {
			expect(heights[i], `column ${i}`).toBe(HEIGHTS[i % HEIGHTS.length]);
		}
		// Named separately because this is the assertion an unsigned path fails on: every
		// other column above sea level survives a `Uint16Array` unharmed.
		expect(Math.min(...heights)).toBe(MIN_Y - 1);
	});

	it('keeps the settings, the palette and the placements beside it', async () => {
		const payload = paint('Furnished');
		payload.placements = [
			{
				id: 'place_1',
				buildId: 'a-build',
				x: 3,
				z: 4,
				y: 62,
				anchor: 'surface',
				turns: 1,
				name: 'Shop',
				w: 8,
				h: 6,
				d: 8,
			},
		];
		const saved = await save(payload);
		expect(saved.status).toBe(201);

		const read = await harness.call('GET', `/api/worlds/${saved.body.id}`, { cookie: user.cookie });
		const settings = read.body.settings as Record<string, unknown>;
		expect(settings.size).toEqual(SIZE);
		expect(settings.minY).toBe(MIN_Y);
		expect(settings.maxY).toBe(MAX_Y);
		expect(settings.seaLevel).toBe(62);
		expect(settings.regionSize).toBe(payload.settings.regionSize);
		expect(settings.strata).toEqual(payload.settings.strata);
		expect(read.body.placements).toEqual(payload.placements);
	});

	it('saves over the same row rather than minting a second world', async () => {
		const saved = await save(paint('Edited'));
		const before = await harness.call('GET', '/api/worlds', { cookie: user.cookie });

		const raised = paint('Edited', 5);
		expect(raised.terrain.height).not.toBe(paint('Edited').terrain.height);

		const patch = await harness.call('PATCH', `/api/worlds/${saved.body.id}`, {
			cookie: user.cookie,
			body: { ...raised, name: 'Edited Twice' },
		});
		expect(patch.status).toBe(200);

		const after = await harness.call('GET', '/api/worlds', { cookie: user.cookie });
		expect((after.body.worlds as unknown[]).length).toBe((before.body.worlds as unknown[]).length);

		const read = await harness.call('GET', `/api/worlds/${saved.body.id}`, { cookie: user.cookie });
		expect(read.body.name).toBe('Edited Twice');
		expect((read.body.terrain as { height: string }).height).toBe(raised.terrain.height);
	});
});

withDb('a blob that disagrees with its stated size is refused', () => {
	/** Re-encode a heightfield of a different length than the settings claim. */
	function heightsOf(columns: number): string {
		const bytes = Buffer.alloc(columns * 2);
		for (let i = 0; i < columns; i++) bytes.writeInt16LE(-64, i * 2);
		return bytes.toString('base64');
	}

	function strataOf(columns: number): string {
		return Buffer.alloc(columns).toString('base64');
	}

	const columns = SIZE.x * SIZE.z;

	it('400s when the heights blob is short', async () => {
		const payload = paint('Short Heights');
		payload.terrain.height = heightsOf(columns - 1);

		const attempt = await save(payload);
		expect(attempt.status).toBe(400);
		expect(attempt.body.error).toBe('bad_terrain');
	});

	it('400s when the heights blob is long', async () => {
		const payload = paint('Long Heights');
		payload.terrain.height = heightsOf(columns + 1);

		const attempt = await save(payload);
		expect(attempt.status).toBe(400);
		expect(attempt.body.error).toBe('bad_terrain');
	});

	it('400s when the strata blob does not match column for column', async () => {
		const payload = paint('Short Strata');
		payload.terrain.strata = strataOf(columns - 5);

		const attempt = await save(payload);
		expect(attempt.status).toBe(400);
		expect(attempt.body.error).toBe('bad_terrain');
	});

	it('400s when the stride the arrays travelled with is not the world size', async () => {
		// The arrays are the right length; only the stride lies. Stored as-is this is the
		// shear — every row after the first offset by one column, and still terrain-shaped.
		const payload = paint('Wrong Stride');
		payload.terrain.x = SIZE.x - 1;
		payload.terrain.z = SIZE.z + 1;

		const attempt = await save(payload);
		expect(attempt.status).toBe(400);
		expect(attempt.body.error).toBe('bad_terrain');
	});

	it('400s on an extent outside WORLD_LIMITS', async () => {
		for (const size of [
			{ x: WORLD_LIMITS.maxSize + 1, z: 16 },
			{ x: 16, z: WORLD_LIMITS.minSize - 1 },
			{ x: 24.5, z: 16 },
		]) {
			const payload = paint('Impossible Size');
			payload.settings.size = size;
			payload.terrain.x = size.x;
			payload.terrain.z = size.z;

			const attempt = await save(payload);
			expect(attempt.status, `size=${JSON.stringify(size)} was accepted`).toBe(400);
			expect(attempt.body.error).toBe('bad_size');
		}
	});

	it('400s on a y range the game does not have', async () => {
		for (const bounds of [
			{ minY: -512, maxY: MAX_Y, seaLevel: 62 },
			{ minY: MIN_Y, maxY: 4096, seaLevel: 62 },
			{ minY: 100, maxY: 50, seaLevel: 62 },
			{ minY: MIN_Y, maxY: MAX_Y, seaLevel: MAX_Y + 1 },
		]) {
			const payload = paint('Impossible Bounds');
			Object.assign(payload.settings, bounds);

			const attempt = await save(payload);
			expect(attempt.status, `bounds=${JSON.stringify(bounds)} was accepted`).toBe(400);
			expect(attempt.body.error).toBe('bad_bounds');
		}
	});

	it('writes nothing when it rejects', async () => {
		const before = await harness.call('GET', '/api/worlds', { cookie: user.cookie });

		const payload = paint('Rejected Row');
		payload.terrain.strata = strataOf(1);
		await save(payload);

		const after = await harness.call('GET', '/api/worlds', { cookie: user.cookie });
		expect((after.body.worlds as unknown[]).length).toBe((before.body.worlds as unknown[]).length);
	});
});

withDb('a world belongs to exactly one account', () => {
	it('is invisible to everybody else, and not merely forbidden', async () => {
		const saved = await save(paint('Private Hub'));
		expect(saved.status).toBe(201);
		const id = saved.body.id as string;

		// 404, not 403: a 403 confirms the id names somebody's real world, which is the one
		// thing an id-guesser is trying to learn.
		const read = await harness.call('GET', `/api/worlds/${id}`, { cookie: stranger.cookie });
		expect(read.status).toBe(404);
		expect(read.body.error).toBe('unknown_world');

		const renamed = await harness.call('PATCH', `/api/worlds/${id}`, {
			cookie: stranger.cookie,
			body: { name: 'Mine Now' },
		});
		expect(renamed.status).toBe(404);

		const deleted = await harness.call('DELETE', `/api/worlds/${id}`, { cookie: stranger.cookie });
		expect(deleted.status).toBe(404);

		const list = await harness.call('GET', '/api/worlds', { cookie: stranger.cookie });
		expect((list.body.worlds as { id: string }[]).some((w) => w.id === id)).toBe(false);

		// The owner's copy is untouched by all three attempts, name included.
		const mine = await harness.call('GET', `/api/worlds/${id}`, { cookie: user.cookie });
		expect(mine.status).toBe(200);
		expect(mine.body.name).toBe('Private Hub');
	});

	it('needs an account at all', async () => {
		const anonymous = await harness.call('GET', '/api/worlds');
		expect(anonymous.status).toBe(401);
	});
});

withDb('the listing leaves the heightfield behind', () => {
	it('carries the size and the placement count, and none of the bytes', async () => {
		const payload = paint('Listed');
		payload.placements = [
			{
				id: 'place_1',
				buildId: 'a-build',
				x: 1,
				z: 1,
				y: 62,
				anchor: 'surface',
				turns: 0,
				name: 'Hut',
				w: 4,
				h: 4,
				d: 4,
			},
		];
		const saved = await save(payload);

		const list = await harness.call('GET', '/api/worlds', { cookie: user.cookie });
		expect(list.status).toBe(200);

		const row = (list.body.worlds as Record<string, unknown>[]).find((w) => w.id === saved.body.id);
		expect(row).toBeDefined();
		expect(row!.sizeX).toBe(SIZE.x);
		expect(row!.sizeZ).toBe(SIZE.z);
		expect(row!.placements).toBe(1);

		// A 1024² world is 3 MB of heightfield whether or not anybody has touched it, so a
		// listing that carried it would send megabytes per row to draw a name and a size.
		for (const key of ['terrain', 'heights', 'height', 'strata', 'overlay', 'doc']) {
			expect(row, `listing carried ${key}`).not.toHaveProperty(key);
		}
	});
});
