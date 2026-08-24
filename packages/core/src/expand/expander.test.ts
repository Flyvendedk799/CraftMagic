import { describe, expect, it } from 'vitest';
import { expand } from './expander.js';
import { cottage, pavilion, samples, tower } from '../samples/index.js';
import type { BuildProgram, VoxelGrid } from '../ir/types.js';
import { AIR_BLOCK, voxelIndex } from '../ir/types.js';

function blockAt(grid: VoxelGrid, x: number, y: number, z: number): string {
	return grid.palette[grid.voxels[voxelIndex(grid.size, x, y, z)]!]!;
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
