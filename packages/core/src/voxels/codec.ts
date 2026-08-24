/**
 * Compact binary form of a `VoxelGrid`, for storing in a database column.
 *
 * A 256³ build is 16.7M voxels — 33 MB as a raw `Uint16Array`. Builds are extremely
 * repetitive (mostly air, then long runs of the same block), so gzip does very well here;
 * the cottage goes from 10 KB to a few hundred bytes.
 *
 * The format is deliberately not the Sponge schematic: this one round-trips a `VoxelGrid`
 * exactly, including a palette that may contain entries the game would reject, and never
 * needs a DataVersion. Use `schem/write.ts` when the destination is Minecraft.
 *
 *   magic  "ICVX"          4 bytes
 *   version u8             1
 *   sizeX/Y/Z u32 LE       12
 *   paletteBytes u32 LE    4
 *   palette                JSON array of strings, UTF-8
 *   voxels                 Uint16 LE, one per cell
 *   ...all gzipped
 */

import { gunzipSync, gzipSync } from 'fflate';
import type { VoxelGrid } from '../ir/types.js';

const MAGIC = 0x49435658; // "ICVX"
const VERSION = 1;

export function encodeVoxels(grid: VoxelGrid): Uint8Array {
	const paletteJson = new TextEncoder().encode(JSON.stringify(grid.palette));
	const header = 4 + 1 + 12 + 4;
	const out = new Uint8Array(header + paletteJson.length + grid.voxels.length * 2);
	const view = new DataView(out.buffer);

	view.setUint32(0, MAGIC, false);
	view.setUint8(4, VERSION);
	view.setUint32(5, grid.size.x, true);
	view.setUint32(9, grid.size.y, true);
	view.setUint32(13, grid.size.z, true);
	view.setUint32(17, paletteJson.length, true);
	out.set(paletteJson, header);

	// Copying through a DataView rather than a Uint16Array view keeps this correct on
	// big-endian hosts, where a raw typed-array copy would silently byte-swap.
	let offset = header + paletteJson.length;
	for (let i = 0; i < grid.voxels.length; i++) {
		view.setUint16(offset, grid.voxels[i]!, true);
		offset += 2;
	}

	return gzipSync(out);
}

export function decodeVoxels(bytes: Uint8Array): VoxelGrid {
	const raw = gunzipSync(bytes);
	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

	if (view.getUint32(0, false) !== MAGIC) throw new Error('not an ImagineCraft voxel blob');
	const version = view.getUint8(4);
	if (version !== VERSION) throw new Error(`unsupported voxel blob version ${version}`);

	const size = {
		x: view.getUint32(5, true),
		y: view.getUint32(9, true),
		z: view.getUint32(13, true),
	};
	const paletteBytes = view.getUint32(17, true);
	const header = 21;

	const palette: string[] = JSON.parse(
		new TextDecoder().decode(raw.subarray(header, header + paletteBytes)),
	);

	const count = size.x * size.y * size.z;
	const expected = header + paletteBytes + count * 2;
	if (raw.length < expected) {
		throw new Error(`voxel blob is truncated: expected ${expected} bytes, got ${raw.length}`);
	}

	const voxels = new Uint16Array(count);
	let offset = header + paletteBytes;
	for (let i = 0; i < count; i++) {
		voxels[i] = view.getUint16(offset, true);
		offset += 2;
	}

	return { size, palette, voxels };
}
