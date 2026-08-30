/**
 * Getting a world through `JSON.stringify` and back.
 *
 * The document holds typed arrays, and typed arrays do not survive JSON: `Int16Array` comes
 * out the far side as `{"0":62,"1":62,…}`, which is four times the bytes and no longer an
 * array. So the persisted form carries base64 instead, and this module is the only place that
 * knows the difference.
 *
 * Two codecs, and they are deliberately different shapes:
 *
 * - **Terrain** is dense — every column has a height and a stratum — so it goes over as the
 *   raw little-endian bytes. Run-length coding a heightfield would win on a flat world and
 *   lose on every interesting one, and the loss is unbounded while the win is not.
 * - **Overlay chunks** are the opposite: overwhelmingly zeroes, because a carved chunk is a
 *   tunnel through 4096 cells that say nothing. That is the same shape as a prefab, so it
 *   gets the same varint run-length coding, cell for cell, in the same YZX order.
 *
 * Neither is compressed here. Gzip belongs at the transport, where `voxels/codec.ts` already
 * puts it — compressing twice buys nothing and a document you cannot read in a database
 * client costs real debugging time.
 */

import { forEachPrefabRun } from '../ir/prefab.js';
import { fromBase64, toBase64 } from '../util/bytes.js';
import { reindexTerrain } from './terrain.js';
import {
	OVERLAY_AIR,
	OVERLAY_CHUNK,
	OVERLAY_PASS,
	type OverlayChunk,
	type Terrain,
	type WorldSettings,
} from './types.js';
import { AIR_BLOCK } from '../ir/types.js';

/** Cells in one overlay chunk. */
export const OVERLAY_CELLS = OVERLAY_CHUNK * OVERLAY_CHUNK * OVERLAY_CHUNK;

/**
 * The persisted heightfield.
 *
 * `x`/`z` travel with the arrays rather than being taken from the settings on the way back in.
 * A flat array only means anything alongside the stride it was written at, and settings are
 * normalised — clamped, defaulted — before the terrain is read, so the two can legitimately
 * disagree. Carrying the stride lets `decodeTerrain` re-index instead of shearing the map
 * diagonally, which is a corruption that still looks like terrain.
 */
export interface EncodedTerrain {
	x: number;
	z: number;
	/** Int16 little-endian, base64. */
	height: string;
	/** Raw bytes, base64. */
	strata: string;
}

export function encodeTerrain(terrain: Terrain, size: { x: number; z: number }): EncodedTerrain {
	const bytes = new Uint8Array(terrain.height.length * 2);
	const view = new DataView(bytes.buffer);
	// Written a value at a time through a DataView rather than copied as a buffer: a raw copy
	// takes the host's byte order, and a world saved on one machine would load byte-swapped on
	// a big-endian one — every height a plausible-looking nonsense number.
	for (let i = 0; i < terrain.height.length; i++) view.setInt16(i * 2, terrain.height[i]!, true);

	return {
		x: size.x,
		z: size.z,
		height: toBase64(bytes),
		strata: toBase64(terrain.strata),
	};
}

/**
 * Rebuild a heightfield for `settings`, whatever shape the stored one was in.
 *
 * Tolerant like everything else that reads persisted state: a missing, truncated or entirely
 * unrecognised terrain yields a flat world at sea level rather than a throw. Losing the
 * heightfield of a corrupt save is bad; refusing to open the save is worse, and the terrain is
 * the one layer a user can repaint.
 */
export function decodeTerrain(raw: unknown, settings: WorldSettings): Terrain {
	const columns = settings.size.x * settings.size.z;
	const fill = { height: settings.seaLevel, stratum: 0 };

	const source = readTerrainArrays(raw, settings);
	if (!source) {
		const height = new Int16Array(columns);
		height.fill(settings.seaLevel);
		return { height, strata: new Uint8Array(columns) };
	}

	return reindexTerrain(source.terrain, source.size, settings.size, fill);
}

function readTerrainArrays(
	raw: unknown,
	settings: WorldSettings,
): { terrain: Terrain; size: { x: number; z: number } } | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const record = raw as Record<string, unknown>;

	const height = toInt16(record.height);
	if (!height) return null;
	const strata = toUint8(record.strata, height.length);

	// A stride that did not travel with the arrays is assumed to be today's, which is right for
	// a document this module wrote and the only guess available for one it did not.
	const x = positiveInt(record.x) ?? settings.size.x;
	const z = positiveInt(record.z) ?? Math.max(1, Math.floor(height.length / Math.max(1, x)));

	return { terrain: { height, strata }, size: { x, z } };
}

function positiveInt(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 1
		? Math.floor(value)
		: null;
}

function toInt16(value: unknown): Int16Array | null {
	if (typeof value === 'string') {
		const bytes = fromBase64(value);
		const out = new Int16Array(Math.floor(bytes.length / 2));
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
		return out;
	}
	// An array of numbers is what a hand-written fixture or an older writer produces, and it
	// costs three lines to keep both readable.
	if (Array.isArray(value)) return Int16Array.from(value, (n) => (Number.isFinite(n) ? n : 0));
	if (value instanceof Int16Array) return value;
	return null;
}

function toUint8(value: unknown, length: number): Uint8Array {
	if (typeof value === 'string') {
		const bytes = fromBase64(value);
		if (bytes.length >= length) return bytes.subarray(0, length);
		const out = new Uint8Array(length);
		out.set(bytes);
		return out;
	}
	const out = new Uint8Array(length);
	if (Array.isArray(value) || value instanceof Uint8Array) {
		const source = value as ArrayLike<number>;
		for (let i = 0; i < length && i < source.length; i++) {
			const n = source[i]!;
			out[i] = Number.isFinite(n) ? n & 0xff : 0;
		}
	}
	return out;
}

/**
 * Pack 4096 tri-state cells into a chunk.
 *
 * The palette is passed in rather than derived, and slots 0 and 1 are forced: an overlay whose
 * slot 1 was something other than air would carve holes of stone, the exact bug
 * `encodePrefab`'s air-first rule exists to prevent one layer down.
 */
export function encodeOverlayChunk(cells: Uint16Array, palette: readonly string[]): OverlayChunk {
	const bytes: number[] = [];

	let run = 0;
	let current = cells[0] ?? 0;

	const flush = () => {
		if (run === 0) return;
		writeVarint(bytes, current);
		writeVarint(bytes, run);
		run = 0;
	};

	for (let i = 0; i < OVERLAY_CELLS; i++) {
		const value = cells[i] ?? 0;
		if (value === current) {
			run++;
			continue;
		}
		flush();
		current = value;
		run = 1;
	}
	flush();

	const out = [...palette];
	out[0] = OVERLAY_PASS;
	out[1] = AIR_BLOCK;
	return { palette: out, data: toBase64(Uint8Array.from(bytes)) };
}

/**
 * Unpack a chunk into the dense array the editor and the materialiser both walk.
 *
 * Always exactly `OVERLAY_CELLS` long, whatever the runs said. A short or overlong `data` is
 * corrupt input, and a fixed-size array means every caller can index it without first checking
 * that the chunk it came from was honest about its own length.
 */
export function decodeOverlayChunk(chunk: OverlayChunk): Uint16Array {
	const cells = new Uint16Array(OVERLAY_CELLS);
	forEachPrefabRun({ size: { x: OVERLAY_CHUNK, y: OVERLAY_CHUNK, z: OVERLAY_CHUNK }, ...chunk }, (index, length, start) => {
		if (index === 0 || start >= OVERLAY_CELLS) return;
		const end = Math.min(start + length, OVERLAY_CELLS);
		for (let cell = start; cell < end; cell++) cells[cell] = index;
	});
	return cells;
}

/** Whether a decoded chunk says anything at all, so `commit` can drop the ones that do not. */
export function overlayChunkIsEmpty(cells: Uint16Array): boolean {
	for (let i = 0; i < cells.length; i++) if (cells[i] !== 0) return false;
	return true;
}

/**
 * Coerce a stored chunk into one this module will read.
 *
 * Runs through `decode`/`encode` rather than trusting the string, which normalises the two
 * structural palette slots and drops anything past 4096 cells in one pass.
 */
export function normalizeOverlayChunk(raw: unknown): OverlayChunk | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const record = raw as Partial<OverlayChunk>;
	if (typeof record.data !== 'string') return null;

	const palette = Array.isArray(record.palette)
		? record.palette.map((ref) => (typeof ref === 'string' ? ref : AIR_BLOCK))
		: [];
	while (palette.length < 2) palette.push(palette.length === 0 ? OVERLAY_PASS : AIR_BLOCK);

	const cells = decodeOverlayChunk({ palette, data: record.data });
	// A cell naming a slot the palette does not have is corrupt data, and interning
	// `undefined` into a grid palette later is a far more confusing crash than dropping it.
	for (let i = 0; i < cells.length; i++) {
		if (cells[i]! >= palette.length) cells[i] = OVERLAY_AIR;
	}
	if (overlayChunkIsEmpty(cells)) return null;

	return encodeOverlayChunk(cells, palette);
}

// --- varints ------------------------------------------------------------------------------
// The writer is twenty lines and `ir/prefab.ts` keeps its own private, so this is a second
// copy rather than an export that would freeze an implementation detail of the prefab format
// into a shared surface. The reader is not duplicated: `forEachPrefabRun` already is one.

function writeVarint(out: number[], value: number): void {
	let rest = value >>> 0;
	while (rest >= 0x80) {
		out.push((rest & 0x7f) | 0x80);
		rest >>>= 7;
	}
	out.push(rest);
}
