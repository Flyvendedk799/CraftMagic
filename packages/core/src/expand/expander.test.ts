import { describe, expect, it } from 'vitest';
import { expand } from './expander.js';
import { cottage, pavilion, samples, tower } from '../samples/index.js';
import type { BuildProgram, VoxelGrid } from '../ir/types.js';
import { AIR_BLOCK, LIMITS, voxelIndex } from '../ir/types.js';

function blockAt(grid: VoxelGrid, x: number, y: number, z: number): string {
	return grid.palette[grid.voxels[voxelIndex(grid.size, x, y, z)]!]!;
}

/** The box the build actually fills, which is what a resize has to move. */
function occupied(grid: VoxelGrid): { x: number; y: number; z: number } {
	const lo = [grid.size.x, grid.size.y, grid.size.z];
	const hi = [-1, -1, -1];

	for (let i = 0; i < grid.voxels.length; i++) {
		if (grid.voxels[i] === 0) continue;
		const layer = grid.size.x * grid.size.z;
		const p = [i % grid.size.x, Math.floor(i / layer), Math.floor((i % layer) / grid.size.x)];
		for (const axis of [0, 1, 2]) {
			if (p[axis]! < lo[axis]!) lo[axis] = p[axis]!;
			if (p[axis]! > hi[axis]!) hi[axis] = p[axis]!;
		}
	}

	return { x: hi[0]! - lo[0]! + 1, y: hi[1]! - lo[1]! + 1, z: hi[2]! - lo[2]! + 1 };
}

function withComponents(components: BuildProgram['components'], extra: Partial<BuildProgram> = {}): BuildProgram {
	return {
		version: 1,
		meta: { name: 'test' },
		size: { x: 9, y: 9, z: 9 },
		palette: { a: 'minecraft:stone', b: 'minecraft:oak_planks', stairs: 'minecraft:oak_stairs' },
		components,
		...extra,
	};
}

describe('expand — basics', () => {
	it('always reserves palette slot 0 for air', () => {
		const { grid } = expand(withComponents([]));
		expect(grid.palette[0]).toBe(AIR_BLOCK);
	});

	it('fills a box and counts only non-air blocks', () => {
		const result = expand(
			withComponents([{ type: 'box', pos: [0, 0, 0], size: [3, 2, 4], fill: { type: 'solid', role: 'a' } }]),
		);
		expect(result.errors).toEqual([]);
		expect(result.blockCount).toBe(3 * 2 * 4);
		expect(blockAt(result.grid, 0, 0, 0)).toBe('minecraft:stone');
		expect(blockAt(result.grid, 2, 1, 3)).toBe('minecraft:stone');
		expect(blockAt(result.grid, 3, 0, 0)).toBe(AIR_BLOCK);
	});

	it('applies painter order, with later components overwriting earlier ones', () => {
		const result = expand(
			withComponents([
				{ type: 'box', pos: [0, 0, 0], size: [4, 1, 1], fill: { type: 'solid', role: 'a' } },
				{ type: 'box', pos: [2, 0, 0], size: [2, 1, 1], fill: { type: 'solid', role: 'b' } },
			]),
		);
		expect(blockAt(result.grid, 1, 0, 0)).toBe('minecraft:stone');
		expect(blockAt(result.grid, 2, 0, 0)).toBe('minecraft:oak_planks');
	});

	it('carves when a component paints air', () => {
		const result = expand(
			withComponents([
				{ type: 'box', pos: [0, 0, 0], size: [3, 1, 1], fill: { type: 'solid', role: 'a' } },
				{ type: 'box', pos: [1, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'minecraft:air' } },
			]),
		);
		expect(blockAt(result.grid, 1, 0, 0)).toBe(AIR_BLOCK);
		expect(result.blockCount).toBe(2);
	});

	it('drops palette entries that nothing ends up referencing', () => {
		// The stone box is entirely painted over, so stone must not linger in the palette
		// and bloat the exported schematic.
		const result = expand(
			withComponents([
				{ type: 'box', pos: [0, 0, 0], size: [2, 1, 1], fill: { type: 'solid', role: 'a' } },
				{ type: 'box', pos: [0, 0, 0], size: [2, 1, 1], fill: { type: 'solid', role: 'b' } },
			]),
		);
		expect(result.grid.palette).not.toContain('minecraft:stone');
	});

	it('clips writes outside the build volume instead of throwing', () => {
		const result = expand(
			withComponents([{ type: 'box', pos: [7, 0, 0], size: [10, 1, 1], fill: { type: 'solid', role: 'a' } }]),
		);
		expect(result.blockCount).toBe(2); // x = 7, 8 only
	});
});

describe('expand — hollow_box', () => {
	it('leaves the interior empty but keeps walls and floor', () => {
		const result = expand(
			withComponents([
				{
					type: 'hollow_box',
					pos: [0, 0, 0],
					size: [5, 4, 5],
					wallThickness: 1,
					floor: true,
					ceiling: false,
					fill: { type: 'solid', role: 'a' },
				},
			]),
		);
		expect(blockAt(result.grid, 0, 2, 0)).toBe('minecraft:stone'); // wall
		expect(blockAt(result.grid, 2, 0, 2)).toBe('minecraft:stone'); // floor
		expect(blockAt(result.grid, 2, 2, 2)).toBe(AIR_BLOCK); // interior
		expect(blockAt(result.grid, 2, 3, 2)).toBe(AIR_BLOCK); // no ceiling
	});
});

describe('expand — roofs compute blockstates from geometry', () => {
	it('points each gable slope toward the ridge it climbs', () => {
		// This is the property LLMs get wrong: a slope ascending north needs facing=north,
		// because a stair's `facing` names the side its tall half sits on.
		const result = expand(
			withComponents(
				[
					{
						type: 'gable_roof',
						pos: [0, 0, 0],
						size: [3, 4, 7],
						ridgeAxis: 'x',
						style: 'stairs',
						roofRole: 'stairs',
					},
				],
				{ size: { x: 3, y: 8, z: 7 } },
			),
		);

		// Low-z side climbs toward +Z (south); high-z side climbs toward -Z (north).
		expect(blockAt(result.grid, 1, 0, 0)).toContain('facing=south');
		expect(blockAt(result.grid, 1, 0, 6)).toContain('facing=north');
		expect(blockAt(result.grid, 1, 1, 1)).toContain('facing=south');
		expect(blockAt(result.grid, 1, 1, 5)).toContain('facing=north');
	});

	it('caps an odd-span ridge with a solid block rather than a notched stair', () => {
		const result = expand(
			withComponents(
				[
					{
						type: 'gable_roof',
						pos: [0, 0, 0],
						size: [3, 4, 7],
						ridgeAxis: 'x',
						style: 'stairs',
						roofRole: 'stairs',
						trimRole: 'b',
					},
				],
				{ size: { x: 3, y: 8, z: 7 } },
			),
		);
		// Span 7 -> ridge at level 3, z = 3.
		expect(blockAt(result.grid, 1, 3, 3)).toBe('minecraft:oak_planks');
	});

	it('turns hip-roof corners into outer stairs raised toward the ridge', () => {
		// Derived from the vanilla model: `outer_stairs` raises its quarter in the SE at
		// y=0, and the blockstate y rotations move it clockwise. At the NW corner the roof
		// climbs south and east, so the raised quarter must sit SE -> facing=south +
		// outer_left. A plain straight stair here notches every corner.
		const result = expand(
			withComponents(
				[{ type: 'hip_roof', pos: [0, 0, 0], size: [7, 3, 7], style: 'stairs', roofRole: 'stairs' }],
				{ size: { x: 7, y: 4, z: 7 } },
			),
		);

		const nw = blockAt(result.grid, 0, 0, 0);
		expect(nw).toContain('shape=outer_left');
		expect(nw).toContain('facing=south');

		const ne = blockAt(result.grid, 6, 0, 0);
		expect(ne).toContain('shape=outer_right');
		expect(ne).toContain('facing=south');

		const sw = blockAt(result.grid, 0, 0, 6);
		expect(sw).toContain('shape=outer_right');
		expect(sw).toContain('facing=north');

		const se = blockAt(result.grid, 6, 0, 6);
		expect(se).toContain('shape=outer_left');
		expect(se).toContain('facing=north');
	});

	it('slopes each hip-roof face toward the middle', () => {
		const result = expand(
			withComponents(
				[{ type: 'hip_roof', pos: [0, 0, 0], size: [7, 3, 7], style: 'stairs', roofRole: 'stairs' }],
				{ size: { x: 7, y: 4, z: 7 } },
			),
		);
		expect(blockAt(result.grid, 3, 0, 0)).toContain('facing=south'); // north face climbs south
		expect(blockAt(result.grid, 3, 0, 6)).toContain('facing=north');
		expect(blockAt(result.grid, 0, 0, 3)).toContain('facing=east'); // west face climbs east
		expect(blockAt(result.grid, 6, 0, 3)).toContain('facing=west');
	});

	it('caps a hip roof instead of leaving a hole at the apex', () => {
		// Tiers converge to a 3x3 whose centre is on no edge, so without an explicit cap the
		// roof ends up open to the sky.
		const result = expand(
			withComponents(
				[{ type: 'hip_roof', pos: [0, 0, 0], size: [7, 4, 7], style: 'stairs', roofRole: 'stairs' }],
				{ size: { x: 7, y: 6, z: 7 } },
			),
		);
		expect(blockAt(result.grid, 3, 3, 3)).not.toBe(AIR_BLOCK);
	});

	it('closes a gable roof flat when the height runs out before the ridge', () => {
		// Span 9 needs 5 levels; only 2 are allowed, so the top must be decked over.
		const result = expand(
			withComponents(
				[
					{
						type: 'gable_roof',
						pos: [0, 0, 0],
						size: [3, 2, 9],
						ridgeAxis: 'x',
						style: 'stairs',
						roofRole: 'stairs',
						trimRole: 'b',
					},
				],
				{ size: { x: 3, y: 4, z: 9 } },
			),
		);
		for (let z = 1; z <= 7; z++) {
			expect(blockAt(result.grid, 1, 1, z)).not.toBe(AIR_BLOCK);
		}
	});

	it('makes a staircase face its direction of travel', () => {
		const result = expand(
			withComponents([
				{ type: 'stairs_run', pos: [0, 0, 0], direction: 'east', width: 1, steps: 3, role: 'stairs' },
			]),
		);
		expect(blockAt(result.grid, 0, 0, 0)).toContain('facing=east');
		expect(blockAt(result.grid, 2, 2, 0)).toContain('facing=east');
	});
});

describe('expand — groups and transforms', () => {
	it('translates children', () => {
		const result = expand(
			withComponents([
				{
					type: 'group',
					transform: [{ op: 'translate', by: [3, 1, 2] }],
					children: [{ type: 'box', pos: [0, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'a' } }],
				},
			]),
		);
		expect(blockAt(result.grid, 3, 1, 2)).toBe('minecraft:stone');
	});

	it('rotates clockwise: north maps to east', () => {
		// A block one step north of the pivot must land one step east of it.
		const result = expand(
			withComponents([
				{
					type: 'group',
					transform: [{ op: 'rotate90', times: 1, pivot: [4, 0, 4] }],
					children: [{ type: 'box', pos: [4, 0, 3], size: [1, 1, 1], fill: { type: 'solid', role: 'a' } }],
				},
			]),
		);
		expect(blockAt(result.grid, 5, 0, 4)).toBe('minecraft:stone');
	});

	it('rotates a child block state along with its position', () => {
		const result = expand(
			withComponents([
				{
					type: 'group',
					transform: [{ op: 'rotate90', times: 1, pivot: [4, 0, 4] }],
					children: [
						{ type: 'stairs_run', pos: [4, 0, 4], direction: 'north', width: 1, steps: 1, role: 'stairs' },
					],
				},
			]),
		);
		expect(blockAt(result.grid, 4, 0, 4)).toContain('facing=east');
	});

	it('mirrors positions across a pivot', () => {
		const result = expand(
			withComponents([
				{
					type: 'group',
					transform: [{ op: 'mirror', axis: 'x', pivot: [4, 0, 4] }],
					children: [{ type: 'box', pos: [2, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'a' } }],
				},
			]),
		);
		expect(blockAt(result.grid, 6, 0, 0)).toBe('minecraft:stone');
	});

	it('repeats children along a step vector', () => {
		const result = expand(
			withComponents([
				{
					type: 'group',
					transform: [{ op: 'repeat', count: 3, step: [2, 0, 0] }],
					children: [{ type: 'box', pos: [0, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'a' } }],
				},
			]),
		);
		expect(result.blockCount).toBe(3);
		for (const x of [0, 2, 4]) expect(blockAt(result.grid, x, 0, 0)).toBe('minecraft:stone');
	});

	it('multiplies nested repeats into a grid', () => {
		const result = expand(
			withComponents([
				{
					type: 'group',
					transform: [
						{ op: 'repeat', count: 3, step: [2, 0, 0] },
						{ op: 'repeat', count: 2, step: [0, 0, 3] },
					],
					children: [{ type: 'box', pos: [0, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'a' } }],
				},
			]),
		);
		expect(result.blockCount).toBe(6);
	});
});

describe('expand — error reporting feeds the repair loop', () => {
	it('reports an unknown block in the palette with a path', () => {
		const result = expand(withComponents([], { palette: { a: 'minecraft:not_a_block' } }));
		expect(result.errors).toContainEqual(
			expect.objectContaining({ path: 'palette.a', code: 'UNKNOWN_BLOCK' }),
		);
	});

	it('reports a role that components use but the palette never defines', () => {
		const result = expand(
			withComponents([{ type: 'box', pos: [0, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'ghost' } }], {
				palette: { a: 'minecraft:stone' },
			}),
		);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: 'UNDEFINED_ROLE', message: expect.stringContaining('ghost') }),
		);
	});

	it('reports a bad coordinate expression against the offending component', () => {
		const result = expand(
			withComponents([
				{ type: 'box', pos: ['maxx' as never, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'a' } },
			]),
		);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ path: 'components[0]', code: 'BAD_COORD_EXPR' }),
		);
	});

	it('skips only the broken component and still draws the rest', () => {
		const result = expand(
			withComponents([
				{ type: 'box', pos: ['nonsense' as never, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'a' } },
				{ type: 'box', pos: [0, 0, 0], size: [2, 1, 1], fill: { type: 'solid', role: 'a' } },
			]),
		);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.blockCount).toBe(2); // the good component still drew
	});

	it('clamps an oversized build and says so rather than allocating it', () => {
		const result = expand(withComponents([], { size: { x: 9999, y: 9999, z: 9999 } }));
		expect(result.errors).toContainEqual(expect.objectContaining({ code: 'SIZE_CAP' }));
		expect(result.grid.size.x).toBeLessThanOrEqual(256);
	});

	// A model can get a field's *shape* wrong, not just its values, and the expander is the
	// one place that must survive it: throwing here lost the whole generation to a TypeError
	// with no issue for the repair round to act on.
	it('reports a details field that is not a list, and still draws the components', () => {
		const result = expand(
			withComponents([{ type: 'box', pos: [0, 0, 0], size: [2, 1, 1], fill: { type: 'solid', role: 'a' } }], {
				details: 'lanterns on the corner posts' as never,
			}),
		);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ path: 'details', code: 'BAD_STATE' }),
		);
		expect(result.blockCount).toBe(2);
	});

	it('reports a components field that is not a list rather than throwing', () => {
		const result = expand(withComponents('a stone cottage' as never));
		expect(result.errors).toContainEqual(
			expect.objectContaining({ path: 'components', code: 'BAD_STATE' }),
		);
		expect(result.blockCount).toBe(0);
	});

	it('reports a palette role that is neither a block id nor a list of choices', () => {
		const result = expand(withComponents([], { palette: { a: { block: 'minecraft:stone' } as never } }));
		expect(result.errors).toContainEqual(
			expect.objectContaining({ path: 'palette.a', code: 'BAD_STATE' }),
		);
	});

	it('rejects an oversized detail fill, pointing at the right op', () => {
		const result = expand(
			withComponents([], { details: [{ op: 'fill', from: [0, 0, 0], to: [8, 8, 8], block: 'minecraft:stone' }] }),
		);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ path: 'details[0]', code: 'DETAIL_CAP' }),
		);
	});
});

describe('expand — determinism and resize', () => {
	it.each(Object.keys(samples))('expands %s without errors', (name) => {
		const result = expand(samples[name]!);
		expect(result.errors).toEqual([]);
		expect(result.blockCount).toBeGreaterThan(100);
	});

	it('is deterministic, including weighted noise fills', () => {
		// Two expansions of the tower (which uses a noise fill) must agree block for block,
		// or a stored grid would stop matching the program that produced it.
		const a = expand(tower).grid;
		const b = expand(tower).grid;
		expect(a.palette).toEqual(b.palette);
		expect(Array.from(a.voxels)).toEqual(Array.from(b.voxels));
	});

	it('re-expands at a new size with walls still anchored to the edges', () => {
		const narrow = expand(cottage);
		const wider = expand({ ...cottage, size: { ...cottage.size, x: 31 } });
		expect(wider.errors).toEqual([]);
		expect(wider.grid.size.x).toBe(31);

		// The point of anchoring: the far wall tracks the new edge instead of staying put at
		// the old one, and the building gets genuinely wider rather than just gaining space.
		const wallX = 31 - 2; // inset one block from the volume edge
		expect(blockAt(wider.grid, wallX, 2, 6)).not.toBe(AIR_BLOCK);
		expect(blockAt(wider.grid, wallX + 1, 2, 6)).toBe(AIR_BLOCK);
		expect(wider.blockCount).toBeGreaterThan(narrow.blockCount);
	});

	it('grows the build when a param increases, without touching any other field', () => {
		const oneFloor = expand(cottage).blockCount;
		const twoFloors = expand({
			...cottage,
			params: { floors: { value: 2, min: 1, max: 2 } },
		}).blockCount;
		expect(twoFloors).toBeGreaterThan(oneFloor);
	});

	it('warns when a build is largely clipped by its own volume', () => {
		// A sphere hanging off the top of the box: most of it lands outside and is dropped.
		// Silently truncating a build is the worst possible outcome, so this must surface.
		const result = expand(
			withComponents(
				[{ type: 'sphere', center: [4, 8, 4], radius: 6, fill: { type: 'solid', role: 'a' } }],
				{ size: { x: 9, y: 9, z: 9 } },
			),
		);
		expect(result.warnings).toContainEqual(
			expect.objectContaining({ path: 'size', code: 'OUT_OF_BOUNDS' }),
		);
	});

	it('does not warn about a deliberate roof overhang', () => {
		// The cottage's eaves project past the footprint by design; a warning every time
		// would train everyone to ignore warnings.
		expect(expand(cottage).warnings).toEqual([]);
	});

	it('keeps every sample inside its volume across the full param range', () => {
		// This is the check that would have caught the tower's dome being clipped at high
		// $height. A param the user can turn up must not be able to truncate the build.
		for (const [name, program] of Object.entries(samples)) {
			for (const [paramName, param] of Object.entries(program.params ?? {})) {
				for (const value of [param.min, param.max]) {
					const result = expand({
						...program,
						params: { ...program.params, [paramName]: { ...param, value } },
					});
					expect(result.errors, `${name} ${paramName}=${value}`).toEqual([]);
					expect(
						result.warnings.filter((w) => w.code === 'OUT_OF_BOUNDS'),
						`${name} ${paramName}=${value} clips out of its build volume`,
					).toEqual([]);
				}
			}
		}
	});

	it('keeps the pavilion pillars aligned under its hip roof', () => {
		const result = expand(pavilion);
		expect(result.errors).toEqual([]);
		expect(blockAt(result.grid, 2, 3, 2)).toContain('log');
	});
});

/**
 * The bug these guard against: resizing used to change `size` and nothing else, so only
 * coordinates written against the volume (`min`/`max`/`center`/`%`) moved. Everything written
 * as a number or driven by a param — a radius, a storey height, a pillar stride — stayed
 * exactly where it was, and the build sat unchanged in a larger empty box. The tower, which is
 * all literals and params, did not gain or lose a single block at 200%.
 */
describe('expand — scale moves every block, not just the anchored ones', () => {
	const at = (percent: number) => ({ x: percent, y: percent, z: percent });

	it('changes nothing at 100%', () => {
		for (const [name, program] of Object.entries(samples)) {
			const plain = expand(program).grid;
			const scaled = expand({ ...program, scale: at(100) }).grid;
			expect(Array.from(scaled.voxels), name).toEqual(Array.from(plain.voxels));
		}
	});

	it('grows a build with no anchored coordinates at all', () => {
		// The tower is a cylinder of literal radius on a `$height` param — before the fix this
		// came back byte-for-byte identical to the unscaled build.
		const base = expand(tower);
		const big = expand({ ...tower, scale: at(200) });

		expect(big.errors).toEqual([]);
		expect(big.blockCount).toBeGreaterThan(base.blockCount * 2);
		expect(occupied(big.grid).x).toBeGreaterThan(occupied(base.grid).x * 1.8);
		expect(occupied(big.grid).y).toBeGreaterThan(occupied(base.grid).y * 1.8);
	});

	it('scales a param-driven height, and a literal one', () => {
		// The cottage's storey height is `$floors*5` and its roof is a literal 8, so its Y used
		// to be the same twelve blocks at every setting of the slider.
		const base = occupied(expand(cottage).grid);
		expect(occupied(expand({ ...cottage, scale: at(200) }).grid).y).toBeGreaterThan(base.y * 1.8);
	});

	it('moves one axis without touching the other two', () => {
		const base = occupied(expand(cottage).grid);
		const tall = occupied(expand({ ...cottage, scale: { x: 100, y: 200, z: 100 } }).grid);

		// The walls double. The roof does not: a gable's height comes from the span it covers,
		// and that span is on an axis the user left alone — so the pitch holds and the building
		// grows by a storey rather than stretching into a spire.
		expect(tall.y).toBeGreaterThan(base.y);
		expect(tall.x).toBe(base.x);
		expect(tall.z).toBe(base.z);
	});

	it('spreads repeated children over the new footprint instead of bunching them', () => {
		// The pavilion's pillars are one box repeated on a stride of 5. A stride that does not
		// scale leaves all sixteen pillars in one quarter of a doubled plot.
		const big = expand({ ...pavilion, scale: at(200) });
		expect(big.errors).toEqual([]);
		expect(occupied(big.grid).x).toBeGreaterThan(occupied(expand(pavilion).grid).x * 1.8);

		// Corner pillar, at twice its original offset.
		expect(blockAt(big.grid, 4, 6, 4)).toContain('log');
	});

	it('shrinks without dropping a serious share of the build', () => {
		// The far edge of a component is scaled, not its length, so a box that fitted its
		// volume exactly still fits after an awkward factor rather than overhanging by one.
		for (const [name, program] of Object.entries(samples)) {
			for (const percent of [50, 65, 80, 150, 250, 400]) {
				const result = expand({ ...program, scale: at(percent) });
				expect(result.errors, `${name} at ${percent}%`).toEqual([]);
				expect(
					result.warnings.filter((w) => w.code === 'OUT_OF_BOUNDS'),
					`${name} at ${percent}% spills out of its own volume`,
				).toEqual([]);
			}
		}
	});

	it('holds the engine cap, and keeps the geometry inside it', () => {
		// 400% of the tower's 30 is 120, but x and z would reach 68 — the point is that the
		// clamped axis stops growing rather than drawing past the volume it was given.
		const huge = expand({ ...tower, scale: at(400) });
		expect(huge.grid.size.x).toBeLessThanOrEqual(LIMITS.maxSizeX);
		expect(huge.grid.size.y).toBeLessThanOrEqual(LIMITS.maxSizeY);
		expect(occupied(huge.grid).x).toBeLessThanOrEqual(huge.grid.size.x);
	});

	it('leaves counts alone while scaling the things they count', () => {
		// Windows get bigger; there are still exactly two of them.
		const wall = withComponents(
			[
				{
					type: 'window_grid',
					face: 'south',
					region: { pos: [0, 0, 8], size: [9, 4, 1] },
					rows: 1,
					cols: 2,
					windowSize: [2, 2],
					role: 'a',
				},
			],
			{ palette: { a: 'minecraft:glass' } },
		);

		const plain = expand(wall);
		const big = expand({ ...wall, scale: at(200) });

		// Two windows, 2x2, through a wall one block thick.
		expect(plain.blockCount).toBe(2 * (2 * 2) * 1);
		// Still two windows — 4x4 now, through a wall that is two blocks thick.
		expect(big.blockCount).toBe(2 * (4 * 4) * 2);
	});
});

/**
 * Resizing has to be *faithful*, not merely proportional.
 *
 * The bugs these guard against were all one block wide and all very visible: a symmetric
 * facade whose left half moved a block further than its right, a wall anchored at `max` that
 * vanished below half scale because its corner rounded past the far edge, a pair of lanterns
 * that ended up one block apart, and two components designed to meet that came back with a
 * gap between them. Every one of them came from rounding a position and a length separately,
 * or from rounding ties in the one direction that a mirror image cannot survive.
 */
describe('expand — a resize keeps the design, not just the proportions', () => {
	const at = (percent: number) => ({ x: percent, y: percent, z: percent });
	/** Enough factors to catch a rounding rule that only works on the tidy ones. */
	const FACTORS = [25, 30, 40, 45, 50, 55, 65, 70, 80, 95, 100, 115, 135, 150, 175, 200, 265, 300];

	/**
	 * A build that is symmetric across X by construction: every component either sits on the
	 * centre line or has an opposite number the same distance from the other wall.
	 */
	const symmetricHall: BuildProgram = {
		version: 1,
		meta: { name: 'Symmetric hall' },
		size: { x: 21, y: 17, z: 13 },
		palette: {
			foundation: 'minecraft:stone_bricks',
			wall_primary: 'minecraft:oak_planks',
			frame: 'minecraft:oak_log',
			roof_primary: 'minecraft:oak_stairs',
			window: 'minecraft:glass',
			light: 'minecraft:lantern',
		},
		components: [
			{ type: 'box', pos: ['min', 'min', 'min'], size: ['max', 1, 'max'], fill: { type: 'solid', role: 'foundation' } },
			{
				type: 'hollow_box',
				pos: ['min', 1, 'min'],
				size: ['max', 9, 'max'],
				wallThickness: 1,
				fill: { type: 'solid', role: 'wall_primary' },
			},
			// A mirrored pair of pillars, two in from each wall.
			{ type: 'box', pos: [2, 1, 2], size: [1, 9, 1], fill: { type: 'solid', role: 'frame' } },
			{ type: 'box', pos: ['max-2', 1, 2], size: [1, 9, 1], fill: { type: 'solid', role: 'frame' } },
			// A mirrored pair of buttresses that touch the wall they lean on.
			{ type: 'box', pos: [0, 1, 4], size: [2, 6, 2], fill: { type: 'solid', role: 'frame' } },
			{ type: 'box', pos: ['max-1', 1, 4], size: [2, 6, 2], fill: { type: 'solid', role: 'frame' } },
			// A column astride the centre line, so it has to stay astride it.
			{ type: 'box', pos: ['center-1', 1, 'center-1'], size: [3, 9, 3], fill: { type: 'solid', role: 'frame' } },
			{
				type: 'window_grid',
				face: 'south',
				region: { pos: ['min', 4, 'max'], size: ['max', 3, 1] },
				rows: 1,
				cols: 3,
				windowSize: [2, 2],
				margin: 2,
				role: 'window',
			},
			{
				type: 'gable_roof',
				pos: ['min', 10, 'min'],
				size: ['max', 7, 'max'],
				ridgeAxis: 'z',
				overhang: 1,
				roofRole: 'roof_primary',
			},
		],
		details: [
			{ op: 'set', at: [3, 6, 1], block: 'minecraft:lantern' },
			{ op: 'set', at: ['max-3', 6, 1], block: 'minecraft:lantern' },
		],
	};

	/**
	 * Cells that are filled on one side of the X centre line and empty on the other.
	 *
	 * The two middle columns of an even-width build do not count. A build an even number of
	 * blocks wide has no centre column at all, so anything the program put *astride* the centre
	 * line — this one's column — has to lean one block to one side of it once a shrink squeezes
	 * it down to a single block, and no arithmetic can make that symmetric. Every other column
	 * is expected to match its opposite number exactly, at every factor.
	 */
	function asymmetry(grid: VoxelGrid): number {
		const middle = grid.size.x % 2 === 0 ? [grid.size.x / 2 - 1, grid.size.x / 2] : [];
		let count = 0;
		for (let y = 0; y < grid.size.y; y++) {
			for (let z = 0; z < grid.size.z; z++) {
				for (let x = 0; x < grid.size.x; x++) {
					if (middle.includes(x)) continue;
					const here = grid.voxels[voxelIndex(grid.size, x, y, z)] !== 0;
					const there = grid.voxels[voxelIndex(grid.size, grid.size.x - 1 - x, y, z)] !== 0;
					if (here !== there) count++;
				}
			}
		}
		return count;
	}

	it('keeps a symmetric build symmetric at every factor', () => {
		for (const percent of FACTORS) {
			const result = expand({ ...symmetricHall, scale: at(percent) });
			expect(result.errors, `${percent}%`).toEqual([]);
			expect(asymmetry(result.grid), `${percent}% is lopsided`).toBe(0);
		}
	});

	it('centres a round tower as well as an odd number of blocks allows', () => {
		// A cylinder is always an odd number of blocks across — 2r+1 — so one drawn in a volume
		// an even number of blocks wide cannot sit exactly in the middle of it, whatever the
		// expander does. Within a block of centre is the whole of what is available here; being
		// three blocks off, which scaling the radius on its own could manage, is not.
		const program = withComponents(
			[{ type: 'cylinder', base: ['center', 0, 'center'], radius: 3, height: 1, fill: { type: 'solid', role: 'a' } }],
			{ size: { x: 21, y: 1, z: 21 } },
		);

		for (const percent of FACTORS) {
			const { grid } = expand({ ...program, scale: at(percent) });
			let lo = grid.size.x;
			let hi = -1;
			for (let x = 0; x < grid.size.x; x++) {
				if (blockAt(grid, x, 0, Math.floor(grid.size.z / 2)) === AIR_BLOCK) continue;
				lo = Math.min(lo, x);
				hi = Math.max(hi, x);
			}
			const offCentre = Math.abs(lo - (grid.size.x - 1 - hi));
			expect(offCentre, `${percent}% is ${offCentre} off centre`).toBeLessThanOrEqual(1);
		}
	});

	it('keeps a mirrored group landing on the wall it was mirrored onto', () => {
		// An even-width build: the reflection has to happen about the half-block between the
		// two middle columns, or the mirrored copy lands one short of the far wall.
		const program: BuildProgram = withComponents(
			[
				{
					type: 'group',
					transform: [{ op: 'mirror', axis: 'x' }],
					children: [{ type: 'box', pos: ['min', 0, 'min'], size: [1, 1, 1], fill: { type: 'solid', role: 'a' } }],
				},
			],
			{ size: { x: 10, y: 1, z: 1 } },
		);

		const { grid } = expand(program);
		expect(blockAt(grid, 9, 0, 0)).toBe('minecraft:stone');
	});

	it('never drops a wall that was anchored to the far edge', () => {
		// Below half scale the far corner used to round past the end of the volume, and the
		// component was not clipped a little — it disappeared.
		const program = withComponents(
			[
				{ type: 'box', pos: ['max', 'min', 'min'], size: [1, 1, 'max'], fill: { type: 'solid', role: 'a' } },
				{ type: 'box', pos: ['min', 'min', 'min'], size: [1, 1, 'max'], fill: { type: 'solid', role: 'a' } },
			],
			{ size: { x: 20, y: 1, z: 20 } },
		);

		for (const percent of FACTORS) {
			const { grid } = expand({ ...program, scale: at(percent) });
			expect(blockAt(grid, grid.size.x - 1, 0, 0), `far wall at ${percent}%`).toBe('minecraft:stone');
			expect(blockAt(grid, 0, 0, 0), `near wall at ${percent}%`).toBe('minecraft:stone');
		}
	});

	it('leaves no seam between two components that were flush against each other', () => {
		const program = withComponents(
			[
				{ type: 'box', pos: [0, 0, 0], size: [7, 1, 1], fill: { type: 'solid', role: 'a' } },
				{ type: 'box', pos: [7, 0, 0], size: [6, 1, 1], fill: { type: 'solid', role: 'b' } },
			],
			{ size: { x: 13, y: 1, z: 1 } },
		);

		for (const percent of FACTORS) {
			const { grid } = expand({ ...program, scale: at(percent) });
			for (let x = 0; x < grid.size.x; x++) {
				expect(blockAt(grid, x, 0, 0), `hole at ${x} at ${percent}%`).not.toBe(AIR_BLOCK);
			}
		}
	});

	it('scales an arch with the wall it is cut through', () => {
		// The opening is anchored to the wall's own corner, so it reaches all the way through
		// at every factor rather than stopping a block short and leaving a blind alcove.
		const program = withComponents(
			[
				{ type: 'box', pos: ['min', 'min', 4], size: ['max', 'max', 3], fill: { type: 'solid', role: 'a' } },
				{
					type: 'arch',
					pos: ['center-2', 'min', 4],
					width: 5,
					height: 6,
					depth: 3,
					axis: 'x',
					carve: true,
					fill: { type: 'solid', role: 'a' },
				},
			],
			{ size: { x: 15, y: 11, z: 11 } },
		);

		for (const percent of [50, 75, 150, 200]) {
			const { grid } = expand({ ...program, scale: at(percent) });
			const wallStart = Math.round((4 * grid.size.z) / 11);
			const middle = Math.floor(grid.size.x / 2);
			for (let z = wallStart; z < wallStart + 2; z++) {
				expect(blockAt(grid, middle, 1, z), `blocked at ${percent}% z=${z}`).toBe(AIR_BLOCK);
			}
		}
	});

	it('keeps a detail on the block it was placed against', () => {
		// A lantern hung on the top of a wall, at both ends of it. Scaling the wall by its
		// corners and the lantern by the plain factor is what used to sink one of the two into
		// the wall and float the other above it.
		const program = withComponents(
			[{ type: 'box', pos: ['min', 'min', 'min'], size: ['max', 5, 1], fill: { type: 'solid', role: 'a' } }],
			{
				size: { x: 15, y: 9, z: 1 },
				details: [
					{ op: 'set', at: [2, 5, 0], block: 'minecraft:lantern' },
					{ op: 'set', at: ['max-2', 5, 0], block: 'minecraft:lantern' },
				],
			},
		);

		for (const percent of FACTORS) {
			const { grid } = expand({ ...program, scale: at(percent) });
			const lanterns: number[] = [];
			for (let x = 0; x < grid.size.x; x++) {
				for (let y = 0; y < grid.size.y; y++) {
					if (blockAt(grid, x, y, 0).startsWith('minecraft:lantern')) lanterns.push(x);
				}
			}
			// Both of them, and the same distance in from each end.
			expect(lanterns.length, `${percent}%`).toBe(2);
			expect(lanterns[0], `${percent}%`).toBe(grid.size.x - 1 - lanterns[1]!);
		}
	});
});
