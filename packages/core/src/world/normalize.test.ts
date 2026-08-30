/**
 * Reading a world that came from somewhere else, and resizing one.
 *
 * Two contracts, both about not losing somebody's work.
 *
 * `normalizeWorld` must never throw. It is what stands between a corrupt autosave and a user
 * who cannot open their map, so the tests feed it nulls, strings, numbers, negative sizes and
 * placements from a version that does not exist, and assert a usable document comes out every
 * time.
 *
 * `resizeWorld` must never quietly drop the middle of the map. A resize control that loses
 * terrain is a data-loss button in a toolbar, and the user finds out after they have saved
 * over the good version — so the up/down/up round trip is asserted cell by cell rather than by
 * a length check that a freshly zeroed array would also pass.
 */

import { describe, expect, it } from 'vitest';
import { AIR_BLOCK } from '../ir/types.js';
import { OverlayEditor, overlayGet } from './overlay.js';
import {
	cloneWorld,
	createWorld,
	normalizeOverlay,
	normalizePlacement,
	normalizeSettings,
	normalizeWorld,
	resizeWorld,
	worldToJSON,
} from './normalize.js';
import { DEFAULT_STRATA } from './strata.js';
import { columnIndex } from './terrain.js';
import { WORLD_LIMITS, WORLD_VERSION, type WorldDoc } from './types.js';

describe('normalizeSettings', () => {
	it('fills in a whole settings object from nothing', () => {
		const settings = normalizeSettings(undefined);
		expect(settings.size).toEqual({ x: 512, z: 512 });
		// A shell under the surface rather than the game's bedrock — see `normalizeSettings`.
		// The full range is still reachable; it is the default that is a working depth.
		expect(settings.minY).toBe(32);
		expect(settings.maxY).toBe(192);
		expect(settings.seaLevel).toBe(62);
		expect(settings.regionSize).toBe(128);
		expect(settings.strata.map((profile) => profile.id)).toEqual(
			DEFAULT_STRATA.map((profile) => profile.id),
		);
	});

	it('clamps every number into a range the materialiser can survive', () => {
		const settings = normalizeSettings({
			size: { x: -5, z: 999_999 },
			minY: -9999,
			maxY: 9999,
			seaLevel: 500,
			regionSize: 4096,
		});

		expect(settings.size.x).toBe(WORLD_LIMITS.minSize);
		expect(settings.size.z).toBe(WORLD_LIMITS.maxSize);
		expect(settings.minY).toBe(WORLD_LIMITS.floorY);
		expect(settings.maxY).toBe(WORLD_LIMITS.ceilingY);
		expect(settings.seaLevel).toBeLessThanOrEqual(settings.maxY);
		// A region materialises into a grid, and a grid may not be wider than 256.
		expect(settings.regionSize).toBe(WORLD_LIMITS.maxRegionSize);
	});

	it('keeps maxY above minY however they arrive', () => {
		const settings = normalizeSettings({ minY: 100, maxY: 0 });
		expect(settings.maxY).toBeGreaterThan(settings.minY);
	});

	it('brings the default grounds back rather than leaving a world nothing can paint', () => {
		expect(normalizeSettings({ strata: [] }).strata).toHaveLength(DEFAULT_STRATA.length);
		expect(normalizeSettings({ strata: 'nope' }).strata).toHaveLength(DEFAULT_STRATA.length);
	});

	it('canonicalises a profile\'s blocks and defaults the ones it cannot read', () => {
		const settings = normalizeSettings({
			strata: [{ id: 'x', label: 'X', surface: 'minecraft:oak_stairs', subsurface: 42, filler: null }],
		});
		const profile = settings.strata[0]!;

		expect(profile.surface).toContain('minecraft:oak_stairs[');
		expect(profile.subsurface).toBe(DEFAULT_STRATA[0]!.subsurface);
		expect(profile.filler).toBe(DEFAULT_STRATA[0]!.filler);
		expect(profile.subsurfaceDepth).toBe(DEFAULT_STRATA[0]!.subsurfaceDepth);
	});
});

describe('normalizePlacement', () => {
	const settings = normalizeSettings({ size: { x: 64, z: 64 } });

	it('needs a build to point at, and nothing else', () => {
		expect(normalizePlacement(null, settings)).toBeNull();
		expect(normalizePlacement({}, settings)).toBeNull();
		expect(normalizePlacement({ buildId: '' }, settings)).toBeNull();

		const placement = normalizePlacement({ buildId: 'b1' }, settings)!;
		expect(placement.buildId).toBe('b1');
		expect(placement.anchor).toBe('surface');
		expect(placement.turns).toBe(0);
		expect(placement.name).toBe('Build');
	});

	it('pulls a placement back inside the fence rather than dropping it', () => {
		const placement = normalizePlacement({ buildId: 'b1', x: 9999, z: -50 }, settings)!;
		expect(placement.x).toBe(63);
		expect(placement.z).toBe(0);
	});

	it('refuses an anchor and a turn count it does not recognise', () => {
		const placement = normalizePlacement({ buildId: 'b1', anchor: 'floating', turns: 7 }, settings)!;
		expect(placement.anchor).toBe('surface');
		expect(placement.turns).toBe(3);
	});
});

describe('normalizeOverlay', () => {
	const settings = normalizeSettings({ size: { x: 32, z: 32 }, minY: 0, maxY: 64 });

	it('drops chunks no region will ever reach', () => {
		const inside = new OverlayEditor();
		inside.carve(1, 1, 1);
		const near = inside.commit();

		const overlay = normalizeOverlay(
			{ ...near, '99,0,0': near['0,0,0'], '0,99,0': near['0,0,0'], 'junk': near['0,0,0'] },
			settings,
		);

		expect(Object.keys(overlay)).toEqual(['0,0,0']);
	});

	it('survives junk without throwing', () => {
		expect(normalizeOverlay(null, settings)).toEqual({});
		expect(normalizeOverlay('nope', settings)).toEqual({});
		expect(normalizeOverlay({ '0,0,0': 5 }, settings)).toEqual({});
	});
});

describe('normalizeWorld', () => {
	it('builds a whole document out of nothing', () => {
		const world = normalizeWorld(undefined);
		expect(world.version).toBe(WORLD_VERSION);
		expect(world.name).toBe('Untitled world');
		expect(world.terrain.height).toHaveLength(world.settings.size.x * world.settings.size.z);
		expect(world.placements).toEqual([]);
	});

	it('never throws, whatever it is handed', () => {
		for (const junk of [null, 0, 'world', [], true, { version: 99, terrain: 'x', overlay: 7 }]) {
			expect(() => normalizeWorld(junk)).not.toThrow();
		}
	});

	it('costs one bad placement that placement and nothing else', () => {
		const world = normalizeWorld({
			settings: { size: { x: 32, z: 32 } },
			placements: [{ buildId: 'a' }, null, { nope: true }, { buildId: 'b' }],
		});
		expect(world.placements.map((placement) => placement.buildId)).toEqual(['a', 'b']);
	});

	it('pulls a height above the ceiling back into the world', () => {
		const world = normalizeWorld({
			settings: { size: { x: 16, z: 16 }, minY: 0, maxY: 40 },
			terrain: { x: 16, z: 16, height: [9999, -9999], strata: [200, 0] },
		});

		expect(world.terrain.height[0]).toBe(40);
		// One below the floor is the empty-column sentinel, and nothing may go lower.
		expect(world.terrain.height[1]).toBe(-1);
		// A stratum past the end of the list would resolve to the fallback on every materialise.
		expect(world.terrain.strata[0]).toBe(0);
	});

	it('round-trips a document through JSON', () => {
		const world = createWorld({ size: { x: 32, z: 32 }, minY: 0, maxY: 64, seaLevel: 10 });
		world.name = 'Hub';
		world.terrain.height[columnIndex(world.settings, 5, 7)] = 33;
		world.terrain.strata[columnIndex(world.settings, 5, 7)] = 2;
		const editor = new OverlayEditor();
		editor.carve(4, 4, 4);
		editor.set(5, 4, 4, 'minecraft:bricks');
		world.overlay = editor.commit();
		world.placements = [
			{ id: 'p', buildId: 'b', x: 2, z: 3, y: 0, anchor: 'fixed', turns: 2, name: 'Shop', w: 4, h: 5, d: 6 },
		];

		const back = normalizeWorld(JSON.parse(JSON.stringify(worldToJSON(world))));

		expect(back.name).toBe('Hub');
		expect(back.settings.size).toEqual({ x: 32, z: 32 });
		expect([...back.terrain.height]).toEqual([...world.terrain.height]);
		expect([...back.terrain.strata]).toEqual([...world.terrain.strata]);
		expect(overlayGet(back.overlay, 4, 4, 4)).toBe(AIR_BLOCK);
		expect(overlayGet(back.overlay, 5, 4, 4)).toBe('minecraft:bricks');
		expect(overlayGet(back.overlay, 6, 4, 4)).toBeNull();
		expect(back.placements[0]).toEqual(world.placements[0]);
	});
});

describe('createWorld', () => {
	it('is flat at sea level with nothing on it', () => {
		const world = createWorld({ size: { x: 16, z: 16 }, minY: 0, maxY: 64, seaLevel: 12 });
		expect(new Set(world.terrain.height)).toEqual(new Set([12]));
		expect(world.overlay).toEqual({});
		expect(world.placements).toEqual([]);
	});
});

describe('resizeWorld', () => {
	/** A 32x32 world with a recognisable mark in the corner that both sizes contain. */
	function marked(): WorldDoc {
		const world = createWorld({ size: { x: 32, z: 32 }, minY: 0, maxY: 64, seaLevel: 8 });
		// A ramp along the top row and one raised column well inside, so a shear along the
		// stride shows up as well as an outright wipe.
		for (let x = 0; x < 10; x++) world.terrain.height[columnIndex(world.settings, x, 0)] = 20 + x;
		world.terrain.height[columnIndex(world.settings, 3, 5)] = 40;
		world.terrain.strata[columnIndex(world.settings, 3, 5)] = 2;

		const editor = new OverlayEditor();
		editor.carve(4, 4, 4);
		world.overlay = editor.commit();
		world.placements = [
			{ id: 'p', buildId: 'b', x: 6, z: 6, y: 0, anchor: 'surface', turns: 0, name: 'Shop', w: 4, h: 4, d: 4 },
		];
		return world;
	}

	function inner(world: WorldDoc): { height: number; stratum: number; ramp: number[] } {
		return {
			height: world.terrain.height[columnIndex(world.settings, 3, 5)]!,
			stratum: world.terrain.strata[columnIndex(world.settings, 3, 5)]!,
			ramp: Array.from({ length: 10 }, (_, x) => world.terrain.height[columnIndex(world.settings, x, 0)]!),
		};
	}

	it('keeps the inner content through up, down and up again', () => {
		const start = marked();
		const expected = inner(start);

		const up = resizeWorld(start, { x: 64, z: 64 }).world;
		expect(inner(up)).toEqual(expected);
		expect(up.terrain.height).toHaveLength(64 * 64);
		// The ground that did not exist before is flat at sea level, not a hole at zero.
		expect(up.terrain.height[columnIndex(up.settings, 50, 50)]).toBe(8);

		const down = resizeWorld(up, { x: 32, z: 32 }).world;
		expect(inner(down)).toEqual(expected);
		expect(down.terrain.height).toHaveLength(32 * 32);

		const again = resizeWorld(down, { x: 64, z: 64 }).world;
		expect(inner(again)).toEqual(expected);

		// And the other two layers came with it, every time.
		for (const world of [up, down, again]) {
			expect(overlayGet(world.overlay, 4, 4, 4)).toBe(AIR_BLOCK);
			expect(world.placements[0]).toMatchObject({ id: 'p', x: 6, z: 6 });
		}
	});

	it('re-indexes onto the new stride rather than shearing the map', () => {
		const start = marked();
		const grown = resizeWorld(start, { x: 64, z: 64 }).world;

		// Row 1 of the old map begins at index 32 and now begins at index 64. A straight array
		// copy leaves it at 32, which bends the whole map along a diagonal and still looks
		// entirely like terrain.
		expect(grown.terrain.height[64]).toBe(8);
		expect(grown.terrain.height[columnIndex(grown.settings, 9, 0)]).toBe(29);
		expect(grown.terrain.height[columnIndex(grown.settings, 0, 1)]).toBe(8);
	});

	it('reports what a shrink cost, so the caller can ask first', () => {
		const start = marked();
		const { lost } = resizeWorld(start, { x: 16, z: 16 });

		expect(lost.columns).toBe(32 * 32 - 16 * 16);
		expect(lost.movedPlacements).toBe(0);
	});

	it('clears the cells of a chunk that a shrink put outside the map', () => {
		const world = createWorld({ size: { x: 64, z: 64 }, minY: 0, maxY: 64, seaLevel: 8 });
		const editor = new OverlayEditor();
		// Both in chunk (3,0,0), which spans x 48..63. Shrinking to 56 straddles it.
		editor.carve(50, 1, 1);
		editor.carve(60, 1, 1);
		world.overlay = editor.commit();

		const shrunk = resizeWorld(world, { x: 56, z: 64 }).world;

		expect(overlayGet(shrunk.overlay, 50, 1, 1)).toBe(AIR_BLOCK);
		// Left in place it would reappear the moment somebody widened the map again, which reads
		// as a cave coming back from the dead rather than as an undo.
		expect(overlayGet(shrunk.overlay, 60, 1, 1)).toBeNull();

		const regrown = resizeWorld(shrunk, { x: 64, z: 64 }).world;
		expect(overlayGet(regrown.overlay, 60, 1, 1)).toBeNull();
	});

	it('drops a chunk that ends up wholly outside', () => {
		const world = createWorld({ size: { x: 64, z: 64 }, minY: 0, maxY: 64 });
		const editor = new OverlayEditor();
		editor.carve(60, 1, 1);
		world.overlay = editor.commit();

		const { world: shrunk, lost } = resizeWorld(world, { x: 32, z: 64 });
		expect(Object.keys(shrunk.overlay)).toEqual([]);
		expect(lost.chunks).toBe(1);
	});

	it('walks a placement back inside a shrunken map and says it moved it', () => {
		const world = createWorld({ size: { x: 64, z: 64 }, minY: 0, maxY: 64 });
		world.placements = [
			{ id: 'p', buildId: 'b', x: 60, z: 4, y: 0, anchor: 'surface', turns: 0, name: 'Shop', w: 4, h: 4, d: 4 },
		];

		const { world: shrunk, lost } = resizeWorld(world, { x: 32, z: 64 });
		expect(shrunk.placements[0]!.x).toBe(31);
		expect(shrunk.placements[0]!.z).toBe(4);
		expect(lost.movedPlacements).toBe(1);
	});

	it('leaves the world it was given alone', () => {
		const start = marked();
		const before = [...start.terrain.height];
		resizeWorld(start, { x: 16, z: 16 });
		expect([...start.terrain.height]).toEqual(before);
		expect(start.settings.size).toEqual({ x: 32, z: 32 });
	});
});

describe('cloneWorld', () => {
	it('copies the typed arrays, not the references to them', () => {
		const world = createWorld({ size: { x: 16, z: 16 }, minY: 0, maxY: 64, seaLevel: 5 });
		const copy = cloneWorld(world);
		copy.terrain.height[0] = 40;
		copy.settings.size.x = 99;

		expect(world.terrain.height[0]).toBe(5);
		expect(world.settings.size.x).toBe(16);
	});
});
