import { describe, expect, it } from 'vitest';
import { expand } from '../expand/expander.js';
import { cottage, samples } from '../samples/index.js';
import type { VoxelGrid } from '../ir/types.js';
import { voxelIndex } from '../ir/types.js';
import {
	MAX_BLOCKS_PER_STEP,
	MIN_BLOCKS_PER_STEP,
	buildGuide,
	buildTrayItems,
	calculateCameraOcclusion,
	calculateOptimalOrientation,
	extractBlockstateGlyph,
	isOverhangBlock,
	CAMERA_ORIENTATIONS,
	CAMERA_RAY_DIRECTIONS,
} from './steps.js';

/** Build a grid from a per-layer ASCII map, '.' meaning air. */
function gridFrom(layers: string[][], palette: string[]): VoxelGrid {
	const height = layers.length;
	const depth = layers[0]!.length;
	const width = layers[0]![0]!.length;
	const size = { x: width, y: height, z: depth };
	const voxels = new Uint16Array(width * height * depth);
	for (let y = 0; y < height; y++) {
		for (let z = 0; z < depth; z++) {
			for (let x = 0; x < width; x++) {
				const ch = layers[y]![z]![x]!;
				if (ch !== '.') voxels[voxelIndex(size, x, y, z)] = Number.parseInt(ch, 10);
			}
		}
	}
	return { size, palette, voxels };
}

const PALETTE = ['minecraft:air', 'minecraft:stone', 'minecraft:oak_planks'];

describe('buildGuide — ordering', () => {
	it('goes bottom-up so nothing is placed under finished work', () => {
		const grid = gridFrom([['11', '11'], ['11', '11'], ['11', '11']], PALETTE);
		const guide = buildGuide(grid);
		expect(guide.steps.map((s) => s.layer)).toEqual([0, 1, 2]);
	});

	it('skips empty layers rather than emitting blank steps', () => {
		const grid = gridFrom([['11'], ['..'], ['11']], PALETTE);
		const guide = buildGuide(grid);
		expect(guide.steps).toHaveLength(2);
		expect(guide.steps.map((s) => s.layer)).toEqual([0, 2]);
	});

	it('numbers steps consecutively from 1', () => {
		const guide = buildGuide(expand(cottage).grid, 'Cottage');
		expect(guide.steps.map((s) => s.index)).toEqual(guide.steps.map((_, i) => i + 1));
	});
});

describe('buildGuide — segmentation', () => {
	it('keeps a small layer as a single step', () => {
		const grid = gridFrom([['111', '111', '111']], PALETTE);
		const guide = buildGuide(grid);
		expect(guide.steps).toHaveLength(1);
		expect(guide.steps[0]!.partOfLayer).toBeUndefined();
	});

	it('never exceeds the per-step cap', () => {
		const guide = buildGuide(expand(cottage).grid);
		for (const step of guide.steps) {
			expect(step.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS_PER_STEP);
		}
	});

	it('splits a busy layer and labels the parts', () => {
		// A solid 12x12 layer is 144 blocks, well past the cap.
		const row = '1'.repeat(12);
		const grid = gridFrom([Array.from({ length: 12 }, () => row)], PALETTE);
		const guide = buildGuide(grid);
		expect(guide.steps.length).toBeGreaterThan(1);
		expect(guide.steps[0]!.partOfLayer).toEqual({ part: 1, total: guide.steps.length });
	});

	it('separates disconnected regions into their own steps', () => {
		// Two 5x5 pads separated by a gap: 25 blocks each, so neither hits the cap, but
		// they must not be combined into one confusing step.
		const layer = [
			'11111.....11111',
			'11111.....11111',
			'11111.....11111',
			'11111.....11111',
			'11111.....11111',
		];
		const grid = gridFrom([layer], PALETTE);
		const guide = buildGuide(grid);
		expect(guide.steps).toHaveLength(2);
		// The west pad comes first.
		expect(Math.min(...guide.steps[0]!.blocks.map((b) => b.x))).toBe(0);
		expect(Math.min(...guide.steps[1]!.blocks.map((b) => b.x))).toBe(10);
	});

	it('folds a sliver into the previous step instead of emitting a 2-block step', () => {
		// A 6x6 pad (36) plus a detached 2-block nub: the nub alone is below the minimum,
		// and 36 + 2 still fits under the cap.
		const layer = [
			'111111..11',
			'111111....',
			'111111....',
			'111111....',
			'111111....',
			'111111....',
		];
		const grid = gridFrom([layer], PALETTE);
		const guide = buildGuide(grid);
		expect(guide.steps).toHaveLength(1);
		expect(guide.steps[0]!.blocks).toHaveLength(38);
	});

	it('keeps every block exactly once across all steps', () => {
		for (const [name, program] of Object.entries(samples)) {
			const { grid, blockCount } = expand(program);
			const guide = buildGuide(grid, name);
			const placed = guide.steps.reduce((sum, s) => sum + s.blocks.length, 0);
			expect(placed, name).toBe(blockCount);

			const seen = new Set<string>();
			for (const step of guide.steps) {
				for (const b of step.blocks) {
					const key = `${b.x},${b.y},${b.z}`;
					expect(seen.has(key), `${name} duplicated ${key}`).toBe(false);
					seen.add(key);
				}
			}
		}
	});

	it('is deterministic', () => {
		const { grid } = expand(cottage);
		const a = buildGuide(grid);
		const b = buildGuide(grid);
		expect(JSON.stringify(a.steps)).toBe(JSON.stringify(b.steps));
	});
});

describe('buildGuide — bill of materials', () => {
	it('counts the whole build, most-used first', () => {
		const grid = gridFrom([['112', '111', '111']], PALETTE);
		const guide = buildGuide(grid);
		expect(guide.materials[0]).toMatchObject({ block: 'minecraft:stone', count: 8 });
		expect(guide.materials[1]).toMatchObject({ block: 'minecraft:oak_planks', count: 1 });
	});

	it('reports stacks alongside raw counts, since that is how you gather them', () => {
		const row = '1'.repeat(10);
		const grid = gridFrom([Array.from({ length: 10 }, () => row)], PALETTE);
		const guide = buildGuide(grid);
		expect(guide.materials[0]).toMatchObject({ count: 100, stacks: 1, remainder: 36 });
	});

	it('collapses blockstates to one item entry', () => {
		// The cottage roof uses stairs facing both ways; a shopping list must name that
		// item once, not once per facing. Matched by shape rather than wood species so
		// re-skinning the sample's palette does not break the assertion.
		const guide = buildGuide(expand(cottage).grid);
		const stairs = guide.materials.filter((m) => m.block.endsWith('_stairs'));
		expect(stairs).toHaveLength(1);
		expect(stairs[0]!.count).toBeGreaterThan(100);
	});

	it('counts a door once, not once per half', () => {
		// A door is two blocks but one item. Counting both halves would send the player
		// off to craft twice as many doors as the build needs.
		const guide = buildGuide(expand(cottage).grid);
		const doors = guide.materials.filter((m) => m.block.endsWith('_door'));
		expect(doors).toHaveLength(1);
		expect(doors[0]!.count).toBe(1);
	});

	it('uses readable names', () => {
		const guide = buildGuide(expand(cottage).grid);
		expect(guide.materials.map((m) => m.displayName)).toContain('Oak Planks');
	});

	it('totals match the sum of the per-step materials', () => {
		const guide = buildGuide(expand(cottage).grid);
		const perStep = new Map<string, number>();
		for (const step of guide.steps) {
			for (const m of step.materials) perStep.set(m.block, (perStep.get(m.block) ?? 0) + m.count);
		}
		for (const total of guide.materials) {
			expect(perStep.get(total.block), total.block).toBe(total.count);
		}
	});
});

describe('buildGuide — parts', () => {
	/** A guide over a sample, with the provenance the expander can now supply. */
	function guided(program: (typeof samples)[keyof typeof samples], name: string) {
		const result = expand(program, { provenance: true });
		return {
			result,
			guide: buildGuide(result.grid, name, { parts: result.parts, origin: result.origin }),
		};
	}

	it('names every step when provenance is available', () => {
		const { guide } = guided(cottage, 'Cottage');
		for (const step of guide.steps) {
			expect(step.title, `step ${step.index}`).toBeTruthy();
			expect(step.title).not.toMatch(/^Layer /);
			expect(step.parts.length).toBeGreaterThan(0);
		}
	});

	it('falls back to the layer when nothing owns the blocks', () => {
		const grid = gridFrom([['11', '11']], PALETTE);
		const guide = buildGuide(grid);
		expect(guide.steps[0]!.title).toBe('Layer 0');
		expect(guide.steps[0]!.parts).toEqual([]);
		expect(guide.parts).toEqual([]);
	});

	it('keeps a split step to a single part', () => {
		const { guide } = guided(cottage, 'Cottage');
		// A step may still gather more than one part when a part is too slight in that layer
		// to be worth a page of its own — but never a second *substantial* one.
		for (const step of guide.steps) {
			const substantial = step.parts.filter((p) => p.blocks >= MIN_BLOCKS_PER_STEP);
			expect(substantial.length, `step ${step.index}: ${step.title}`).toBeLessThanOrEqual(1);
		}
	});

	it('names a step after the part it mostly places', () => {
		const { guide } = guided(cottage, 'Cottage');
		for (const step of guide.steps) {
			if (step.parts.length === 0) continue;
			const most = Math.max(...step.parts.map((p) => p.blocks));
			expect(step.parts[0]!.blocks).toBe(most);
			expect(step.title).toBe(step.parts[0]!.label);
		}
	});

	it('accounts for every block exactly once, parts or no parts', () => {
		for (const [name, program] of Object.entries(samples)) {
			const { result, guide } = guided(program, name);
			const placed = guide.steps.reduce((sum, s) => sum + s.blocks.length, 0);
			expect(placed, name).toBe(result.blockCount);

			const seen = new Set<string>();
			for (const step of guide.steps) {
				for (const b of step.blocks) {
					const key = `${b.x},${b.y},${b.z}`;
					expect(seen.has(key), `${name} duplicated ${key}`).toBe(false);
					seen.add(key);
				}
			}
		}
	});

	it('still never exceeds the per-step cap', () => {
		for (const [name, program] of Object.entries(samples)) {
			const { guide } = guided(program, name);
			for (const step of guide.steps) {
				expect(step.blocks.length, `${name} step ${step.index}`).toBeLessThanOrEqual(
					MAX_BLOCKS_PER_STEP,
				);
			}
		}
	});

	it('slices evenly, so a big layer leaves no one-block remainder behind', () => {
		// 361 blocks greedily chunked is nine steps of 40 and one of 1 — and that last step
		// can never be folded away, because the step before it is already full.
		const { guide } = guided(samples.pavilion!, 'Pavilion');
		const layerZero = guide.steps.filter((step) => step.layer === 0);
		expect(layerZero.length).toBeGreaterThan(1);
		for (const step of layerZero) {
			expect(step.blocks.length).toBeGreaterThanOrEqual(MIN_BLOCKS_PER_STEP);
		}
	});

	it('reports a bill of parts that adds up to the build', () => {
		const { result, guide } = guided(cottage, 'Cottage');
		expect(guide.parts.length).toBeGreaterThan(0);
		expect(guide.parts.reduce((sum, p) => sum + p.blocks, 0)).toBe(result.blockCount);
		expect(new Set(guide.parts.map((p) => p.label)).size).toBe(guide.parts.length);
	});

	it('is deterministic with provenance too', () => {
		const a = guided(cottage, 'Cottage').guide;
		const b = guided(cottage, 'Cottage').guide;
		expect(JSON.stringify(a.steps)).toBe(JSON.stringify(b.steps));
		expect(JSON.stringify(a.parts)).toBe(JSON.stringify(b.parts));
	});

	it('ignores half a pair, rather than titling steps after parts it cannot describe', () => {
		const { result } = guided(cottage, 'Cottage');
		// Origin without parts, or parts without origin, is a caller bug; the guide must not
		// produce steps referring to ids it has no labels for.
		const noParts = buildGuide(result.grid, 'Cottage', { origin: result.origin });
		const noOrigin = buildGuide(result.grid, 'Cottage', { parts: result.parts });
		for (const guide of [noParts, noOrigin]) {
			expect(guide.parts).toEqual([]);
			for (const step of guide.steps) expect(step.parts).toEqual([]);
		}
	});
});

describe('buildGuide — summary', () => {
	it('rates difficulty from the step count', () => {
		const tiny = buildGuide(gridFrom([['11']], PALETTE));
		expect(tiny.difficulty).toBe('simple');
		expect(buildGuide(expand(cottage).grid).difficulty).not.toBe('simple');
	});

	it('reports total blocks and dimensions', () => {
		const { grid, blockCount } = expand(cottage);
		const guide = buildGuide(grid, 'Oak Cottage');
		expect(guide.name).toBe('Oak Cottage');
		expect(guide.totalBlocks).toBe(blockCount);
		expect(guide.size).toEqual(grid.size);
	});
});

describe('buildGuide — overhang detection', () => {
	it('marks all blocks at y=0 as supported (isOverhang = false)', () => {
		const grid = gridFrom([['11', '11']], PALETTE);
		const guide = buildGuide(grid);
		expect(guide.steps).toHaveLength(1);
		const step = guide.steps[0]!;
		expect(step.hasOverhangs).toBe(false);
		expect(step.overhangCount).toBe(0);
		for (const b of step.blocks) {
			expect(b.isOverhang).toBe(false);
		}
	});

	it('identifies overhangs when y > 0 is placed directly over air', () => {
		// Layer 0: solid 1x1 at (0, 0, 0)
		// Layer 1: 2x1 at (0, 1, 0) and (1, 1, 0).
		// Block at (0, 1, 0) is supported; block at (1, 1, 0) is overhang over air.
		const layer0 = ['1.'];
		const layer1 = ['11'];
		const grid = gridFrom([layer0, layer1], PALETTE);
		const guide = buildGuide(grid);
		expect(guide.steps).toHaveLength(2);

		const step1 = guide.steps[1]!;
		expect(step1.layer).toBe(1);
		expect(step1.hasOverhangs).toBe(true);
		expect(step1.overhangCount).toBe(1);

		const supported = step1.blocks.find((b) => b.x === 0 && b.z === 0)!;
		const overhang = step1.blocks.find((b) => b.x === 1 && b.z === 0)!;
		expect(supported.isOverhang).toBe(false);
		expect(overhang.isOverhang).toBe(true);
	});

	it('marks blocks at y > 0 as not overhang when supported by solid beneath', () => {
		const layer0 = ['11'];
		const layer1 = ['11'];
		const grid = gridFrom([layer0, layer1], PALETTE);
		const guide = buildGuide(grid);
		const step1 = guide.steps[1]!;
		expect(step1.hasOverhangs).toBe(false);
		expect(step1.overhangCount).toBe(0);
		expect(step1.blocks.every((b) => b.isOverhang === false)).toBe(true);
	});

	it('calculates isOverhangBlock utility accurately', () => {
		const grid = gridFrom([['1.'], ['.1']], PALETTE);
		expect(isOverhangBlock(grid, 0, 0, 0)).toBe(false);
		expect(isOverhangBlock(grid, 1, 0, 0)).toBe(false);
		// At y = 1: (1, 1, 0) has '.' (air) beneath at (1, 0, 0) -> overhang
		expect(isOverhangBlock(grid, 1, 1, 0)).toBe(true);
		// At y = 1: (0, 1, 0) has '1' (stone) beneath at (0, 0, 0) -> not overhang
		expect(isOverhangBlock(grid, 0, 1, 0)).toBe(false);
	});
});

describe('blockstate glyphs & tray items', () => {
	describe('extractBlockstateGlyph', () => {
		it('extracts stairs glyph with facing, half, and shape', () => {
			const glyph = extractBlockstateGlyph('minecraft:oak_stairs', {
				facing: 'east',
				half: 'bottom',
				shape: 'straight',
			});
			expect(glyph).toEqual({
				kind: 'stairs',
				facing: 'east',
				half: 'bottom',
				shape: 'straight',
			});
		});

		it('parses stairs glyph from bracketed reference', () => {
			const glyph = extractBlockstateGlyph(
				'minecraft:dark_oak_stairs[facing=north,half=top,shape=inner_left]',
			);
			expect(glyph).toEqual({
				kind: 'stairs',
				facing: 'north',
				half: 'top',
				shape: 'inner_left',
			});
		});

		it('extracts slab glyph with top or bottom half', () => {
			expect(extractBlockstateGlyph('minecraft:stone_slab', { type: 'top' })).toEqual({
				kind: 'slab',
				half: 'top',
			});
			expect(extractBlockstateGlyph('minecraft:oak_slab', { type: 'bottom' })).toEqual({
				kind: 'slab',
				half: 'bottom',
			});
			expect(extractBlockstateGlyph('minecraft:oak_slab', { type: 'double' })).toEqual({
				kind: 'slab',
			});
			expect(extractBlockstateGlyph('minecraft:oak_slab', { half: 'top' })).toEqual({
				kind: 'slab',
				half: 'top',
			});
		});

		it('extracts pillar glyph for logs, woods, basalt, pillars and explicit axis', () => {
			expect(extractBlockstateGlyph('minecraft:oak_log', { axis: 'x' })).toEqual({
				kind: 'pillar',
				axis: 'x',
			});
			expect(extractBlockstateGlyph('minecraft:stripped_dark_oak_wood', { axis: 'z' })).toEqual({
				kind: 'pillar',
				axis: 'z',
			});
			expect(extractBlockstateGlyph('minecraft:crimson_stem', {})).toEqual({
				kind: 'pillar',
				axis: 'y',
			});
			expect(extractBlockstateGlyph('minecraft:warped_hyphae', {})).toEqual({
				kind: 'pillar',
				axis: 'y',
			});
			expect(extractBlockstateGlyph('minecraft:basalt', {})).toEqual({
				kind: 'pillar',
				axis: 'y',
			});
			expect(extractBlockstateGlyph('minecraft:quartz_pillar', { axis: 'y' })).toEqual({
				kind: 'pillar',
				axis: 'y',
			});
			expect(extractBlockstateGlyph('minecraft:bone_block', { axis: 'x' })).toEqual({
				kind: 'pillar',
				axis: 'x',
			});
		});

		it('extracts door glyph with facing and half', () => {
			const glyph = extractBlockstateGlyph('minecraft:oak_door', {
				facing: 'south',
				half: 'lower',
			});
			expect(glyph).toEqual({
				kind: 'door',
				facing: 'south',
				half: 'lower',
			});
		});

		it('extracts trapdoor glyph with facing and half', () => {
			const glyph = extractBlockstateGlyph('minecraft:oak_trapdoor', {
				facing: 'west',
				half: 'top',
			});
			expect(glyph).toEqual({
				kind: 'trapdoor',
				facing: 'west',
				half: 'top',
			});
		});

		it('returns generic for regular blocks', () => {
			expect(extractBlockstateGlyph('minecraft:stone', {})).toEqual({ kind: 'generic' });
			expect(extractBlockstateGlyph('minecraft:glass', {})).toEqual({ kind: 'generic' });
		});
	});

	describe('buildTrayItems', () => {
		it('groups blocks by distinct blockstate and sorts by count descending', () => {
			const palette = [
				'minecraft:air',
				'minecraft:oak_stairs[facing=east,half=bottom,shape=straight]',
				'minecraft:oak_stairs[facing=west,half=bottom,shape=straight]',
				'minecraft:oak_planks',
			];
			const blocks = [
				{ x: 0, y: 0, z: 0, paletteIndex: 1 },
				{ x: 1, y: 0, z: 0, paletteIndex: 1 },
				{ x: 2, y: 0, z: 0, paletteIndex: 1 },
				{ x: 3, y: 0, z: 0, paletteIndex: 2 },
				{ x: 4, y: 0, z: 0, paletteIndex: 3 },
				{ x: 5, y: 0, z: 0, paletteIndex: 3 },
				{ x: 6, y: 0, z: 0, paletteIndex: 3 },
				{ x: 7, y: 0, z: 0, paletteIndex: 3 },
			];
			const grid: VoxelGrid = {
				size: { x: 8, y: 1, z: 1 },
				palette,
				voxels: new Uint16Array(8),
			};

			const tray = buildTrayItems(grid, blocks);
			expect(tray).toHaveLength(3);

			// Planks has highest count (4)
			expect(tray[0]).toMatchObject({
				block: 'minecraft:oak_planks',
				displayName: 'Oak Planks',
				count: 4,
				canonicalRef: 'minecraft:oak_planks',
				glyph: { kind: 'generic' },
			});

			// Oak stairs east (3)
			expect(tray[1]).toMatchObject({
				block: 'minecraft:oak_stairs',
				displayName: 'Oak Stairs',
				count: 3,
				canonicalRef: 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight]',
				glyph: {
					kind: 'stairs',
					facing: 'east',
					half: 'bottom',
					shape: 'straight',
				},
			});

			// Oak stairs west (1)
			expect(tray[2]).toMatchObject({
				block: 'minecraft:oak_stairs',
				displayName: 'Oak Stairs',
				count: 1,
				canonicalRef: 'minecraft:oak_stairs[facing=west,half=bottom,shape=straight]',
				glyph: {
					kind: 'stairs',
					facing: 'west',
					half: 'bottom',
					shape: 'straight',
				},
			});
		});

		it('breaks ties deterministically using canonicalRef', () => {
			const palette = [
				'minecraft:air',
				'minecraft:spruce_planks',
				'minecraft:oak_planks',
			];
			const blocks = [
				{ x: 0, y: 0, z: 0, paletteIndex: 1 },
				{ x: 1, y: 0, z: 0, paletteIndex: 2 },
			];
			const grid: VoxelGrid = {
				size: { x: 2, y: 1, z: 1 },
				palette,
				voxels: new Uint16Array(2),
			};

			const tray = buildTrayItems(grid, blocks);
			expect(tray).toHaveLength(2);
			expect(tray[0]!.canonicalRef).toBe('minecraft:oak_planks');
			expect(tray[1]!.canonicalRef).toBe('minecraft:spruce_planks');
		});
	});
});

describe('camera occlusion & optimal orientation', () => {
	it('verifies camera ray directions for all 4 viewpoints', () => {
		expect(CAMERA_RAY_DIRECTIONS.SE).toEqual({ dx: 1, dy: 1, dz: 1 });
		expect(CAMERA_RAY_DIRECTIONS.SW).toEqual({ dx: -1, dy: 1, dz: 1 });
		expect(CAMERA_RAY_DIRECTIONS.NW).toEqual({ dx: -1, dy: 1, dz: -1 });
		expect(CAMERA_RAY_DIRECTIONS.NE).toEqual({ dx: 1, dy: 1, dz: -1 });
		expect(CAMERA_ORIENTATIONS).toEqual(['SE', 'SW', 'NW', 'NE']);
	});

	it('calculates occlusion when earlier voxels lie along line of sight', () => {
		const size = { x: 10, y: 10, z: 10 };
		const blocks = [{ x: 2, y: 2, z: 2 }];

		// Place occluder at (3, 3, 3) in SE line of sight from (2, 2, 2)
		const occupied = (x: number, y: number, z: number) => x === 3 && y === 3 && z === 3;
		const occlusion = calculateCameraOcclusion(blocks, size, occupied);

		expect(occlusion.SE.occludedCount).toBe(1);
		expect(occlusion.SE.ratio).toBe(1);
		expect(occlusion.SW.occludedCount).toBe(0);
		expect(occlusion.SW.ratio).toBe(0);
		expect(occlusion.NW.occludedCount).toBe(0);
		expect(occlusion.NW.ratio).toBe(0);
		expect(occlusion.NE.occludedCount).toBe(0);
		expect(occlusion.NE.ratio).toBe(0);
	});

	it('picks orientation with minimal occlusion ratio', () => {
		const size = { x: 10, y: 10, z: 10 };
		const blocks = [{ x: 2, y: 2, z: 2 }];

		// Occlude SE at (3, 3, 3)
		const earlierPlaced = new Set(['3,3,3']);
		const orientation = calculateOptimalOrientation(blocks, size, earlierPlaced);
		// SE is occluded, next default in priority is SW
		expect(orientation).toBe('SW');
	});

	it('defaults to SE when all orientations are tied and no face is specified', () => {
		const size = { x: 10, y: 10, z: 10 };
		const blocks = [{ x: 2, y: 2, z: 2 }];
		const orientation = calculateOptimalOrientation(blocks, size);
		expect(orientation).toBe('SE');
	});

	it('applies face preference to break ties', () => {
		const size = { x: 10, y: 10, z: 10 };
		const blocks = [{ x: 2, y: 2, z: 2 }];

		// North face prefers NW
		expect(calculateOptimalOrientation(blocks, size, undefined, 'north')).toBe('NW');
		// South face prefers SE
		expect(calculateOptimalOrientation(blocks, size, undefined, 'south')).toBe('SE');
		// West face prefers SW
		expect(calculateOptimalOrientation(blocks, size, undefined, 'west')).toBe('SW');
		// East face prefers SE
		expect(calculateOptimalOrientation(blocks, size, undefined, 'east')).toBe('SE');
	});

	it('prefers unoccluded view over face preference when preferred view is blocked', () => {
		const size = { x: 10, y: 10, z: 10 };
		const blocks = [{ x: 2, y: 2, z: 2 }];

		// North face prefers NW/NE. If NW is occluded at (1, 3, 1), NE should be chosen!
		const earlierPlaced = new Set(['1,3,1']);
		expect(calculateOptimalOrientation(blocks, size, earlierPlaced, 'north')).toBe('NE');

		// If both NW and NE are occluded (1, 3, 1) and (3, 3, 1), it falls back to unoccluded orientation
		const bothNorthOccluded = new Set(['1,3,1', '3,3,1']);
		const fallback = calculateOptimalOrientation(blocks, size, bothNorthOccluded, 'north');
		expect(fallback === 'SE' || fallback === 'SW').toBe(true);
	});

	it('populates optimalOrientation and trayItems on every step of a guide', () => {
		const guide = buildGuide(expand(cottage).grid, 'Cottage');
		expect(guide.steps.length).toBeGreaterThan(0);
		for (const step of guide.steps) {
			expect(CAMERA_ORIENTATIONS).toContain(step.optimalOrientation);
			expect(Array.isArray(step.trayItems)).toBe(true);
			expect(typeof step.hasOverhangs).toBe('boolean');
			expect(typeof step.overhangCount).toBe('number');
			expect(step.overhangCount).toBeGreaterThanOrEqual(0);
			for (const item of step.trayItems) {
				expect(item.block).toBeTruthy();
				expect(item.displayName).toBeTruthy();
				expect(item.count).toBeGreaterThan(0);
				expect(item.canonicalRef).toBeTruthy();
				expect(item.glyph).toBeDefined();
				expect(item.glyph.kind).toBeTruthy();
			}
		}
	});
});
