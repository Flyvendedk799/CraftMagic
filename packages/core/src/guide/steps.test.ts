import { describe, expect, it } from 'vitest';
import { expand } from '../expand/expander.js';
import { cottage, samples } from '../samples/index.js';
import type { VoxelGrid } from '../ir/types.js';
import { voxelIndex } from '../ir/types.js';
import { MAX_BLOCKS_PER_STEP, buildGuide } from './steps.js';

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
