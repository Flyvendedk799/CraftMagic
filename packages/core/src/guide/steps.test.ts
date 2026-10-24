import { describe, expect, it } from 'vitest';
import { expand } from '../expand/expander.js';
import { cottage, samples } from '../samples/index.js';
import type { VoxelGrid } from '../ir/types.js';
import { voxelIndex } from '../ir/types.js';
import {
	MAX_BLOCKS_PER_STEP,
	MIN_BLOCKS_PER_STEP,
	buildGuide,
	calculateStepOrientation,
	classifyGlyphType,
	extractStepCallouts,
	isBlockOverhang,
	chunkGuideVolumes,
	MAX_STEPS_PER_VOLUME,
	type BuildStep,
	type StepBlock,
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

describe('classifyGlyphType & step callouts', () => {
	it('classifies all glyph types correctly', () => {
		expect(classifyGlyphType('minecraft:oak_stairs')).toBe('stairs');
		expect(classifyGlyphType('minecraft:stone_brick_stairs')).toBe('stairs');

		expect(classifyGlyphType('minecraft:smooth_stone_slab')).toBe('slab');
		expect(classifyGlyphType('minecraft:oak_slab')).toBe('slab');

		expect(classifyGlyphType('minecraft:oak_log')).toBe('pillar');
		expect(classifyGlyphType('minecraft:dark_oak_wood')).toBe('pillar');
		expect(classifyGlyphType('minecraft:crimson_stem')).toBe('pillar');
		expect(classifyGlyphType('minecraft:warped_hyphae')).toBe('pillar');
		expect(classifyGlyphType('minecraft:purpur_pillar')).toBe('pillar');
		expect(classifyGlyphType('minecraft:quartz_pillar')).toBe('pillar');

		expect(classifyGlyphType('minecraft:oak_trapdoor')).toBe('trapdoor');
		expect(classifyGlyphType('minecraft:iron_trapdoor')).toBe('trapdoor');

		expect(classifyGlyphType('minecraft:oak_door')).toBe('door');
		expect(classifyGlyphType('minecraft:iron_door')).toBe('door');

		expect(classifyGlyphType('minecraft:stone')).toBe('general');
		expect(classifyGlyphType('minecraft:oak_planks')).toBe('general');
		expect(classifyGlyphType('minecraft:glass')).toBe('general');
	});

	it('extracts callouts with glyphs, state properties, and correct counts', () => {
		const customPalette = [
			'minecraft:air',
			'minecraft:oak_stairs[facing=north,half=top]',
			'minecraft:oak_stairs[facing=south,half=bottom]',
			'minecraft:stone_slab[type=bottom]',
			'minecraft:oak_log[axis=y]',
			'minecraft:oak_planks',
		];
		const grid = gridFrom(
			[
				[
					'1112',
					'3345',
				],
			],
			customPalette,
		);
		const stepBlocks: StepBlock[] = [
			{ x: 0, y: 0, z: 0, paletteIndex: 1 },
			{ x: 1, y: 0, z: 0, paletteIndex: 1 },
			{ x: 2, y: 0, z: 0, paletteIndex: 1 },
			{ x: 3, y: 0, z: 0, paletteIndex: 2 },
			{ x: 0, y: 0, z: 1, paletteIndex: 3 },
			{ x: 1, y: 0, z: 1, paletteIndex: 3 },
			{ x: 2, y: 0, z: 1, paletteIndex: 4 },
			{ x: 3, y: 0, z: 1, paletteIndex: 5 },
		];

		const callouts = extractStepCallouts(grid, stepBlocks);
		expect(callouts).toHaveLength(5);

		// Highest count first: oak_stairs[facing=north,half=top] (count 3)
		expect(callouts[0]!.count).toBe(3);
		expect(callouts[0]!.baseId).toBe('minecraft:oak_stairs');
		expect(callouts[0]!.displayName).toBe('Oak Stairs');
		expect(callouts[0]!.glyphType).toBe('stairs');
		expect(callouts[0]!.states).toMatchObject({ facing: 'north', half: 'top' });

		// Second highest count: stone_slab (count 2)
		expect(callouts[1]!.count).toBe(2);
		expect(callouts[1]!.baseId).toBe('minecraft:stone_slab');
		expect(callouts[1]!.glyphType).toBe('slab');

		// Count 1 tiebreak: displayName then block ref ('Oak Log' < 'Oak Planks' < 'Oak Stairs')
		const countOne = callouts.slice(2);
		expect(countOne.map((c) => c.glyphType)).toEqual(['pillar', 'general', 'stairs']);
	});

	it('does not double count doors when upper half is placed', () => {
		const customPalette = [
			'minecraft:air',
			'minecraft:oak_door[facing=north,half=lower]',
			'minecraft:oak_door[facing=north,half=upper]',
		];
		const grid = gridFrom(
			[
				['1'],
				['2'],
			],
			customPalette,
		);
		const guide = buildGuide(grid);

		// Layer 0 has lower door
		expect(guide.steps[0]!.callouts).toHaveLength(1);
		expect(guide.steps[0]!.callouts[0]!.baseId).toBe('minecraft:oak_door');
		expect(guide.steps[0]!.callouts[0]!.count).toBe(1);
		expect(guide.steps[0]!.callouts[0]!.glyphType).toBe('door');

		// Layer 1 has upper door, should be skipped
		expect(guide.steps[1]!.callouts).toHaveLength(0);
	});

	it('populates callouts on every step in expand(cottage) guide', () => {
		const { grid } = expand(cottage);
		const guide = buildGuide(grid);
		for (const step of guide.steps) {
			expect(step.callouts).toBeDefined();
			expect(Array.isArray(step.callouts)).toBe(true);
			expect(step.callouts.length).toBeGreaterThan(0);
			for (const callout of step.callouts) {
				expect(callout.baseId).toBeTruthy();
				expect(callout.displayName).toBeTruthy();
				expect(callout.count).toBeGreaterThan(0);
				expect(callout.glyphType).toBeDefined();
			}
		}
	});
});

describe('calculateStepOrientation & camera occlusion detection', () => {
	it('defaults to SE when no blocks are previously placed', () => {
		const size = { x: 10, y: 10, z: 10 };
		const grid: VoxelGrid = { size, palette: PALETTE, voxels: new Uint16Array(1000) };
		const stepBlocks: StepBlock[] = [
			{ x: 3, y: 0, z: 3, paletteIndex: 1 },
			{ x: 4, y: 0, z: 3, paletteIndex: 1 },
		];
		const previouslyPlaced = new Set<number>();

		const result = calculateStepOrientation(grid, stepBlocks, previouslyPlaced);
		expect(result.orientation).toBe('SE');
		expect(result.isFlipped).toBe(false);
		expect(result.occlusionRatio).toBe(0);
	});

	it('retains SE when SE occlusion ratio is <= 30%', () => {
		const size = { x: 10, y: 10, z: 10 };
		const grid: VoxelGrid = { size, palette: PALETTE, voxels: new Uint16Array(1000) };
		// 4 blocks: 1 is occluded in SE, 3 are not (25% <= 30%)
		const stepBlocks: StepBlock[] = [
			{ x: 2, y: 1, z: 2, paletteIndex: 1 }, // occluded by (3, 2, 3)
			{ x: 8, y: 1, z: 8, paletteIndex: 1 },
			{ x: 8, y: 1, z: 7, paletteIndex: 1 },
			{ x: 7, y: 1, z: 8, paletteIndex: 1 },
		];
		const previouslyPlaced = new Set<number>([voxelIndex(size, 3, 2, 3)]);

		const result = calculateStepOrientation(grid, stepBlocks, previouslyPlaced);
		expect(result.orientation).toBe('SE');
		expect(result.isFlipped).toBe(false);
		expect(result.occlusionRatio).toBe(0.25);
	});

	it('auto-flips to optimal orientation when SE is occluded > 30% by an existing wall', () => {
		const size = { x: 10, y: 10, z: 10 };
		const grid: VoxelGrid = { size, palette: PALETTE, voxels: new Uint16Array(1000) };
		// Step blocks placed at (2, 1, 2)
		const stepBlocks: StepBlock[] = [
			{ x: 2, y: 1, z: 2, paletteIndex: 1 },
		];
		// Put an obstacle along the SE ray (+1, +1, +1): (3, 2, 3)
		// SW ray (-1, +1, +1) -> (1, 2, 3) is clear
		// NW ray (-1, +1, -1) -> (1, 2, 1) is clear
		// NE ray (+1, +1, -1) -> (3, 2, 1) is clear
		const previouslyPlaced = new Set<number>([voxelIndex(size, 3, 2, 3)]);

		const result = calculateStepOrientation(grid, stepBlocks, previouslyPlaced);
		// SE is 100% occluded (> 30%). SW is clear (0% occlusion) and first in tiebreak order.
		expect(result.orientation).toBe('SW');
		expect(result.isFlipped).toBe(true);
		expect(result.occlusionRatio).toBe(0);
	});

	it('auto-flips when same-layer walls placed earlier occlude > 30% of step blocks', () => {
		const size = { x: 10, y: 10, z: 10 };
		const grid: VoxelGrid = { size, palette: PALETTE, voxels: new Uint16Array(1000) };
		// Step blocks placed at (2, 1, 2)
		const stepBlocks: StepBlock[] = [
			{ x: 2, y: 1, z: 2, paletteIndex: 1 },
		];
		// Same-layer obstacle along SE ray (+1, 0, +1): (3, 1, 3)
		// SW ray (-1, 0, +1) -> (1, 1, 3) is clear
		// NW ray (-1, 0, -1) -> (1, 1, 1) is clear
		// NE ray (+1, 0, -1) -> (3, 1, 1) is clear
		const previouslyPlaced = new Set<number>([voxelIndex(size, 3, 1, 3)]);

		const result = calculateStepOrientation(grid, stepBlocks, previouslyPlaced);
		expect(result.orientation).toBe('SW');
		expect(result.isFlipped).toBe(true);
		expect(result.occlusionRatio).toBe(0);
	});

	it('breaks ties in order SE, SW, NW, NE when multiple orientations have minimum occlusion', () => {
		const size = { x: 10, y: 10, z: 10 };
		const grid: VoxelGrid = { size, palette: PALETTE, voxels: new Uint16Array(1000) };
		const stepBlocks: StepBlock[] = [{ x: 5, y: 2, z: 5, paletteIndex: 1 }];

		// Occlude SE (+1, +1, +1) -> (6, 3, 6)
		// and SW (-1, +1, +1) -> (4, 3, 6)
		// NW (-1, +1, -1) -> (4, 3, 4) is open
		// NE (+1, +1, -1) -> (6, 3, 4) is open
		// Tie between NW and NE: NW must win.
		const previouslyPlaced = new Set<number>([
			voxelIndex(size, 6, 3, 6),
			voxelIndex(size, 4, 3, 6),
		]);

		const result = calculateStepOrientation(grid, stepBlocks, previouslyPlaced);
		expect(result.orientation).toBe('NW');
		expect(result.isFlipped).toBe(true);
		expect(result.occlusionRatio).toBe(0);
	});

	it('retains SE with isFlipped false if all orientations are equally occluded', () => {
		const size = { x: 10, y: 10, z: 10 };
		const grid: VoxelGrid = { size, palette: PALETTE, voxels: new Uint16Array(1000) };
		const stepBlocks: StepBlock[] = [{ x: 5, y: 2, z: 5, paletteIndex: 1 }];

		// Occlude all 4 rays at t = 1
		const previouslyPlaced = new Set<number>([
			voxelIndex(size, 6, 3, 6), // SE
			voxelIndex(size, 4, 3, 6), // SW
			voxelIndex(size, 4, 3, 4), // NW
			voxelIndex(size, 6, 3, 4), // NE
		]);

		const result = calculateStepOrientation(grid, stepBlocks, previouslyPlaced);
		expect(result.orientation).toBe('SE');
		expect(result.isFlipped).toBe(false);
		expect(result.occlusionRatio).toBe(1);
	});

	it('handles empty stepBlocks gracefully', () => {
		const size = { x: 5, y: 5, z: 5 };
		const grid: VoxelGrid = { size, palette: PALETTE, voxels: new Uint16Array(125) };
		const result = calculateStepOrientation(grid, [], new Set());
		expect(result.orientation).toBe('SE');
		expect(result.isFlipped).toBe(false);
		expect(result.occlusionRatio).toBe(0);
	});

	it('assigns orientation and isFlipped to all steps in buildGuide', () => {
		const { grid } = expand(cottage);
		const guide = buildGuide(grid);
		for (const step of guide.steps) {
			expect(['SE', 'SW', 'NW', 'NE']).toContain(step.orientation);
			expect(typeof step.isFlipped).toBe('boolean');
		}
	});
});

describe('isBlockOverhang', () => {
	it('returns false when block is at y = 0', () => {
		const size = { x: 4, y: 4, z: 4 };
		const voxels = new Uint16Array(64);
		expect(isBlockOverhang(voxels, size, 1, 0, 1)).toBe(false);
		expect(isBlockOverhang(voxels, size, 0, 0, 0)).toBe(false);
	});

	it('returns true when block sits over air at y > 0', () => {
		const size = { x: 4, y: 4, z: 4 };
		const voxels = new Uint16Array(64);
		// (1, 1, 1) has a block, but (1, 0, 1) is air (0)
		voxels[voxelIndex(size, 1, 1, 1)] = 1;
		expect(isBlockOverhang(voxels, size, 1, 1, 1)).toBe(true);
	});

	it('returns false when block sits over a solid block at y > 0', () => {
		const size = { x: 4, y: 4, z: 4 };
		const voxels = new Uint16Array(64);
		// (1, 0, 1) is solid (1), (1, 1, 1) is solid (1)
		voxels[voxelIndex(size, 1, 0, 1)] = 1;
		voxels[voxelIndex(size, 1, 1, 1)] = 1;
		expect(isBlockOverhang(voxels, size, 1, 1, 1)).toBe(false);
	});
});

describe('chunkGuideVolumes', () => {
	it('returns empty array when steps array is empty', () => {
		expect(chunkGuideVolumes([])).toEqual([]);
	});

	it('creates a single volume when step count <= MAX_STEPS_PER_VOLUME', () => {
		const mockStep = (index: number): BuildStep => ({
			index,
			layer: 0,
			title: `Step ${index}`,
			parts: [],
			blocks: [],
			materials: [],
			callouts: [],
			orientation: 'SE',
			isFlipped: false,
		});

		const steps = Array.from({ length: 45 }, (_, i) => mockStep(i + 1));
		const volumes = chunkGuideVolumes(steps);

		expect(volumes).toHaveLength(1);
		expect(volumes[0]).toEqual({
			volumeIndex: 1,
			totalVolumes: 1,
			title: 'Volume 1: Steps 1–45',
			startStep: 1,
			endStep: 45,
			steps,
		});
	});

	it('splits large builds (>200 steps) into 200-step volumes without losing steps', () => {
		const mockStep = (index: number): BuildStep => ({
			index,
			layer: Math.floor(index / 10),
			title: `Step ${index}`,
			parts: [],
			blocks: [],
			materials: [],
			callouts: [],
			orientation: 'SE',
			isFlipped: false,
		});

		const steps = Array.from({ length: 450 }, (_, i) => mockStep(i + 1));
		const volumes = chunkGuideVolumes(steps);

		expect(volumes).toHaveLength(3);
		expect(volumes[0]!.volumeIndex).toBe(1);
		expect(volumes[0]!.totalVolumes).toBe(3);
		expect(volumes[0]!.title).toBe('Volume 1: Steps 1–200');
		expect(volumes[0]!.startStep).toBe(1);
		expect(volumes[0]!.endStep).toBe(200);
		expect(volumes[0]!.steps).toHaveLength(200);
		expect(volumes[0]!.steps[0]!.index).toBe(1);
		expect(volumes[0]!.steps[199]!.index).toBe(200);

		expect(volumes[1]!.volumeIndex).toBe(2);
		expect(volumes[1]!.totalVolumes).toBe(3);
		expect(volumes[1]!.title).toBe('Volume 2: Steps 201–400');
		expect(volumes[1]!.startStep).toBe(201);
		expect(volumes[1]!.endStep).toBe(400);
		expect(volumes[1]!.steps).toHaveLength(200);
		expect(volumes[1]!.steps[0]!.index).toBe(201);
		expect(volumes[1]!.steps[199]!.index).toBe(400);

		expect(volumes[2]!.volumeIndex).toBe(3);
		expect(volumes[2]!.totalVolumes).toBe(3);
		expect(volumes[2]!.title).toBe('Volume 3: Steps 401–450');
		expect(volumes[2]!.startStep).toBe(401);
		expect(volumes[2]!.endStep).toBe(450);
		expect(volumes[2]!.steps).toHaveLength(50);
		expect(volumes[2]!.steps[0]!.index).toBe(401);
		expect(volumes[2]!.steps[49]!.index).toBe(450);

		// Assert total steps across volumes matches original length
		const totalChunkedSteps = volumes.reduce((acc, v) => acc + v.steps.length, 0);
		expect(totalChunkedSteps).toBe(450);
	});

	it('respects custom maxPerVolume parameter', () => {
		const mockStep = (index: number): BuildStep => ({
			index,
			layer: 0,
			title: `Step ${index}`,
			parts: [],
			blocks: [],
			materials: [],
			callouts: [],
			orientation: 'SE',
			isFlipped: false,
		});

		const steps = Array.from({ length: 7 }, (_, i) => mockStep(i + 1));
		const volumes = chunkGuideVolumes(steps, 3);

		expect(volumes).toHaveLength(3);
		expect(volumes.map((v) => v.steps.length)).toEqual([3, 3, 1]);
		expect(volumes[0]!.title).toBe('Volume 1: Steps 1–3');
		expect(volumes[1]!.title).toBe('Volume 2: Steps 4–6');
		expect(volumes[2]!.title).toBe('Volume 3: Steps 7–7');
	});

	it('handles non-positive or non-finite maxPerVolume by defaulting to MAX_STEPS_PER_VOLUME', () => {
		const mockStep = (index: number): BuildStep => ({
			index,
			layer: 0,
			title: `Step ${index}`,
			parts: [],
			blocks: [],
			materials: [],
			callouts: [],
			orientation: 'SE',
			isFlipped: false,
		});

		const steps = Array.from({ length: 5 }, (_, i) => mockStep(i + 1));
		expect(chunkGuideVolumes(steps, 0)).toHaveLength(1);
		expect(chunkGuideVolumes(steps, 0)[0]!.title).toBe('Volume 1: Steps 1–5');

		expect(chunkGuideVolumes(steps, -1)).toHaveLength(1);
		expect(chunkGuideVolumes(steps, -1)[0]!.title).toBe('Volume 1: Steps 1–5');

		expect(chunkGuideVolumes(steps, Number.NaN)).toHaveLength(1);
		expect(chunkGuideVolumes(steps, Number.NaN)[0]!.title).toBe('Volume 1: Steps 1–5');
	});
});
