/**
 * The sparse overlay: the layer that lets a heightfield describe a cave.
 *
 * A heightfield is a function from a column to one number, so it can express a mountain and it
 * cannot express anything with two surfaces above the same spot — no cave, no overhang, no
 * bridge, no tunnel, no cliff you can walk under. Those are most of what makes a hub feel
 * built rather than generated, so they get their own layer, and it is sparse because they are
 * rare: a whole map's worth of tunnels is a handful of chunks out of tens of thousands.
 *
 * The tri-state is the load-bearing decision and it is worth restating where the code is.
 * "This chunk has nothing to say about this cell" and "this cell is air" have to be different
 * values. If they are the same, a chunk is an all-or-nothing replacement of the terrain inside
 * it, so boring a two-block tunnel through a hill means writing out 4096 explicit cells of
 * stone around it — and the next time the terrain under it is raised, the tunnel's chunk is
 * still full of the old stone and the hill grows a square scar.
 *
 * ## Writing
 *
 * Chunks are stored encoded, so a write is decode-modify-encode. Doing that per cell would
 * make carving a tunnel quadratic in the chunk — a 4096-cell decode and re-encode for every
 * block of it. `OverlayEditor` holds each touched chunk decoded and hot, and pays the encode
 * once at `commit`. `overlayGet`/`overlaySet` are the one-shot wrappers for the cases that
 * genuinely are one cell; anything in a loop should be holding an editor.
 */

import { AIR_BLOCK, type BlockRef } from '../ir/types.js';
import {
	decodeOverlayChunk,
	encodeOverlayChunk,
	overlayChunkIsEmpty,
	OVERLAY_CELLS,
} from './codec.js';
import {
	OVERLAY_AIR,
	OVERLAY_CHUNK,
	OVERLAY_NONE,
	OVERLAY_PASS,
	type Overlay,
	type OverlayChunk,
} from './types.js';

/** The chunk a world position falls in. Floored, so negative coordinates go the right way. */
export function overlayChunkFor(
	x: number,
	y: number,
	z: number,
): { cx: number; cy: number; cz: number } {
	return {
		cx: Math.floor(x / OVERLAY_CHUNK),
		cy: Math.floor(y / OVERLAY_CHUNK),
		cz: Math.floor(z / OVERLAY_CHUNK),
	};
}

/** The record key for a chunk. String keys because the overlay is plain JSON. */
export function overlayChunkKey(cx: number, cy: number, cz: number): string {
	return `${cx},${cy},${cz}`;
}

/** Parse a key back. Returns null for anything that is not one, so a junk key is skipped. */
export function parseOverlayChunkKey(
	key: string,
): { cx: number; cy: number; cz: number } | null {
	const parts = key.split(',');
	if (parts.length !== 3) return null;
	const [cx, cy, cz] = parts.map((part) => Number(part));
	if (!Number.isInteger(cx) || !Number.isInteger(cy) || !Number.isInteger(cz)) return null;
	return { cx: cx!, cy: cy!, cz: cz! };
}

/** Cell index inside a chunk. YZX, the same order as a `VoxelGrid` and a prefab. */
export function overlayCellIndex(x: number, y: number, z: number): number {
	const lx = mod16(x);
	const ly = mod16(y);
	const lz = mod16(z);
	return lx + lz * OVERLAY_CHUNK + ly * OVERLAY_CHUNK * OVERLAY_CHUNK;
}

/** Floored modulo. `%` on a negative coordinate is negative, which indexes out of the chunk. */
function mod16(value: number): number {
	return ((value % OVERLAY_CHUNK) + OVERLAY_CHUNK) % OVERLAY_CHUNK;
}

/**
 * What the overlay says about a cell.
 *
 * `null` is pass-through — the terrain column decides — and `minecraft:air` is a carve. They
 * are different answers and every caller has to keep them different, which is why this returns
 * a nullable ref rather than a ref-or-air.
 */
export function overlayGet(overlay: Overlay, x: number, y: number, z: number): BlockRef | null {
	const { cx, cy, cz } = overlayChunkFor(x, y, z);
	const chunk = overlay[overlayChunkKey(cx, cy, cz)];
	if (!chunk) return null;

	const cells = decodeOverlayChunk(chunk);
	const value = cells[overlayCellIndex(x, y, z)] ?? OVERLAY_NONE;
	if (value === OVERLAY_NONE) return null;
	if (value === OVERLAY_AIR) return AIR_BLOCK;
	return chunk.palette[value] ?? AIR_BLOCK;
}

/**
 * Write one cell, in place.
 *
 * Decodes and re-encodes a whole chunk, so this is for single edits only — a loop wants an
 * `OverlayEditor`. Setting a cell back to pass-through empties the chunk when it was the last
 * thing in it, because a record full of chunks that say nothing is a record that costs bytes,
 * intersection tests and mesh work for no blocks at all.
 */
export function overlaySet(
	overlay: Overlay,
	x: number,
	y: number,
	z: number,
	ref: BlockRef | null,
): void {
	const editor = new OverlayEditor(overlay);
	editor.set(x, y, z, ref);
	editor.commitInto(overlay);
}

/** A chunk with nothing in it — slot 0 pass-through, slot 1 air, and no runs. */
export function emptyOverlayChunk(): OverlayChunk {
	return encodeOverlayChunk(new Uint16Array(OVERLAY_CELLS), [OVERLAY_PASS, AIR_BLOCK]);
}

/**
 * A write session over an overlay.
 *
 * Holds every chunk it touches decoded and its palette open, and re-encodes at `commit`. The
 * source overlay is never mutated until then, so an abandoned stroke costs nothing and an undo
 * is "throw the editor away".
 */
export class OverlayEditor {
	private readonly source: Overlay;
	private readonly hot = new Map<string, { cells: Uint16Array; palette: BlockRef[] }>();

	constructor(source: Overlay = {}) {
		this.source = source;
	}

	/** How many chunks this session has opened. */
	get touched(): number {
		return this.hot.size;
	}

	get(x: number, y: number, z: number): BlockRef | null {
		const { cx, cy, cz } = overlayChunkFor(x, y, z);
		const key = overlayChunkKey(cx, cy, cz);
		const open = this.hot.get(key);
		if (!open) return overlayGet(this.source, x, y, z);

		const value = open.cells[overlayCellIndex(x, y, z)] ?? OVERLAY_NONE;
		if (value === OVERLAY_NONE) return null;
		if (value === OVERLAY_AIR) return AIR_BLOCK;
		return open.palette[value] ?? AIR_BLOCK;
	}

	/** `null` clears the override; `minecraft:air` carves; anything else is an explicit block. */
	set(x: number, y: number, z: number, ref: BlockRef | null): void {
		const { cx, cy, cz } = overlayChunkFor(x, y, z);
		const open = this.open(overlayChunkKey(cx, cy, cz));
		open.cells[overlayCellIndex(x, y, z)] = this.slotFor(open.palette, ref);
	}

	/** Carve: forced air. Spelled out because it is the operation the whole layer exists for. */
	carve(x: number, y: number, z: number): void {
		this.set(x, y, z, AIR_BLOCK);
	}

	/** Fill an inclusive box. Opens each chunk once however many cells of it are written. */
	fill(
		from: { x: number; y: number; z: number },
		to: { x: number; y: number; z: number },
		ref: BlockRef | null,
	): number {
		let written = 0;
		for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y++) {
			for (let z = Math.min(from.z, to.z); z <= Math.max(from.z, to.z); z++) {
				for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x++) {
					this.set(x, y, z, ref);
					written++;
				}
			}
		}
		return written;
	}

	/**
	 * Re-encode every touched chunk into a new overlay.
	 *
	 * Chunks that ended up empty are dropped rather than written as an empty chunk: sparsity is
	 * the property that makes the layer affordable, and a stroke that carved and then unwound
	 * must not leave a permanent 4096-cell hole in it.
	 */
	commit(): Overlay {
		const out: Overlay = { ...this.source };
		this.writeInto(out);
		return out;
	}

	/** The same, in place — for the callers that own the overlay they passed in. */
	commitInto(target: Overlay): void {
		this.writeInto(target);
	}

	private writeInto(target: Overlay): void {
		for (const [key, open] of this.hot) {
			if (overlayChunkIsEmpty(open.cells)) delete target[key];
			else target[key] = encodeOverlayChunk(open.cells, open.palette);
		}
	}

	private open(key: string): { cells: Uint16Array; palette: BlockRef[] } {
		const existing = this.hot.get(key);
		if (existing) return existing;

		const stored = this.source[key];
		const opened = stored
			? { cells: decodeOverlayChunk(stored), palette: [...stored.palette] }
			: { cells: new Uint16Array(OVERLAY_CELLS), palette: [OVERLAY_PASS, AIR_BLOCK] };
		// Slots 0 and 1 are structural. A stored chunk whose palette lost them — a hand-edited
		// document, an older writer — would otherwise have every carve resolve to a real block.
		opened.palette[0] = OVERLAY_PASS;
		opened.palette[1] = AIR_BLOCK;
		this.hot.set(key, opened);
		return opened;
	}

	private slotFor(palette: BlockRef[], ref: BlockRef | null): number {
		if (ref === null) return OVERLAY_NONE;
		if (ref === AIR_BLOCK) return OVERLAY_AIR;
		const found = palette.indexOf(ref);
		if (found >= 2) return found;
		palette.push(ref);
		return palette.length - 1;
	}
}

/** World-block bounds of a chunk key, inclusive. */
export function overlayChunkBox(
	cx: number,
	cy: number,
	cz: number,
): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } {
	return {
		minX: cx * OVERLAY_CHUNK,
		minY: cy * OVERLAY_CHUNK,
		minZ: cz * OVERLAY_CHUNK,
		maxX: cx * OVERLAY_CHUNK + OVERLAY_CHUNK - 1,
		maxY: cy * OVERLAY_CHUNK + OVERLAY_CHUNK - 1,
		maxZ: cz * OVERLAY_CHUNK + OVERLAY_CHUNK - 1,
	};
}

/** How many cells across the whole overlay say something. For the honesty line in the UI. */
export function overlayCellCount(overlay: Overlay): number {
	let count = 0;
	for (const chunk of Object.values(overlay)) {
		const cells = decodeOverlayChunk(chunk);
		for (let i = 0; i < cells.length; i++) if (cells[i] !== 0) count++;
	}
	return count;
}
