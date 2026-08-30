/**
 * Materialising a region.
 *
 * The one place a world stops being a description and becomes blocks, so the assertions here
 * are cells, hand-computed from the document, rather than counts or shapes. Four things are
 * silent when they go wrong and each gets its own test:
 *
 * - **The index transpose.** Terrain is row-major and a grid is YZX, so every test map is
 *   non-square with different ground in each row. A transposed read comes out mirrored and
 *   perfectly plausible.
 * - **The carve.** A tunnel is only a tunnel if the cells around it survive. Asserting the air
 *   without asserting its neighbours would pass just as well for an overlay chunk that wiped
 *   the terrain inside it.
 * - **The rotation.** The prefab is 3x1 with a different block in each cell, because a square
 *   footprint of one block cannot tell a working quarter-turn from a no-op.
 * - **The seam.** A building straddling a boundary has to appear in both regions, clipped —
 *   positions may be negative and the answer is to clip, never to wrap.
 */

import { describe, expect, it } from 'vitest';
import { encodePrefab, type Prefab } from '../ir/prefab.js';
import { AIR_BLOCK, LIMITS, voxelIndex, type VoxelGrid } from '../ir/types.js';
import { OverlayEditor } from './overlay.js';
import {
	anchorY,
	materializeRegion,
	regionBox,
	regionCount,
	regionSlabs,
	regionStats,
	regionsOf,
} from './region.js';
import { WORLD_WATER } from './strata.js';
import { columnIndex, createTerrain } from './terrain.js';
import {
	WORLD_VERSION,
	type SurfaceProfile,
	type WorldDoc,
	type WorldPlacement,
	type WorldSettings,
} from './types.js';

/**
 * Ground made only of blocks with no blockstate properties, so an expected cell is the literal
 * string rather than something the test has to canonicalise first.
 */
const GROUND: SurfaceProfile = {
	id: 'test',
	label: 'Test',
	surface: 'minecraft:gravel',
	subsurface: 'minecraft:dirt',
	subsurfaceDepth: 3,
	filler: 'minecraft:stone',
};

function worldOf(settings: Partial<WorldSettings> = {}, doc: Partial<WorldDoc> = {}): WorldDoc {
	const resolved: WorldSettings = {
		size: { x: 3, z: 1 },
		minY: 0,
		maxY: 20,
		seaLevel: 2,
		regionSize: 16,
		strata: [GROUND],
		...settings,
	};
	return {
		version: WORLD_VERSION,
		id: 'w',
		name: 'Test world',
		settings: resolved,
		terrain: createTerrain(resolved),
		overlay: {},
		placements: [],
		updatedAt: '2026-01-01T00:00:00.000Z',
		...doc,
	};
}

function blockAt(grid: VoxelGrid, x: number, y: number, z: number): string {
	return grid.palette[grid.voxels[voxelIndex(grid.size, x, y, z)] ?? 0] ?? AIR_BLOCK;
}

/** A prefab of `blocks` laid along +x, one block tall and one deep. */
function rowPrefab(blocks: string[]): Prefab {
	const size = { x: blocks.length, y: 1, z: 1 };
	const voxels = new Uint16Array(blocks.length);
	for (let i = 0; i < blocks.length; i++) voxels[i] = i + 1;
	return encodePrefab({ size, palette: [AIR_BLOCK, ...blocks], voxels });
}

function placement(extra: Partial<WorldPlacement> = {}): WorldPlacement {
	return {
		id: 'p1',
		buildId: 'row',
		x: 0,
		z: 0,
		y: 0,
		anchor: 'surface',
		turns: 0,
		name: 'Row',
		w: 3,
		h: 1,
		d: 1,
		...extra,
	};
}

describe('a three-column world, cell by cell', () => {
	/**
	 * Heights 4, 1 and 0 with sea level at 2 and the world floor at 0. Written out in full:
	 *
	 *   y=4   gravel  air     air
	 *   y=3   dirt    air     air
	 *   y=2   dirt    water   water
	 *   y=1   dirt    gravel  water
	 *   y=0   stone   dirt    gravel
	 *          x=0     x=1     x=2
	 *
	 * Column 0's subsurface runs from 4-3=1 to 3, so y=0 is filler. Column 1's is 1-3=-2, which
	 * is below the world, so everything under its surface is subsurface and nothing is filler.
	 */
	const world = worldOf();
	world.terrain.height.set([4, 1, 0]);

	const { grid, stats, program } = materializeRegion(world, 0, 0, new Map());

	it('is only as tall as its contents', () => {
		// Ground fills to the floor, so the bottom is minY; the top is the highest of the ground
		// and sea level. 130 layers of empty sky above a hub is 130 layers nobody pays for.
		expect(grid.size).toEqual({ x: 3, y: 5, z: 1 });
		expect(stats.origin).toEqual([0, 0, 0]);
		expect(stats.minY).toBe(0);
		expect(stats.maxY).toBe(4);
	});

	it('lays each column down as filler, subsurface, surface', () => {
		expect(blockAt(grid, 0, 0, 0)).toBe('minecraft:stone');
		expect(blockAt(grid, 0, 1, 0)).toBe('minecraft:dirt');
		expect(blockAt(grid, 0, 2, 0)).toBe('minecraft:dirt');
		expect(blockAt(grid, 0, 3, 0)).toBe('minecraft:dirt');
		expect(blockAt(grid, 0, 4, 0)).toBe('minecraft:gravel');
	});

	it('stops the subsurface at the world floor rather than wrapping below it', () => {
		expect(blockAt(grid, 1, 0, 0)).toBe('minecraft:dirt');
		expect(blockAt(grid, 1, 1, 0)).toBe('minecraft:gravel');
	});

	it('floods every column below sea level, and none above it', () => {
		expect(blockAt(grid, 1, 2, 0)).toBe(WORLD_WATER);
		expect(blockAt(grid, 2, 1, 0)).toBe(WORLD_WATER);
		expect(blockAt(grid, 2, 2, 0)).toBe(WORLD_WATER);
		// Sea level is 2, so nothing above it is water and the tall column is dry throughout.
		expect(blockAt(grid, 1, 3, 0)).toBe(AIR_BLOCK);
		expect(blockAt(grid, 2, 3, 0)).toBe(AIR_BLOCK);
		expect(blockAt(grid, 0, 2, 0)).toBe('minecraft:dirt');
	});

	it('counts exactly the blocks it wrote', () => {
		// Ground: 5 + 2 + 1. Water: none over the tall column, one over the middle, two over
		// the low one.
		expect(stats.blocks).toBe(11);
		expect(program).toBeNull();
	});
});

describe('the row-major to YZX conversion', () => {
	it('puts a raised column at the right x and z, not at the transpose of them', () => {
		const world = worldOf({ size: { x: 4, z: 2 }, seaLevel: 0 });
		// One raised column at (x=3, z=0) — index 3 — and nothing else. Reading the terrain
		// transposed would find it at (x=0, z=1), which is index 4 and equally believable.
		world.terrain.height.set([0, 0, 0, 6, 0, 0, 0, 0]);

		const { grid } = materializeRegion(world, 0, 0, new Map());

		expect(grid.size).toEqual({ x: 4, y: 7, z: 2 });
		expect(blockAt(grid, 3, 6, 0)).toBe('minecraft:gravel');
		expect(blockAt(grid, 0, 6, 1)).toBe(AIR_BLOCK);
		expect(blockAt(grid, 0, 1, 0)).toBe(AIR_BLOCK);
	});
});

describe('the carve', () => {
	it('bores a tunnel through a hill and leaves the rock around it', () => {
		const world = worldOf({ size: { x: 8, z: 3 }, seaLevel: 0, maxY: 32 });
		// A flat-topped hill at y=10 over the whole map, so the tunnel is unambiguously inside
		// solid ground rather than cut through open air.
		world.terrain.height.fill(10);

		const editor = new OverlayEditor();
		// A 1x1 bore along +x at y=5, z=1, from x=2 to x=5.
		editor.fill({ x: 2, y: 5, z: 1 }, { x: 5, y: 5, z: 1 }, AIR_BLOCK);
		world.overlay = editor.commit();

		const { grid, stats } = materializeRegion(world, 0, 0, new Map());

		for (const x of [2, 3, 4, 5]) {
			expect(blockAt(grid, x, 5, 1), `tunnel at x=${x}`).toBe(AIR_BLOCK);
		}
		// The rock the tunnel goes through, on every side. Without these an overlay chunk that
		// simply wiped the terrain inside it would pass the assertions above.
		expect(blockAt(grid, 1, 5, 1)).toBe('minecraft:stone');
		expect(blockAt(grid, 6, 5, 1)).toBe('minecraft:stone');
		expect(blockAt(grid, 3, 4, 1)).toBe('minecraft:stone');
		expect(blockAt(grid, 3, 6, 1)).toBe('minecraft:stone');
		expect(blockAt(grid, 3, 5, 0)).toBe('minecraft:stone');
		expect(blockAt(grid, 3, 5, 2)).toBe('minecraft:stone');
		// And the hilltop is still there above it.
		expect(blockAt(grid, 3, 10, 1)).toBe('minecraft:gravel');

		expect(stats.overlayCells).toBe(4);
		expect(stats.carves).toBe(4);
	});

	it('writes an explicit overlay block over the ground, and leaves pass-through alone', () => {
		const world = worldOf({ size: { x: 4, z: 1 }, seaLevel: 0, maxY: 32 });
		world.terrain.height.fill(6);

		const editor = new OverlayEditor();
		editor.set(1, 3, 0, 'minecraft:bricks');
		world.overlay = editor.commit();

		const { grid } = materializeRegion(world, 0, 0, new Map());

		// Ground of height 6 with a three-deep subsurface, so y=3 is dirt everywhere the overlay
		// did not speak.
		expect(blockAt(grid, 1, 3, 0)).toBe('minecraft:bricks');
		expect(blockAt(grid, 0, 3, 0)).toBe('minecraft:dirt');
		expect(blockAt(grid, 2, 3, 0)).toBe('minecraft:dirt');
		expect(blockAt(grid, 1, 2, 0)).toBe('minecraft:stone');
	});

	it('lifts the region ceiling to reach an overlay cell above the ground', () => {
		const world = worldOf({ size: { x: 4, z: 1 }, seaLevel: 0, maxY: 40 });
		world.terrain.height.fill(2);

		const editor = new OverlayEditor();
		editor.set(1, 30, 0, 'minecraft:bricks');
		world.overlay = editor.commit();

		const { grid, stats } = materializeRegion(world, 0, 0, new Map());

		expect(stats.maxY).toBe(30);
		expect(grid.size.y).toBe(31);
		expect(blockAt(grid, 1, 30, 0)).toBe('minecraft:bricks');
	});
});

describe('a placed build', () => {
	const row = rowPrefab(['minecraft:stone', 'minecraft:dirt', 'minecraft:sand']);
	const catalogue = new Map([['row', row]]);

	/**
	 * A 3x1 prefab at (4, 4) on flat ground of height 2, so the build sits at y=3.
	 *
	 *   turns 0:  stone dirt sand   running east from  (4,4)
	 *   turns 1:  stone dirt sand   running south from (4,4)
	 *   turns 2:  sand dirt stone   running east from  (4,4)
	 *   turns 3:  sand dirt stone   running south from (4,4)
	 *
	 * Which is the whole point of a non-square prefab with three different blocks in it: a
	 * one-block cube, or three of the same block, cannot tell a turn from a no-op.
	 */
	function place(turns: 0 | 1 | 2 | 3) {
		const world = worldOf({ size: { x: 12, z: 12 }, seaLevel: 0, maxY: 32 });
		world.terrain.height.fill(2);
		world.placements = [placement({ x: 4, z: 4, turns })];
		return materializeRegion(world, 0, 0, catalogue);
	}

	it('stands on the surface, one block above the ground', () => {
		const { grid, stats } = place(0);
		expect(stats.maxY).toBe(3);
		expect(blockAt(grid, 4, 2, 4)).toBe('minecraft:gravel');
		expect(blockAt(grid, 4, 3, 4)).toBe('minecraft:stone');
	});

	it('runs east untimed', () => {
		const { grid } = place(0);
		expect(blockAt(grid, 4, 3, 4)).toBe('minecraft:stone');
		expect(blockAt(grid, 5, 3, 4)).toBe('minecraft:dirt');
		expect(blockAt(grid, 6, 3, 4)).toBe('minecraft:sand');
		expect(blockAt(grid, 4, 3, 5)).toBe(AIR_BLOCK);
	});

	it('runs south at a quarter turn, still anchored at its min corner', () => {
		const { grid } = place(1);
		expect(blockAt(grid, 4, 3, 4)).toBe('minecraft:stone');
		expect(blockAt(grid, 4, 3, 5)).toBe('minecraft:dirt');
		expect(blockAt(grid, 4, 3, 6)).toBe('minecraft:sand');
		expect(blockAt(grid, 5, 3, 4)).toBe(AIR_BLOCK);
	});

	it('runs east reversed at a half turn', () => {
		const { grid } = place(2);
		expect(blockAt(grid, 4, 3, 4)).toBe('minecraft:sand');
		expect(blockAt(grid, 5, 3, 4)).toBe('minecraft:dirt');
		expect(blockAt(grid, 6, 3, 4)).toBe('minecraft:stone');
		expect(blockAt(grid, 4, 3, 5)).toBe(AIR_BLOCK);
	});

	it('runs south reversed at three quarters', () => {
		const { grid } = place(3);
		expect(blockAt(grid, 4, 3, 4)).toBe('minecraft:sand');
		expect(blockAt(grid, 4, 3, 5)).toBe('minecraft:dirt');
		expect(blockAt(grid, 4, 3, 6)).toBe('minecraft:stone');
		expect(blockAt(grid, 5, 3, 4)).toBe(AIR_BLOCK);
	});

	it('turns a directional blockstate with the building it belongs to', () => {
		const stairs = rowPrefab(['minecraft:oak_stairs[facing=north]']);
		const world = worldOf({ size: { x: 8, z: 8 }, seaLevel: 0, maxY: 32 });
		world.terrain.height.fill(2);
		world.placements = [placement({ buildId: 'stairs', x: 1, z: 1, turns: 1, w: 1 })];

		const { grid } = materializeRegion(world, 0, 0, new Map([['stairs', stairs]]));

		// North turned clockwise is east. A prefab that moved but did not re-face would come out
		// with its stairs pointing into the wall they used to stand against.
		expect(blockAt(grid, 1, 3, 1)).toContain('facing=east');
	});

	it('buries a build so its top is flush with the ground', () => {
		const tower = encodePrefab({
			size: { x: 1, y: 3, z: 1 },
			palette: [AIR_BLOCK, 'minecraft:bricks'],
			voxels: Uint16Array.from([1, 1, 1]),
		});
		const world = worldOf({ size: { x: 8, z: 8 }, seaLevel: 0, maxY: 32 });
		world.terrain.height.fill(10);
		world.placements = [placement({ buildId: 'tower', x: 2, z: 2, anchor: 'buried', w: 1, h: 3 })];

		const { grid } = materializeRegion(world, 0, 0, new Map([['tower', tower]]));

		// height 10, three tall: 8, 9, 10 — the top block replaces the surface.
		expect(blockAt(grid, 2, 8, 2)).toBe('minecraft:bricks');
		expect(blockAt(grid, 2, 10, 2)).toBe('minecraft:bricks');
		expect(blockAt(grid, 2, 11, 2)).toBe(AIR_BLOCK);
		// Ground of height 10 with a three-deep subsurface: dirt at 7..9, filler below.
		expect(blockAt(grid, 2, 7, 2)).toBe('minecraft:dirt');
		expect(blockAt(grid, 2, 6, 2)).toBe('minecraft:stone');
	});

	it('does not carve with its own air', () => {
		// A prefab with a genuine hole in it — palette index 0 — set down at ground level. Index
		// 0 has to be skipped, or every placed building bulldozes a box of terrain the shape of
		// its own bounding volume and a hut leaves a rectangular scar in the hillside.
		const gapped = encodePrefab({
			size: { x: 3, y: 1, z: 1 },
			palette: [AIR_BLOCK, 'minecraft:bricks'],
			voxels: Uint16Array.from([1, 0, 1]),
		});
		const world = worldOf({ size: { x: 8, z: 8 }, seaLevel: 0, maxY: 32 });
		world.terrain.height.fill(4);
		world.placements = [placement({ buildId: 'gapped', x: 1, z: 1, anchor: 'fixed', y: 4 })];

		const { grid } = materializeRegion(world, 0, 0, new Map([['gapped', gapped]]));

		expect(blockAt(grid, 1, 4, 1)).toBe('minecraft:bricks');
		expect(blockAt(grid, 3, 4, 1)).toBe('minecraft:bricks');
		// The hole. The surface underneath it is untouched, not replaced with air.
		expect(blockAt(grid, 2, 4, 1)).toBe('minecraft:gravel');
	});

	it('reports a placement the catalogue cannot answer rather than guessing', () => {
		const world = worldOf({ size: { x: 8, z: 8 }, seaLevel: 0, maxY: 32 });
		world.terrain.height.fill(2);
		world.placements = [placement({ x: 1, z: 1 })];

		const { grid, stats, program } = materializeRegion(world, 0, 0, new Map());

		expect(stats.unresolved).toBe(1);
		expect(stats.placements).toBe(0);
		expect(program).toBeNull();
		expect(blockAt(grid, 1, 3, 1)).toBe(AIR_BLOCK);
	});

	it('hands back the placements as a program, and nothing else', () => {
		const world = worldOf({ size: { x: 12, z: 12 }, seaLevel: 0, maxY: 32 });
		world.terrain.height.fill(2);
		world.placements = [placement({ x: 4, z: 4, turns: 1 })];

		const { program } = materializeRegion(world, 0, 0, catalogue);

		expect(program).not.toBeNull();
		expect(program!.components).toHaveLength(1);
		expect(program!.components[0]).toMatchObject({
			type: 'prefab',
			ref: 'row',
			pos: [4, 3, 4],
			turns: 1,
		});
		expect(Object.keys(program!.prefabs ?? {})).toEqual(['row']);
	});
});

describe('anchorY', () => {
	it('reads the ground at the placement origin, and falls back off the map', () => {
		const world = worldOf({ size: { x: 8, z: 8 }, seaLevel: 5, maxY: 32 });
		world.terrain.height.fill(5);
		world.terrain.height[columnIndex(world.settings, 3, 3)] = 12;

		expect(anchorY(world, placement({ x: 3, z: 3 }), 4)).toBe(13);
		expect(anchorY(world, placement({ x: 3, z: 3, anchor: 'buried' }), 4)).toBe(9);
		expect(anchorY(world, placement({ x: 3, z: 3, anchor: 'fixed', y: 20 }), 4)).toBe(20);
		// An empty column has no surface to stand on; the world floor is the only honest answer.
		world.terrain.height[columnIndex(world.settings, 1, 1)] = world.settings.minY - 1;
		expect(anchorY(world, placement({ x: 1, z: 1 }), 4)).toBe(world.settings.minY);
	});
});

describe('a build straddling a region boundary', () => {
	/**
	 * Region size 16, a four-wide prefab at x=14 on flat ground of height 2. It covers x 14..17,
	 * so region 0 (x 0..15) gets its first two cells and region 1 (x 16..31) gets its last two —
	 * at local x 0 and 1, because a region's grid is its own space. A clip that wrapped instead
	 * would put the overhang back at the west edge of region 0.
	 */
	const row = rowPrefab([
		'minecraft:stone', 'minecraft:dirt', 'minecraft:sand', 'minecraft:bricks',
	]);
	const catalogue = new Map([['row', row]]);

	const world = worldOf({ size: { x: 32, z: 16 }, seaLevel: 0, maxY: 32, regionSize: 16 });
	world.terrain.height.fill(2);
	world.placements = [placement({ x: 14, z: 4, w: 4 })];

	it('appears clipped in the western region', () => {
		const { grid, stats } = materializeRegion(world, 0, 0, catalogue);
		expect(stats.placements).toBe(1);
		expect(grid.size.x).toBe(16);
		expect(blockAt(grid, 14, 3, 4)).toBe('minecraft:stone');
		expect(blockAt(grid, 15, 3, 4)).toBe('minecraft:dirt');
	});

	it('appears clipped in the eastern one, at that region\'s own local coordinates', () => {
		const { grid, stats } = materializeRegion(world, 1, 0, catalogue);
		expect(stats.placements).toBe(1);
		expect(stats.origin[0]).toBe(16);
		expect(blockAt(grid, 0, 3, 4)).toBe('minecraft:sand');
		expect(blockAt(grid, 1, 3, 4)).toBe('minecraft:bricks');
		// Not wrapped round to the far side of the region.
		expect(blockAt(grid, 15, 3, 4)).toBe(AIR_BLOCK);
		expect(blockAt(grid, 14, 3, 4)).toBe(AIR_BLOCK);
	});

	it('does not reach a region it only passes near', () => {
		const { stats } = materializeRegion(world, 0, 0, catalogue);
		expect(stats.unresolved).toBe(0);
		const away = materializeRegion(
			{ ...world, placements: [placement({ x: 0, z: 0, w: 4 })] },
			1,
			0,
			catalogue,
		);
		expect(away.stats.placements).toBe(0);
	});
});

describe('an overlay chunk straddling a boundary', () => {
	it('is clipped into both regions rather than wrapped into one', () => {
		const world = worldOf({ size: { x: 32, z: 16 }, seaLevel: 0, maxY: 32, regionSize: 16 });
		world.terrain.height.fill(8);

		const editor = new OverlayEditor();
		editor.fill({ x: 14, y: 4, z: 2 }, { x: 17, y: 4, z: 2 }, AIR_BLOCK);
		world.overlay = editor.commit();

		const west = materializeRegion(world, 0, 0, new Map());
		const east = materializeRegion(world, 1, 0, new Map());

		expect(west.stats.carves).toBe(2);
		expect(east.stats.carves).toBe(2);
		expect(blockAt(west.grid, 14, 4, 2)).toBe(AIR_BLOCK);
		expect(blockAt(west.grid, 15, 4, 2)).toBe(AIR_BLOCK);
		expect(blockAt(west.grid, 13, 4, 2)).toBe('minecraft:stone');
		expect(blockAt(east.grid, 0, 4, 2)).toBe(AIR_BLOCK);
		expect(blockAt(east.grid, 1, 4, 2)).toBe(AIR_BLOCK);
		expect(blockAt(east.grid, 2, 4, 2)).toBe('minecraft:stone');
	});
});

describe('regionsOf', () => {
	it('covers a map that is not a whole number of regions wide', () => {
		const settings = worldOf({ size: { x: 40, z: 20 }, regionSize: 16 }).settings;
		expect(regionCount(settings)).toEqual({ x: 3, z: 2 });

		const regions = regionsOf(settings);
		expect(regions).toHaveLength(6);
		// The last column is 40 - 32 = 8 wide, and the last row 20 - 16 = 4 deep. A full-width
		// edge region would be a strip of nothing that still cost cells and mesh work.
		expect(regionBox(settings, 2, 0)).toMatchObject({ x: 32, w: 8 });
		expect(regionBox(settings, 0, 1)).toMatchObject({ z: 16, d: 4 });
		expect(regions.map((region) => region.w * region.d).reduce((a, b) => a + b, 0)).toBe(40 * 20);
	});

	it('splits a world taller than a build into stacked slabs', () => {
		// Minecraft's own -64..192 is 257 blocks, and a build may be 160. One region column
		// therefore has to become two, or every materialise of it is an illegal grid.
		const settings = worldOf({ size: { x: 16, z: 16 }, minY: -64, maxY: 192, regionSize: 16 }).settings;

		const slabs = regionSlabs(settings);
		expect(slabs).toEqual([
			{ minY: -64, maxY: 95 },
			{ minY: 96, maxY: 192 },
		]);

		const regions = regionsOf(settings);
		expect(regions).toHaveLength(2);
		expect(regions.map((region) => region.ry)).toEqual([0, 1]);
		for (const region of regions) {
			expect(region.maxY - region.minY + 1).toBeLessThanOrEqual(LIMITS.maxSizeY);
		}
	});

	it('leaves a world that already fits as one slab', () => {
		const settings = worldOf({ size: { x: 16, z: 16 }, minY: 0, maxY: 100 }).settings;
		expect(regionSlabs(settings)).toEqual([{ minY: 0, maxY: 100 }]);
		expect(regionsOf(settings).every((region) => region.ry === 0)).toBe(true);
	});
});

describe('the size cap', () => {
	it('never hands back a grid taller than a build may be', () => {
		const world = worldOf({ size: { x: 16, z: 16 }, minY: -64, maxY: 192, seaLevel: 62, regionSize: 16 });
		world.terrain.height.fill(190);

		// Content runs -64..190, which is 255 tall. Materialising without naming a slab has to
		// clip rather than return a grid the engine would refuse.
		const whole = materializeRegion(world, 0, 0, new Map());
		expect(whole.grid.size.y).toBe(LIMITS.maxSizeY);
		expect(whole.stats.clippedY).toBe(true);
		expect(whole.stats.withinSizeCap).toBe(true);
		// The top is what survives: the surface is what anyone is looking at, and the deep filler
		// is the part nobody misses. The grid now starts at y=31, so the surface is its last row.
		expect(whole.stats.maxY).toBe(190);
		expect(whole.stats.minY).toBe(31);
		expect(blockAt(whole.grid, 0, whole.grid.size.y - 1, 0)).toBe('minecraft:gravel');
		expect(blockAt(whole.grid, 0, 0, 0)).toBe('minecraft:stone');

		// Iterating the regions instead loses nothing and clips nothing.
		for (const region of regionsOf(world.settings)) {
			const piece = materializeRegion(world, region.rx, region.rz, new Map(), region);
			expect(piece.stats.clippedY).toBe(false);
			expect(piece.grid.size.y).toBeLessThanOrEqual(LIMITS.maxSizeY);
		}
	});

	it('keeps a full region inside both engine caps for a shallow world', () => {
		const world = worldOf({ size: { x: 128, z: 128 }, minY: 0, maxY: 64, seaLevel: 8, regionSize: 128 });
		world.terrain.height.fill(8);

		const stats = regionStats(world, 0, 0);
		// 128 x 128 columns, 9 blocks each from y=0 to y=8.
		expect(stats.sizeY).toBe(9);
		expect(stats.blocks).toBe(128 * 128 * 9);
		expect(stats.sizeY).toBeLessThanOrEqual(LIMITS.maxSizeY);
		expect(stats.blocks).toBeLessThanOrEqual(LIMITS.maxBlocks);
		expect(stats.withinSizeCap).toBe(true);
		expect(stats.withinBlockCap).toBe(true);

		const built = materializeRegion(world, 0, 0, new Map());
		expect(built.grid.size).toEqual({ x: 128, y: 9, z: 128 });
		expect(built.stats.blocks).toBe(stats.blocks);
	});

	it('says so when a region would be too many blocks for one build', () => {
		// A deep world is not an error — it is a region a caller has to subdivide or refuse, and
		// the flag is how it finds out before it has spent the memory building it.
		const world = worldOf({ size: { x: 128, z: 128 }, minY: -64, maxY: 64, seaLevel: 62, regionSize: 128 });
		world.terrain.height.fill(62);

		const stats = regionStats(world, 0, 0);
		expect(stats.blocks).toBe(128 * 128 * 127);
		expect(stats.withinBlockCap).toBe(false);
		expect(stats.withinSizeCap).toBe(true);
	});

	it('reports the same footprint as the box it came from', () => {
		const world = worldOf({ size: { x: 40, z: 20 }, seaLevel: 0, maxY: 32, regionSize: 16 });
		const stats = regionStats(world, 2, 1);
		expect(stats.w).toBe(8);
		expect(stats.d).toBe(4);
		expect(stats.columns).toBe(32);
		expect(stats.origin[0]).toBe(32);
		expect(stats.origin[2]).toBe(16);
	});
});
