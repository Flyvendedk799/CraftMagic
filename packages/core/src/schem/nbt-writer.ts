/**
 * Minimal big-endian NBT writer.
 *
 * Hand-rolled rather than pulled from a library because this has to run in the browser as
 * well as on the server — exporting a schematic client-side costs us nothing — and because
 * writing NBT needs only the seven tag types below. `prismarine-nbt` stays a devDependency
 * purely to round-trip these bytes in tests, so we are still checked against a real parser.
 */

export const TAG_END = 0;
export const TAG_BYTE = 1;
export const TAG_SHORT = 2;
export const TAG_INT = 3;
export const TAG_STRING = 8;
export const TAG_COMPOUND = 10;
export const TAG_BYTE_ARRAY = 7;
export const TAG_INT_ARRAY = 11;

export class NbtWriter {
	private buffer: Uint8Array;
	private view: DataView;
	private offset = 0;

	constructor(initialCapacity = 1024) {
		this.buffer = new Uint8Array(initialCapacity);
		this.view = new DataView(this.buffer.buffer);
	}

	private ensure(extra: number): void {
		if (this.offset + extra <= this.buffer.length) return;
		let capacity = this.buffer.length * 2;
		while (capacity < this.offset + extra) capacity *= 2;
		const grown = new Uint8Array(capacity);
		grown.set(this.buffer.subarray(0, this.offset));
		this.buffer = grown;
		this.view = new DataView(this.buffer.buffer);
	}

	byte(value: number): void {
		this.ensure(1);
		this.view.setInt8(this.offset, value);
		this.offset += 1;
	}

	short(value: number): void {
		this.ensure(2);
		this.view.setInt16(this.offset, value, false);
		this.offset += 2;
	}

	int(value: number): void {
		this.ensure(4);
		this.view.setInt32(this.offset, value, false);
		this.offset += 4;
	}

	/** NBT strings are length-prefixed modified UTF-8; block ids are ASCII in practice. */
	string(value: string): void {
		const bytes = new TextEncoder().encode(value);
		this.short(bytes.length);
		this.ensure(bytes.length);
		this.buffer.set(bytes, this.offset);
		this.offset += bytes.length;
	}

	bytes(value: Uint8Array): void {
		this.ensure(value.length);
		this.buffer.set(value, this.offset);
		this.offset += value.length;
	}

	/** Tag header: type then name. Every tag inside a compound carries one. */
	tagHeader(type: number, name: string): void {
		this.byte(type);
		this.string(name);
	}

	namedByte(name: string, value: number): void {
		this.tagHeader(TAG_BYTE, name);
		this.byte(value);
	}

	namedShort(name: string, value: number): void {
		this.tagHeader(TAG_SHORT, name);
		this.short(value);
	}

	namedInt(name: string, value: number): void {
		this.tagHeader(TAG_INT, name);
		this.int(value);
	}

	namedString(name: string, value: string): void {
		this.tagHeader(TAG_STRING, name);
		this.string(value);
	}

	namedByteArray(name: string, value: Uint8Array): void {
		this.tagHeader(TAG_BYTE_ARRAY, name);
		this.int(value.length);
		this.bytes(value);
	}

	namedIntArray(name: string, value: readonly number[]): void {
		this.tagHeader(TAG_INT_ARRAY, name);
		this.int(value.length);
		for (const n of value) this.int(n);
	}

	beginCompound(name: string): void {
		this.tagHeader(TAG_COMPOUND, name);
	}

	endCompound(): void {
		this.byte(TAG_END);
	}

	finish(): Uint8Array {
		return this.buffer.slice(0, this.offset);
	}
}

/**
 * Unsigned LEB128, the encoding Sponge uses for `BlockData`.
 *
 * Palette indices above 127 need a continuation byte, which is exactly where naive
 * implementations break — a build with 128+ distinct blockstates is where you find out.
 */
export function writeVarInt(out: number[], value: number): void {
	let remaining = value >>> 0;
	while (remaining > 0x7f) {
		out.push((remaining & 0x7f) | 0x80);
		remaining >>>= 7;
	}
	out.push(remaining);
}

export function varIntBytes(values: Uint16Array): Uint8Array {
	// Most indices fit in one byte; sizing for that and letting the array grow beats
	// two passes over a large build.
	const out: number[] = [];
	for (let i = 0; i < values.length; i++) writeVarInt(out, values[i]!);
	return Uint8Array.from(out);
}
