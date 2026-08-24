/**
 * Turns a finished build into LEGO-style assembly instructions.
 *
 * The rules are fixed rather than per-build, so every guide reads the same way:
 *
 *  1. Build strictly bottom-up — you can always reach what you are placing.
 *  2. A layer of at most `MAX_BLOCKS_PER_STEP` new blocks is one step.
 *  3. A busier layer splits into *connected regions* first, because "finish this wall, then
 *     that pillar" is far easier to follow than "place these 40 scattered blocks".
 *  4. A region still too large is sliced along its longer axis, so a slice stays a
 *     contiguous run rather than a scatter.
 *  5. Slivers are folded into the previous step; a step that places three blocks is noise.
 *
 * Everything here is deterministic — the same build always yields the same numbered steps,
 * which matters when someone is following a printed copy.
 */

import type { VoxelGrid } from '../ir/types.js';
import { AIR_INDEX, voxelIndex } from '../ir/types.js';
import { displayName, parseBlockRef } from '../registry/registry.js';

export const MAX_BLOCKS_PER_STEP = 40;
/** Below this, a step is not worth its own page; it merges into the previous one. */
export const MIN_BLOCKS_PER_STEP = 6;
const STACK_SIZE = 64;

export interface StepBlock {
	x: number;
	y: number;
	z: number;
	paletteIndex: number;
}

export interface BuildStep {
	/** 1-based, for "Step 7 of 42". */
	index: number;
	layer: number;
	/** Set when a layer needed more than one step, e.g. 2 of 3. */
	partOfLayer?: { part: number; total: number };
	blocks: StepBlock[];
	/** Per-blockstate counts for this step alone. */
	materials: MaterialCount[];
}

export interface MaterialCount {
	block: string;
	displayName: string;
	count: number;
	stacks: number;
	remainder: number;
}

export type Difficulty = 'simple' | 'moderate' | 'complex' | 'epic';

export interface BuildGuide {
	name: string;
	size: VoxelGrid['size'];
	totalBlocks: number;
	steps: BuildStep[];
	/** Whole-build bill of materials, most-used first. */
	materials: MaterialCount[];
	difficulty: Difficulty;
}

interface Cell {
	x: number;
	z: number;
	paletteIndex: number;
}

export function buildGuide(grid: VoxelGrid, name = 'Build'): BuildGuide {
	const steps: BuildStep[] = [];
	let totalBlocks = 0;

	for (let y = 0; y < grid.size.y; y++) {
		const cells = layerCells(grid, y);
		if (cells.length === 0) continue;
		totalBlocks += cells.length;

		const groups = segmentLayer(cells);
		groups.forEach((group, part) => {
			steps.push({
				index: steps.length + 1,
				layer: y,
				...(groups.length > 1 ? { partOfLayer: { part: part + 1, total: groups.length } } : {}),
				blocks: group.map((c) => ({ x: c.x, y, z: c.z, paletteIndex: c.paletteIndex })),
				materials: countMaterials(grid, group.map((c) => c.paletteIndex)),
			});
		});
	}

	return {
		name,
		size: grid.size,
		totalBlocks,
		steps,
		materials: countMaterials(grid, allIndices(grid)),
		difficulty: difficultyFor(steps.length),
	};
}

function layerCells(grid: VoxelGrid, y: number): Cell[] {
	const cells: Cell[] = [];
	for (let z = 0; z < grid.size.z; z++) {
		for (let x = 0; x < grid.size.x; x++) {
			const paletteIndex = grid.voxels[voxelIndex(grid.size, x, y, z)]!;
			if (paletteIndex !== AIR_INDEX) cells.push({ x, z, paletteIndex });
		}
	}
	return cells;
}

/** Split one layer's cells into follow-able steps. */
function segmentLayer(cells: Cell[]): Cell[][] {
	if (cells.length <= MAX_BLOCKS_PER_STEP) return [cells];

	const regions = connectedRegions(cells);
	const groups: Cell[][] = [];
	for (const region of regions) {
		if (region.length <= MAX_BLOCKS_PER_STEP) {
			groups.push(region);
			continue;
		}
		groups.push(...sliceRegion(region));
	}

	return mergeSlivers(groups);
}

/**
 * 4-connected regions within the layer.
 *
 * Ordered by the south-west-most cell so numbering is stable across runs — an unordered
 * `Map` iteration would renumber the steps whenever the palette changed.
 */
function connectedRegions(cells: Cell[]): Cell[][] {
	const key = (x: number, z: number) => `${x},${z}`;
	const remaining = new Map<string, Cell>();
	for (const cell of cells) remaining.set(key(cell.x, cell.z), cell);

	const regions: Cell[][] = [];
	// Iterate the original order (z-major, then x) so seeds are picked deterministically.
	for (const seed of cells) {
		const seedKey = key(seed.x, seed.z);
		if (!remaining.has(seedKey)) continue;

		const region: Cell[] = [];
		const stack = [seed];
		remaining.delete(seedKey);

		while (stack.length > 0) {
			const cell = stack.pop()!;
			region.push(cell);
			for (const [dx, dz] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			] as const) {
				const neighbourKey = key(cell.x + dx, cell.z + dz);
				const neighbour = remaining.get(neighbourKey);
				if (neighbour) {
					remaining.delete(neighbourKey);
					stack.push(neighbour);
				}
			}
		}

		region.sort((a, b) => a.z - b.z || a.x - b.x);
		regions.push(region);
	}

	regions.sort((a, b) => a[0]!.z - b[0]!.z || a[0]!.x - b[0]!.x);
	return regions;
}

/**
 * Cut an oversized region into runs along its longer axis.
 *
 * Sorting by the dominant axis before chunking is what keeps each step a contiguous stretch
 * — chunking the raw cell order would hand the reader 40 blocks scattered across a wall.
 */
function sliceRegion(region: Cell[]): Cell[][] {
	let minX = Infinity;
	let maxX = -Infinity;
	let minZ = Infinity;
	let maxZ = -Infinity;
	for (const cell of region) {
		if (cell.x < minX) minX = cell.x;
		if (cell.x > maxX) maxX = cell.x;
		if (cell.z < minZ) minZ = cell.z;
		if (cell.z > maxZ) maxZ = cell.z;
	}

	const sorted = [...region];
	if (maxX - minX >= maxZ - minZ) sorted.sort((a, b) => a.x - b.x || a.z - b.z);
	else sorted.sort((a, b) => a.z - b.z || a.x - b.x);

	const slices: Cell[][] = [];
	for (let i = 0; i < sorted.length; i += MAX_BLOCKS_PER_STEP) {
		slices.push(sorted.slice(i, i + MAX_BLOCKS_PER_STEP));
	}
	return slices;
}

/** Fold tiny groups into the previous one, as long as that keeps it within the cap. */
function mergeSlivers(groups: Cell[][]): Cell[][] {
	const merged: Cell[][] = [];
	for (const group of groups) {
		const previous = merged[merged.length - 1];
		if (
			previous &&
			group.length < MIN_BLOCKS_PER_STEP &&
			previous.length + group.length <= MAX_BLOCKS_PER_STEP
		) {
			previous.push(...group);
			continue;
		}
		merged.push(group);
	}
	return merged;
}

function allIndices(grid: VoxelGrid): number[] {
	const indices: number[] = [];
	for (let i = 0; i < grid.voxels.length; i++) {
		const value = grid.voxels[i]!;
		if (value !== AIR_INDEX) indices.push(value);
	}
	return indices;
}

/**
 * Group palette indices into a bill of materials.
 *
 * This answers "what do I need to gather", which is not the same as "how many blockstates
 * are in the build", and the difference matters twice:
 *
 *  - Blockstates collapse to their item. Stairs facing four ways are one entry of oak
 *    stairs, not four; the renderer still has the exact state via `blocks`.
 *  - A door is two blocks but one item, so only its lower half is counted. Counting both
 *    halves would tell the player to gather twice the doors they need.
 *
 * Counts are also given in stacks, the unit inventory actually works in.
 */
function countMaterials(grid: VoxelGrid, indices: readonly number[]): MaterialCount[] {
	const counts = new Map<string, number>();
	for (const index of indices) {
		const ref = grid.palette[index]!;
		const parsed = parseBlockRef(ref);
		if (parsed.id.endsWith('_door') && parsed.states.half === 'upper') continue;
		counts.set(parsed.id, (counts.get(parsed.id) ?? 0) + 1);
	}

	const entries: MaterialCount[] = [];
	for (const [block, count] of counts) {
		entries.push({
			block,
			displayName: displayName(block),
			count,
			stacks: Math.floor(count / STACK_SIZE),
			remainder: count % STACK_SIZE,
		});
	}

	// Most-used first, with a name tiebreak so equal counts do not reorder between runs.
	entries.sort((a, b) => b.count - a.count || a.block.localeCompare(b.block));
	return entries;
}

function difficultyFor(stepCount: number): Difficulty {
	if (stepCount <= 10) return 'simple';
	if (stepCount <= 30) return 'moderate';
	if (stepCount <= 80) return 'complex';
	return 'epic';
}
