/**
 * Turns a finished build into LEGO-style assembly instructions.
 *
 * The rules are fixed rather than per-build, so every guide reads the same way:
 *
 *  1. Build strictly bottom-up — you can always reach what you are placing.
 *  2. A layer of at most `design.step.maxBlocks` new blocks is one step.
 *  3. A busier layer splits *by part* first, when the expander recorded which component drew
 *     what. "Finish this wall, then hang these windows" is a sentence; "place these 40
 *     blocks, some of which are glass" is not.
 *  4. Within a part, a layer splits into *connected regions*, because "finish this wall, then
 *     that pillar" beats "place these 40 scattered blocks".
 *  5. A region still too large is sliced along its longer axis, so a slice stays a
 *     contiguous run rather than a scatter.
 *  6. Slivers are folded into the previous step; a step that places three blocks is noise.
 *     With provenance, only into a step of the *same* part — a named two-block step is
 *     clearer than a wall step that quietly also contains a door.
 *
 * Every threshold and every name in that list comes from {@link BuildGuideDesignSystem}, not
 * from constants here; this module is the machinery, the design system is the policy.
 *
 * Everything is deterministic — the same build always yields the same numbered steps, which
 * matters when someone is following a printed copy.
 */

import type { BuildPart, VoxelGrid } from '../ir/types.js';
import { AIR_INDEX, voxelIndex } from '../ir/types.js';
import { displayName, parseBlockRef } from '../registry/registry.js';
import type { BuildGuideDesignSystem, Difficulty, GuidePart } from './design-system.js';
import { DEFAULT_DESIGN_SYSTEM, anonymousStepTitle, difficultyFor, labelParts } from './design-system.js';

/**
 * The default design system's step bounds, re-exported.
 *
 * Kept because they read better at a call site than `DEFAULT_DESIGN_SYSTEM.step.maxBlocks`,
 * and because a guide built with a custom design system is the exception rather than the
 * rule.
 */
export const MAX_BLOCKS_PER_STEP = DEFAULT_DESIGN_SYSTEM.step.maxBlocks;
export const MIN_BLOCKS_PER_STEP = DEFAULT_DESIGN_SYSTEM.step.minBlocks;

export interface StepBlock {
	x: number;
	y: number;
	z: number;
	paletteIndex: number;
}

/** How much of one part a single step places. */
export interface StepPart {
	/** Matches {@link GuidePart.id}. */
	id: number;
	label: string;
	blocks: number;
}

export interface BuildStep {
	/** 1-based, for "Step 7 of 42". */
	index: number;
	layer: number;
	/** Set when a layer needed more than one step, e.g. 2 of 3. */
	partOfLayer?: { part: number; total: number };
	/**
	 * What this step is called — the part it advances, or its layer when nothing owns it.
	 *
	 * Always present, so a caller never has to decide what to fall back to.
	 */
	title: string;
	/**
	 * The parts this step touches, most blocks first. Empty without provenance.
	 *
	 * Usually one entry, by rule 3 above. More than one only where a sliver was folded in, or
	 * where the layer was small enough not to need splitting at all.
	 */
	parts: StepPart[];
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

export interface BuildGuide {
	name: string;
	size: VoxelGrid['size'];
	totalBlocks: number;
	steps: BuildStep[];
	/** Whole-build bill of materials, most-used first. */
	materials: MaterialCount[];
	/**
	 * What the build is made of, in the order the program describes it.
	 *
	 * A bill of *parts* rather than of materials: "a stone foundation, oak walls, twelve
	 * windows, a dark oak roof" is the sentence someone wants before they start gathering.
	 * Empty when the guide was built without provenance.
	 */
	parts: GuidePart[];
	difficulty: Difficulty;
	/** The design system this guide was laid out under. */
	design: BuildGuideDesignSystem;
}

export interface GuideOptions {
	/** From `expand(program, { provenance: true })`. Without both, segmentation is geometric. */
	parts?: readonly BuildPart[];
	origin?: Uint16Array | null;
	design?: BuildGuideDesignSystem;
}

interface Cell {
	x: number;
	z: number;
	paletteIndex: number;
	/** Owning part id, or 0 when unknown or unowned. */
	part: number;
}

export function buildGuide(grid: VoxelGrid, name = 'Build', options: GuideOptions = {}): BuildGuide {
	const design = options.design ?? DEFAULT_DESIGN_SYSTEM;

	// Both halves or neither: part ids with no map to look them up in would produce steps
	// titled after parts the guide cannot describe.
	const hasParts = Boolean(options.origin && options.parts && options.parts.length > 0);
	const origin = hasParts ? options.origin! : null;
	const parts = hasParts ? labelParts(options.parts!, grid.size, design) : [];
	const byId = new Map(parts.map((part) => [part.id, part]));

	const steps: BuildStep[] = [];
	let totalBlocks = 0;

	for (let y = 0; y < grid.size.y; y++) {
		const cells = layerCells(grid, y, origin);
		if (cells.length === 0) continue;
		totalBlocks += cells.length;

		const groups = segmentLayer(cells, design, hasParts);
		groups.forEach((group, part) => {
			const stepParts = tallyParts(group, byId);
			steps.push({
				index: steps.length + 1,
				layer: y,
				...(groups.length > 1 ? { partOfLayer: { part: part + 1, total: groups.length } } : {}),
				title: stepParts[0]?.label ?? anonymousStepTitle(y, design),
				parts: stepParts,
				blocks: group.map((c) => ({ x: c.x, y, z: c.z, paletteIndex: c.paletteIndex })),
				materials: countMaterials(grid, group.map((c) => c.paletteIndex), design),
			});
		});
	}

	return {
		name,
		size: grid.size,
		totalBlocks,
		steps,
		materials: countMaterials(grid, allIndices(grid), design),
		parts,
		difficulty: difficultyFor(steps.length, design),
		design,
	};
}

function layerCells(grid: VoxelGrid, y: number, origin: Uint16Array | null): Cell[] {
	const cells: Cell[] = [];
	for (let z = 0; z < grid.size.z; z++) {
		for (let x = 0; x < grid.size.x; x++) {
			const at = voxelIndex(grid.size, x, y, z);
			const paletteIndex = grid.voxels[at]!;
			if (paletteIndex !== AIR_INDEX) {
				cells.push({ x, z, paletteIndex, part: origin ? origin[at]! : 0 });
			}
		}
	}
	return cells;
}

/** Which parts a step places, and how much of each. Most blocks first. */
function tallyParts(group: readonly Cell[], byId: ReadonlyMap<number, GuidePart>): StepPart[] {
	if (byId.size === 0) return [];

	const counts = new Map<number, number>();
	for (const cell of group) {
		if (cell.part !== 0) counts.set(cell.part, (counts.get(cell.part) ?? 0) + 1);
	}

	const tally: StepPart[] = [];
	for (const [id, blocks] of counts) {
		const part = byId.get(id);
		if (part) tally.push({ id, label: part.label, blocks });
	}

	// Ties break on part id — program order — so a step split evenly between two parts is
	// named after the earlier one every run rather than however the Map happened to iterate.
	tally.sort((a, b) => b.blocks - a.blocks || a.id - b.id);
	return tally;
}

/** Split one layer's cells into follow-able steps. */
function segmentLayer(
	cells: Cell[],
	design: BuildGuideDesignSystem,
	hasParts: boolean,
): Cell[][] {
	// A layer under the cap is one step whatever it is made of. Splitting it by part would
	// turn a four-block course into four pages to save the reader nothing.
	if (cells.length <= design.step.maxBlocks) return [cells];

	const splitByPart = hasParts && design.step.splitByPart;
	const partitions = splitByPart ? byPart(cells) : [cells];

	const groups: Cell[][] = [];
	for (const partition of partitions) {
		for (const region of connectedRegions(partition)) {
			if (region.length <= design.step.maxBlocks) {
				groups.push(region);
				continue;
			}
			groups.push(...sliceRegion(region, design));
		}
	}

	return mergeSlivers(groups, design, splitByPart ? minorParts(cells, design) : null);
}

/**
 * Parts too slight in this layer to deserve a step of their own.
 *
 * The one-part-per-step rule earns its keep on walls and roofs; applied without exception it
 * produces a page that says "place 1 block" four times over, for the four corner posts a
 * cottage passes through on every course. Those parts are named in the step they join, so
 * nothing is hidden — they just do not get their own sheet of paper.
 */
function minorParts(cells: readonly Cell[], design: BuildGuideDesignSystem): Set<number> {
	const totals = new Map<number, number>();
	for (const cell of cells) totals.set(cell.part, (totals.get(cell.part) ?? 0) + 1);

	const minor = new Set<number>();
	for (const [part, total] of totals) {
		if (total < design.step.minBlocks) minor.add(part);
	}
	return minor;
}

/**
 * Partition a layer by owning part, in program order.
 *
 * Program order rather than position, because it is the order the build was conceived in and
 * therefore the order it makes sense to assemble: foundation, then walls, then the openings
 * cut into them. Unowned cells go last — they are whatever no component claimed, which is
 * exactly the leftovers a reader should tidy up at the end of a course.
 */
function byPart(cells: readonly Cell[]): Cell[][] {
	const groups = new Map<number, Cell[]>();
	for (const cell of cells) {
		const group = groups.get(cell.part);
		if (group) group.push(cell);
		else groups.set(cell.part, [cell]);
	}

	return [...groups.entries()]
		.sort(([a], [b]) => {
			if (a === 0) return 1;
			if (b === 0) return -1;
			return a - b;
		})
		.map(([, group]) => group);
}

/**
 * 4-connected regions within the layer.
 *
 * Ordered by the south-west-most cell so numbering is stable across runs — an unordered
 * `Map` iteration would renumber the steps whenever the palette changed.
 */
function connectedRegions(cells: readonly Cell[]): Cell[][] {
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
 *
 * The slices are then made *even* rather than greedy. Filling each slice to the cap and
 * letting the last take what is left turns a 361-block floor into nine steps of 40 and one
 * of 1 — and that final step cannot be folded away, because the step before it is already
 * full. Ten steps of 36 place the same blocks with nothing left over.
 */
function sliceRegion(region: readonly Cell[], design: BuildGuideDesignSystem): Cell[][] {
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

	// Fewest slices that stay under the cap, then share the blocks out between them. The
	// remainder goes to the earliest slices, so sizes only ever step down by one.
	const count = Math.ceil(sorted.length / design.step.maxBlocks);
	const each = Math.floor(sorted.length / count);
	const remainder = sorted.length % count;

	const slices: Cell[][] = [];
	let at = 0;
	for (let i = 0; i < count; i++) {
		const take = each + (i < remainder ? 1 : 0);
		slices.push(sorted.slice(at, at + take));
		at += take;
	}
	return slices;
}

/**
 * Fold tiny groups into the previous one, as long as that keeps it within the cap.
 *
 * `minor` is what stops the tidy-up from undoing the split above. Once steps have been
 * separated so each is one part, quietly folding a whole wall's leftover course into the
 * roof step before it would put the reader back where they started, with a step whose title
 * no longer covers everything in it. So a sliver merges across parts only when its part was
 * never going to fill a step in this layer anyway — a corner post, a door — and otherwise
 * only into another step of its own part. Null means no provenance: nothing to preserve, and
 * any sliver merges, exactly as it always did.
 */
function mergeSlivers(
	groups: Cell[][],
	design: BuildGuideDesignSystem,
	minor: ReadonlySet<number> | null,
): Cell[][] {
	const merged: Cell[][] = [];
	for (const group of groups) {
		const previous = merged[merged.length - 1];
		const mayCross = minor === null || minor.has(group[0]!.part);
		if (
			previous &&
			group.length < design.step.minBlocks &&
			previous.length + group.length <= design.step.maxBlocks &&
			(mayCross || previous[0]!.part === group[0]!.part)
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
function countMaterials(
	grid: VoxelGrid,
	indices: readonly number[],
	design: BuildGuideDesignSystem,
): MaterialCount[] {
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
			stacks: Math.floor(count / design.stackSize),
			remainder: count % design.stackSize,
		});
	}

	// Most-used first, with a name tiebreak so equal counts do not reorder between runs.
	entries.sort((a, b) => b.count - a.count || a.block.localeCompare(b.block));
	return entries;
}
