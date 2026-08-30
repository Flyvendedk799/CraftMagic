/**
 * Base64, without assuming a runtime.
 *
 * `btoa`/`atob` exist in browsers and in modern Node but not in every context this package is
 * imported from, and `Buffer` is Node-only. Encoding by hand is the only version that behaves
 * identically everywhere, which for bytes written on a server and read in a browser matters
 * more than the microseconds.
 *
 * Lifted out of `ir/prefab.ts`, which had the only copy. Three callers now want it — the
 * prefab codec, the voxel blob on its way through an HTTP body, and the terrain heightmap —
 * and three private copies of a base64 decoder is how one of them ends up subtly different.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const a = bytes[i]!;
		const b = bytes[i + 1];
		const c = bytes[i + 2];
		out += ALPHABET[a >> 2];
		out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
		out += b === undefined ? '=' : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
		out += c === undefined ? '=' : ALPHABET[c & 63];
	}
	return out;
}

const LOOKUP = (() => {
	const table = new Int16Array(128).fill(-1);
	for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
	return table;
})();

/** Tolerant: whitespace, newlines and padding are skipped rather than rejected. */
export function fromBase64(text: string): Uint8Array {
	const out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3);
	let at = 0;
	let buffer = 0;
	let bits = 0;

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		const value = code < 128 ? (LOOKUP[code] ?? -1) : -1;
		if (value < 0) continue;
		buffer = (buffer << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[at++] = (buffer >> bits) & 0xff;
		}
	}

	return out.subarray(0, at);
}
