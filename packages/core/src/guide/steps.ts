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

import type { BuildPart, Face, VoxelGrid } from '../ir/types.js';
import { AIR_INDEX, voxelIndex } from '../ir/types.js';
import type { ParsedBlock } from '../registry/registry.js';
import { displayName, formatRef, parseBlockRef } from '../registry/registry.js';
import type { BuildGuideDesignSystem, Difficulty, GuidePart } from './design-system.js';
import { DEFAULT_DESIGN_SYSTEM, anonymousStepTitle, bearing, difficultyFor, labelParts } from './design-system.js';

/**
 * The default design system's step bounds, re-exported.
 *
 * Kept because they read better at a call site than `DEFAULT_DESIGN_SYSTEM.step.maxBlocks`,
 * and because a guide built with a custom design system is the exception rather than the
 * rule.
 */
export const MAX_BLOCKS_PER_STEP = DEFAULT_DESIGN_SYSTEM.step.maxBlocks;
export const MIN_BLOCKS_PER_STEP = DEFAULT_DESIGN_SYSTEM.step.minBlocks;

export type CameraOrientation = 'SE' | 'SW' | 'NW' | 'NE';

export interface BlockstateGlyph {
	kind: 'stairs' | 'slab' | 'pillar' | 'door' | 'trapdoor' | 'generic';
	facing?: 'north' | 'south' | 'east' | 'west' | 'up' | 'down';
	half?: 'top' | 'bottom' | 'upper' | 'lower';
	shape?: 'straight' | 'inner_left' | 'inner_right' | 'outer_left' | 'outer_right';
	axis?: 'x' | 'y' | 'z';
}

export interface StepTrayItem {
	block: string;
	displayName: string;
	count: number;
	canonicalRef: string;
	states: Record<string, string>;
	glyph: BlockstateGlyph;
}

export interface StepBlock {
	x: number;
	y: number;
	z: number;
	paletteIndex: number;
	isOverhang?: boolean;
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
	trayItems: StepTrayItem[];
	optimalOrientation: CameraOrientation;
	hasOverhangs: boolean;
	overhangCount: number;
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
	const placedVoxels = new Uint8Array(grid.voxels.length);

	for (let y = 0; y < grid.size.y; y++) {
		const cells = layerCells(grid, y, origin);
		if (cells.length === 0) continue;
		totalBlocks += cells.length;

		const groups = segmentLayer(cells, design, hasParts);
		groups.forEach((group, part) => {
			const stepParts = tallyParts(group, byId);
			const primaryPart = stepParts[0] ? byId.get(stepParts[0].id) : undefined;
			let face: Face | undefined = primaryPart?.face;
			if (!face && primaryPart) {
				const b = bearing(primaryPart, grid.size, design);
				if (b === 'north' || b === 'south' || b === 'east' || b === 'west') {
					face = b;
				}
			}

			const blocks: StepBlock[] = group.map((c) => ({
				x: c.x,
				y,
				z: c.z,
				paletteIndex: c.paletteIndex,
				isOverhang: isOverhangBlock(grid, c.x, y, c.z),
			}));

			const hasOverhangs = blocks.some((b) => b.isOverhang);
			const overhangCount = blocks.filter((b) => b.isOverhang).length;

			const trayItems = buildTrayItems(grid, blocks);
			const optimalOrientation = calculateOptimalOrientation(
				blocks,
				grid.size,
				placedVoxels,
				face,
			);

			for (const b of blocks) {
				placedVoxels[voxelIndex(grid.size, b.x, b.y, b.z)] = 1;
			}

			steps.push({
				index: steps.length + 1,
				layer: y,
				...(groups.length > 1 ? { partOfLayer: { part: part + 1, total: groups.length } } : {}),
				title: stepParts[0]?.label ?? anonymousStepTitle(y, design),
				parts: stepParts,
				blocks,
				materials: countMaterials(grid, group.map((c) => c.paletteIndex), design),
				trayItems,
				optimalOrientation,
				hasOverhangs,
				overhangCount,
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

/* --- overhang detection ----------------------------------------------------------------- */

/**
 * Detects whether a block placed at (x, y, z) is an overhang.
 *
 * Ground level (y = 0) is always supported by definition.
 * At y > 0, if the voxel directly below at (x, y - 1, z) is air, it is an overhang.
 */
export function isOverhangBlock(grid: VoxelGrid, x: number, y: number, z: number): boolean {
	if (y === 0) return false;
	if (x < 0 || x >= grid.size.x || y >= grid.size.y || z < 0 || z >= grid.size.z) {
		return false;
	}
	const belowIndex = voxelIndex(grid.size, x, y - 1, z);
	return grid.voxels[belowIndex] === AIR_INDEX;
}

/* --- blockstate glyphs & tray items ----------------------------------------------------- */

/**
 * Extracts a directional BlockstateGlyph from a block ID and its blockstates.
 */
export function extractBlockstateGlyph(
	blockIdOrRef: string,
	statesInput?: Record<string, string>,
): BlockstateGlyph {
	let blockId = blockIdOrRef;
	let states: Record<string, string> = statesInput ? { ...statesInput } : {};

	if (blockId.includes('[')) {
		const parsed = parseBlockRef(blockId);
		blockId = parsed.id;
		states = { ...parsed.states, ...states };
	}

	if (blockId.endsWith('_stairs')) {
		const glyph: BlockstateGlyph = { kind: 'stairs' };
		if (states.facing) glyph.facing = states.facing as BlockstateGlyph['facing'];
		if (states.half) glyph.half = states.half as BlockstateGlyph['half'];
		if (states.shape) glyph.shape = states.shape as BlockstateGlyph['shape'];
		return glyph;
	}

	if (blockId.endsWith('_slab')) {
		const glyph: BlockstateGlyph = { kind: 'slab' };
		const half =
			states.type === 'top' || states.half === 'top'
				? 'top'
				: states.type === 'bottom' || states.half === 'bottom'
					? 'bottom'
					: undefined;
		if (half) glyph.half = half;
		return glyph;
	}

	if (blockId.endsWith('_trapdoor')) {
		const glyph: BlockstateGlyph = { kind: 'trapdoor' };
		if (states.facing) glyph.facing = states.facing as BlockstateGlyph['facing'];
		if (states.half) glyph.half = states.half as BlockstateGlyph['half'];
		return glyph;
	}

	if (blockId.endsWith('_door')) {
		const glyph: BlockstateGlyph = { kind: 'door' };
		if (states.facing) glyph.facing = states.facing as BlockstateGlyph['facing'];
		if (states.half) glyph.half = states.half as BlockstateGlyph['half'];
		return glyph;
	}

	if (
		blockId.endsWith('_log') ||
		blockId.endsWith('_wood') ||
		blockId.endsWith('_stem') ||
		blockId.endsWith('_hyphae') ||
		blockId.includes('basalt') ||
		blockId.includes('pillar') ||
		Boolean(states.axis)
	) {
		const axis = (states.axis as 'x' | 'y' | 'z') || 'y';
		return { kind: 'pillar', axis };
	}

	return { kind: 'generic' };
}

/**
 * Groups a step's blocks by exact block reference, extracts directional glyphs,
 * and sorts deterministically (highest count first, then canonicalRef).
 */
export function buildTrayItems(grid: VoxelGrid, blocks: readonly StepBlock[]): StepTrayItem[] {
	const countsByRef = new Map<string, { count: number; parsed: ParsedBlock }>();

	for (const block of blocks) {
		const rawRef = grid.palette[block.paletteIndex]!;
		const parsed = parseBlockRef(rawRef);
		const canonicalRef = formatRef(parsed.id, parsed.states);
		const entry = countsByRef.get(canonicalRef);
		if (entry) {
			entry.count++;
		} else {
			countsByRef.set(canonicalRef, { count: 1, parsed });
		}
	}

	const items: StepTrayItem[] = [];
	for (const [canonicalRef, { count, parsed }] of countsByRef) {
		const glyph = extractBlockstateGlyph(parsed.id, parsed.states);
		items.push({
			block: parsed.id,
			displayName: displayName(parsed.id),
			count,
			canonicalRef,
			states: parsed.states,
			glyph,
		});
	}

	items.sort((a, b) => b.count - a.count || a.canonicalRef.localeCompare(b.canonicalRef));
	return items;
}

/* --- camera occlusion & optimal orientation -------------------------------------------- */

export const CAMERA_ORIENTATIONS: readonly CameraOrientation[] = ['SE', 'SW', 'NW', 'NE'] as const;

export const CAMERA_RAY_DIRECTIONS: Record<CameraOrientation, { dx: number; dy: number; dz: number }> = {
	SE: { dx: 1, dy: 1, dz: 1 },
	SW: { dx: -1, dy: 1, dz: 1 },
	NW: { dx: -1, dy: 1, dz: -1 },
	NE: { dx: 1, dy: 1, dz: -1 },
};

export type EarlierOccupied =
	| ReadonlySet<string | number>
	| ReadonlyArray<{ x: number; y: number; z: number }>
	| ((x: number, y: number, z: number) => boolean)
	| Uint16Array
	| Uint8Array;

export interface OcclusionResult {
	orientation: CameraOrientation;
	occludedCount: number;
	totalBlocks: number;
	ratio: number;
}

export interface OcclusionScoringOptions {
	gridSize?: VoxelGrid['size'];
	earlierPlaced?: EarlierOccupied;
	face?: Face | string;
}

export function calculateCameraOcclusion(
	blocks: readonly { x: number; y: number; z: number }[],
	size: VoxelGrid['size'],
	isOccupied: (x: number, y: number, z: number) => boolean,
): Record<CameraOrientation, OcclusionResult> {
	const result = {} as Record<CameraOrientation, OcclusionResult>;
	const totalBlocks = blocks.length;

	for (const orientation of CAMERA_ORIENTATIONS) {
		const { dx, dy, dz } = CAMERA_RAY_DIRECTIONS[orientation];
		let occludedCount = 0;

		for (const b of blocks) {
			let step = 1;
			while (true) {
				const cx = b.x + dx * step;
				const cy = b.y + dy * step;
				const cz = b.z + dz * step;

				if (cx < 0 || cx >= size.x || cy < 0 || cy >= size.y || cz < 0 || cz >= size.z) {
					break;
				}

				if (isOccupied(cx, cy, cz)) {
					occludedCount++;
					break;
				}

				step++;
			}
		}

		const ratio = totalBlocks > 0 ? occludedCount / totalBlocks : 0;
		result[orientation] = { orientation, occludedCount, totalBlocks, ratio };
	}

	return result;
}

export function getOrientationPreference(face?: string): readonly CameraOrientation[] {
	switch (face) {
		case 'north':
			return ['NW', 'NE', 'SE', 'SW'];
		case 'south':
			return ['SE', 'SW', 'NW', 'NE'];
		case 'west':
			return ['SW', 'NW', 'SE', 'NE'];
		case 'east':
			return ['SE', 'NE', 'SW', 'NW'];
		default:
			return ['SE', 'SW', 'NW', 'NE'];
	}
}

export function calculateOptimalOrientation(
	blocks: readonly { x: number; y: number; z: number }[],
	gridSizeOrOptions?: VoxelGrid['size'] | OcclusionScoringOptions,
	earlierPlacedArg?: EarlierOccupied,
	faceArg?: Face | string,
): CameraOrientation {
	let size: VoxelGrid['size'] = { x: 256, y: 160, z: 256 };
	let earlierPlaced: EarlierOccupied | undefined = earlierPlacedArg;
	let face: Face | string | undefined = faceArg;

	if (gridSizeOrOptions) {
		if ('x' in gridSizeOrOptions && 'y' in gridSizeOrOptions && 'z' in gridSizeOrOptions) {
			size = gridSizeOrOptions;
		} else {
			if (gridSizeOrOptions.gridSize) size = gridSizeOrOptions.gridSize;
			if (gridSizeOrOptions.earlierPlaced !== undefined) earlierPlaced = gridSizeOrOptions.earlierPlaced;
			if (gridSizeOrOptions.face !== undefined) face = gridSizeOrOptions.face;
		}
	}

	let isOccupied: (x: number, y: number, z: number) => boolean;
	if (!earlierPlaced) {
		isOccupied = () => false;
	} else if (typeof earlierPlaced === 'function') {
		isOccupied = earlierPlaced;
	} else if (earlierPlaced instanceof Set) {
		isOccupied = (x, y, z) => {
			const set = earlierPlaced as Set<string | number>;
			return set.has(`${x},${y},${z}`) || set.has(voxelIndex(size, x, y, z));
		};
	} else if (earlierPlaced instanceof Uint8Array || earlierPlaced instanceof Uint16Array) {
		isOccupied = (x, y, z) => earlierPlaced[voxelIndex(size, x, y, z)] !== AIR_INDEX;
	} else if (Array.isArray(earlierPlaced)) {
		const set = new Set<string>();
		for (const b of earlierPlaced) {
			set.add(`${b.x},${b.y},${b.z}`);
		}
		isOccupied = (x, y, z) => set.has(`${x},${y},${z}`);
	} else {
		isOccupied = () => false;
	}

	const scores = calculateCameraOcclusion(blocks, size, isOccupied);
	const minRatio = Math.min(
		scores.SE.ratio,
		scores.SW.ratio,
		scores.NW.ratio,
		scores.NE.ratio,
	);

	const candidates = CAMERA_ORIENTATIONS.filter(
		(o) => Math.abs(scores[o].ratio - minRatio) < 1e-6,
	);

	const preference = getOrientationPreference(face);
	for (const pref of preference) {
		if (candidates.includes(pref)) {
			return pref;
		}
	}

	return 'SE';
}
