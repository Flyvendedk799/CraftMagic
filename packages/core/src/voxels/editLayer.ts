/**
 * The edit layer: hand edits as an overlay a program can be re-expanded underneath.
 *
 * Manual edits used to *detach* a build — the first changed voxel severed the grid from its
 * program, and every re-expansion (a param slider, a resize, an AI refine) had to ask
 * permission to destroy the user's work. This type dissolves that conflict. Edits live in
 * their own sparse layer over the expansion: re-expand the program, composite the layer back
 * on top, and both survive.
 *
 * Two representation choices carry the design:
 *
 * - **Entries store canonical block refs, not grid palette indices.** A palette index is a
 *   fact about one particular expansion; the next expansion numbers its palette differently
 *   and the index lies. The ref is the durable truth, resolved into whatever palette the
 *   current grid has at composite time.
 * - **Positions are absolute.** On a resize, an edit stays at the coordinates it was made at;
 *   entries outside the new bounds simply don't composite (and come back when the size
 *   does). Re-anchoring edits to the component they were near is an open research problem,
 *   and a predictable rule beats a clever one that guesses wrong.
 *
 * Slot 0 of the layer's palette is always air: an explicit air entry is a carve — "the
 * program puts a block here, I removed it" — which is very different from having no entry.
 */

import { AIR, canonical } from '../registry/registry.js';
import { voxelIndex, type BlockRef, type EditOp, type VoxelGrid } from '../ir/types.js';

/** The wire/storage form: plain JSON, versioned, independent of any expansion. */
export interface EditLayer {
	version: 1;
	/** Canonical refs; index 0 is always `minecraft:air`. */
	palette: BlockRef[];
	/** Flat x,y,z triples, absolute grid coordinates. */
	positions: number[];
	/** One entry per triple: an index into `palette`. */
	blocks: number[];
}

export interface CompositeResult {
	/** Entries written into the grid. */
	applied: number;
	/** Entries whose position lies outside the grid — kept, but invisible at this size. */
	outside: number;
	/** Net change in non-air block count. */
	delta: number;
	/** True when compositing appended palette slots, so callers re-derive colour tables. */
	paletteGrew: boolean;
}

/** Coordinates pack into one integer key: 9+8+9 bits comfortably covers the 256³ cap. */
function packPos(x: number, y: number, z: number): number {
	return x | (y << 9) | (z << 18);
}

function unpackPos(key: number): [number, number, number] {
	return [key & 511, (key >> 9) & 255, (key >> 18) & 511];
}

export class EditOverlay {
	/** packed position → canonical block ref (AIR = carve). */
	private readonly cells = new Map<number, BlockRef>();

	get size(): number {
		return this.cells.size;
	}

	clear(): void {
		this.cells.clear();
	}

	/**
	 * Record an applied op. The grid is the one the op was made against — its palette is what
	 * the op's indices mean. Later writes to the same cell replace earlier ones, so the layer
	 * stays exactly one entry per touched cell no matter how long the session runs.
	 *
	 * `pristine` is the expansion *before any hand edits* in the same palette numbering.
	 * When given, a write that lands back on the program's own value deletes the entry
	 * instead of storing it: undoing an edit — or repainting a block with what was already
	 * there — leaves no phantom edit behind.
	 */
	recordOp(grid: VoxelGrid, op: EditOp, pristine?: Uint16Array): void {
		const { size } = grid;
		const layer = size.x * size.z;
		for (let i = 0; i < op.indices.length; i++) {
			const index = op.indices[i]!;
			const y = Math.floor(index / layer);
			const rem = index - y * layer;
			const z = Math.floor(rem / size.x);
			const x = rem - z * size.x;
			const key = packPos(x, y, z);
			const value = op.after[i]!;
			if (pristine && index < pristine.length && pristine[index] === value) {
				this.cells.delete(key);
				continue;
			}
			this.cells.set(key, grid.palette[value] ?? AIR);
		}
	}

	/** Record the *reversal* of an op — the undo half, sharing recordOp's pristine rule. */
	recordRevert(grid: VoxelGrid, op: EditOp, pristine?: Uint16Array): void {
		this.recordOp(grid, { indices: op.indices, before: op.after, after: op.before }, pristine);
	}

	/**
	 * Paint the layer onto a grid, growing its palette as needed.
	 *
	 * Mutates `grid` — the caller owns a freshly expanded grid and is asking for the edited
	 * view of it. Entries outside the bounds are counted, not dropped: scale the build back
	 * up and they reappear, which is the honest behaviour for an edit made at a coordinate.
	 */
	composite(grid: VoxelGrid): CompositeResult {
		const { size, palette, voxels } = grid;
		const slotOf = new Map<string, number>();
		for (let i = 0; i < palette.length; i++) slotOf.set(palette[i]!, i);

		let applied = 0;
		let outside = 0;
		let delta = 0;
		let paletteGrew = false;

		for (const [key, ref] of this.cells) {
			const [x, y, z] = unpackPos(key);
			if (x >= size.x || y >= size.y || z >= size.z) {
				outside++;
				continue;
			}
			let slot = slotOf.get(ref);
			if (slot === undefined) {
				slot = palette.length;
				palette.push(ref);
				slotOf.set(ref, slot);
				paletteGrew = true;
			}
			const index = voxelIndex(size, x, y, z);
			const before = voxels[index]!;
			if (before !== 0 && slot === 0) delta--;
			else if (before === 0 && slot !== 0) delta++;
			voxels[index] = slot;
			applied++;
		}

		return { applied, outside, delta, paletteGrew };
	}

	/** How many entries would not land inside a grid of this size. For the UI's honesty line. */
	countOutside(size: VoxelGrid['size']): number {
		let outside = 0;
		for (const key of this.cells.keys()) {
			const [x, y, z] = unpackPos(key);
			if (x >= size.x || y >= size.y || z >= size.z) outside++;
		}
		return outside;
	}

	toJSON(): EditLayer {
		const palette: BlockRef[] = [AIR];
		const slotOf = new Map<BlockRef, number>([[AIR, 0]]);
		const positions: number[] = [];
		const blocks: number[] = [];

		for (const [key, ref] of this.cells) {
			const [x, y, z] = unpackPos(key);
			let slot = slotOf.get(ref);
			if (slot === undefined) {
				slot = palette.length;
				palette.push(ref);
				slotOf.set(ref, slot);
			}
			positions.push(x, y, z);
			blocks.push(slot);
		}

		return { version: 1, palette, positions, blocks };
	}

	/**
	 * Rebuild from storage. Tolerant by the same rule as everything else that reads persisted
	 * shapes: a malformed layer yields an empty overlay, never a throw — losing edits to a
	 * corrupt entry is bad, but refusing to open the build over one is worse.
	 */
	static fromJSON(layer: unknown): EditOverlay {
		const overlay = new EditOverlay();
		if (typeof layer !== 'object' || layer === null) return overlay;
		const { version, palette, positions, blocks } = layer as Partial<EditLayer>;
		if (version !== 1 || !Array.isArray(palette) || !Array.isArray(positions) || !Array.isArray(blocks)) {
			return overlay;
		}
		for (let i = 0; i < blocks.length; i++) {
			const x = positions[i * 3];
			const y = positions[i * 3 + 1];
			const z = positions[i * 3 + 2];
			const ref = palette[blocks[i]!];
			if (
				typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' ||
				typeof ref !== 'string' || x < 0 || y < 0 || z < 0 || x > 511 || y > 255 || z > 511
			) {
				continue;
			}
			overlay.cells.set(packPos(x, y, z), canonicalOr(ref));
		}
		return overlay;
	}

	/**
	 * The layer that turns `expanded` into `actual` — the lazy migration for builds saved
	 * under the old detach model, where only the edited voxels survived. Sizes must match;
	 * a mismatch returns null and the caller keeps today's voxels-only behaviour.
	 */
	static fromDiff(expanded: VoxelGrid, actual: VoxelGrid): EditOverlay | null {
		const { size } = expanded;
		if (size.x !== actual.size.x || size.y !== actual.size.y || size.z !== actual.size.z) {
			return null;
		}

		const overlay = new EditOverlay();
		const layer = size.x * size.z;
		for (let index = 0; index < expanded.voxels.length; index++) {
			const before = expanded.palette[expanded.voxels[index]!] ?? AIR;
			const after = actual.palette[actual.voxels[index]!] ?? AIR;
			if (before === after) continue;
			const y = Math.floor(index / layer);
			const rem = index - y * layer;
			const z = Math.floor(rem / size.x);
			overlay.cells.set(packPos(rem - z * size.x, y, z), after);
		}
		return overlay;
	}
}

/** Canonicalise defensively: stored refs are usually canonical already, junk must not throw. */
function canonicalOr(ref: string): string {
	try {
		return canonical(ref);
	} catch {
		return ref;
	}
}
