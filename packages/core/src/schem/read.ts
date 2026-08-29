/**
 * Sponge Schematic v2 import — the other half of `write.ts`.
 *
 * Reading is harder than writing, because we only ever write our own output but have to
 * read *everyone's*: WorldEdit, Axiom, litematica converters, each with their own extra
 * fields (BlockEntities, Entities, DataVersion quirks). So this is a real NBT parser — all
 * thirteen tag types, values it does not care about parsed and discarded — rather than a
 * scanner tuned to our own writer's byte layout.
 *
 * What comes out is a plain `VoxelGrid`: YZX order and canonical blockstate strings are
 * Sponge's own layout, which is why the conversion is a varint decode and nothing else.
 * Unknown blocks are kept verbatim — the registry colours them grey rather than refusing
 * the file, and the exporter writes them back out untouched.
 */

import { gunzipSync } from 'fflate';
import type { VoxelGrid } from '../ir/types.js';
import { canonical } from '../registry/registry.js';

/** Anything beyond this refuses early: it exceeds the engine, and probably the RAM. */
const MAX_VOLUME = 512 * 512 * 512;

export function readSchematic(bytes: Uint8Array): VoxelGrid {
	const nbt = parseNbt(inflated(bytes));
	// v2 keeps everything flat in a root compound (conventionally named "Schematic"); some
	// writers nest that compound one level deeper. Take the first compound that has the
	// fields, wherever it sits.
	const schematic = findSchematic(nbt);
	if (!schematic) throw new Error('not a Sponge schematic: no Width/Height/Length found');

	const width = asNumber(schematic['Width']);
	const height = asNumber(schematic['Height']);
	const length = asNumber(schematic['Length']);
	if (width <= 0 || height <= 0 || length <= 0) {
		throw new Error(`bad schematic dimensions ${width}x${height}x${length}`);
	}
	if (width * height * length > MAX_VOLUME) {
		throw new Error(`schematic is ${width}x${height}x${length} — too large to open`);
	}

	const paletteTag = schematic['Palette'];
	if (typeof paletteTag !== 'object' || paletteTag === null || paletteTag instanceof Uint8Array) {
		throw new Error('schematic has no palette');
	}
	const blockData = schematic['BlockData'];
	if (!(blockData instanceof Uint8Array)) throw new Error('schematic has no block data');

	// Sponge's palette maps ref → id; the grid wants id → ref.
	let maxId = -1;
	for (const id of Object.values(paletteTag as Record<string, NbtValue>)) {
		const value = asNumber(id);
		if (value > maxId) maxId = value;
	}
	const palette: string[] = new Array<string>(maxId + 1).fill('minecraft:air');
	for (const [ref, id] of Object.entries(paletteTag as Record<string, NbtValue>)) {
		palette[asNumber(id)] = canonicalOr(ref);
	}

	const volume = width * height * length;
	const voxels = new Uint16Array(volume);
	let at = 0;
	for (let i = 0; i < volume; i++) {
		let value = 0;
		let shift = 0;
		for (;;) {
			if (at >= blockData.length) throw new Error('schematic block data ends early');
			const byte = blockData[at++]!;
			value |= (byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) break;
			shift += 7;
			if (shift > 28) throw new Error('schematic block data is corrupt (runaway varint)');
		}
		if (value >= palette.length) throw new Error(`schematic references palette id ${value} beyond the palette`);
		voxels[i] = value;
	}

	// The grid's air must be slot 0 — every editing tool and the mesher assume it. A
	// schematic is free to number air anywhere (or nowhere), so remap when needed.
	return normalizeAir({ size: { x: width, y: height, z: length }, palette, voxels });
}

/** Accept gzip (the on-disk convention) and raw NBT (some tools hand it over unzipped). */
function inflated(bytes: Uint8Array): Uint8Array {
	if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return gunzipSync(bytes);
	return bytes;
}

function findSchematic(value: NbtValue): Record<string, NbtValue> | null {
	if (typeof value !== 'object' || value === null || value instanceof Uint8Array || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, NbtValue>;
	if ('Width' in record && 'Height' in record && 'Length' in record) return record;
	for (const child of Object.values(record)) {
		const found = findSchematic(child);
		if (found) return found;
	}
	return null;
}

function normalizeAir(grid: VoxelGrid): VoxelGrid {
	const airAt = grid.palette.findIndex((ref) => ref === 'minecraft:air');
	if (airAt === 0) return grid;
	if (airAt === -1) {
		// No air in the palette at all — prepend it and shift every voxel up one.
		const palette = ['minecraft:air', ...grid.palette];
		const voxels = new Uint16Array(grid.voxels.length);
		for (let i = 0; i < voxels.length; i++) voxels[i] = grid.voxels[i]! + 1;
		return { size: grid.size, palette, voxels };
	}
	// Swap air into slot 0 and remap the two affected ids.
	const palette = [...grid.palette];
	[palette[0], palette[airAt]] = [palette[airAt]!, palette[0]!];
	const voxels = grid.voxels.slice();
	for (let i = 0; i < voxels.length; i++) {
		if (voxels[i] === 0) voxels[i] = airAt;
		else if (voxels[i] === airAt) voxels[i] = 0;
	}
	return { size: grid.size, palette, voxels };
}

function canonicalOr(ref: string): string {
	try {
		return canonical(ref);
	} catch {
		return ref;
	}
}

function asNumber(value: NbtValue | undefined): number {
	if (typeof value === 'number') return value;
	if (typeof value === 'bigint') return Number(value);
	return 0;
}

// --- a small, complete NBT reader ---------------------------------------------------------

type NbtValue =
	| number
	| bigint
	| string
	| Uint8Array
	| number[]
	| bigint[]
	| NbtValue[]
	| { [key: string]: NbtValue };

function parseNbt(bytes: Uint8Array): NbtValue {
	const reader = new NbtReader(bytes);
	const type = reader.u8();
	if (type !== 10) throw new Error('not NBT: the root tag is not a compound');
	reader.string(); // root name, usually "Schematic"
	return reader.payload(10);
}

class NbtReader {
	private at = 0;
	private readonly view: DataView;

	constructor(private readonly bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	u8(): number {
		return this.bytes[this.at++]!;
	}

	string(): string {
		const length = this.view.getUint16(this.at);
		this.at += 2;
		const slice = this.bytes.subarray(this.at, this.at + length);
		this.at += length;
		return new TextDecoder().decode(slice);
	}

	payload(type: number): NbtValue {
		switch (type) {
			case 1: {
				const v = this.view.getInt8(this.at);
				this.at += 1;
				return v;
			}
			case 2: {
				const v = this.view.getInt16(this.at);
				this.at += 2;
				return v;
			}
			case 3: {
				const v = this.view.getInt32(this.at);
				this.at += 4;
				return v;
			}
			case 4: {
				const v = this.view.getBigInt64(this.at);
				this.at += 8;
				return v;
			}
			case 5: {
				const v = this.view.getFloat32(this.at);
				this.at += 4;
				return v;
			}
			case 6: {
				const v = this.view.getFloat64(this.at);
				this.at += 8;
				return v;
			}
			case 7: {
				const length = this.view.getInt32(this.at);
				this.at += 4;
				const slice = this.bytes.subarray(this.at, this.at + length);
				this.at += length;
				// A copy, so the caller's data does not pin the whole file buffer.
				return slice.slice();
			}
			case 8:
				return this.string();
			case 9: {
				const childType = this.u8();
				const length = this.view.getInt32(this.at);
				this.at += 4;
				const out: NbtValue[] = [];
				for (let i = 0; i < length; i++) out.push(this.payload(childType));
				return out;
			}
			case 10: {
				const out: Record<string, NbtValue> = {};
				for (;;) {
					const childType = this.u8();
					if (childType === 0) return out;
					const name = this.string();
					out[name] = this.payload(childType);
				}
			}
			case 11: {
				const length = this.view.getInt32(this.at);
				this.at += 4;
				const out: number[] = [];
				for (let i = 0; i < length; i++) {
					out.push(this.view.getInt32(this.at));
					this.at += 4;
				}
				return out;
			}
			case 12: {
				const length = this.view.getInt32(this.at);
				this.at += 4;
				const out: bigint[] = [];
				for (let i = 0; i < length; i++) {
					out.push(this.view.getBigInt64(this.at));
					this.at += 8;
				}
				return out;
			}
			default:
				throw new Error(`not NBT: unknown tag type ${type}`);
		}
	}
}
