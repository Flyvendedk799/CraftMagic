/**
 * Prefabs: a finished build, embedded in a program so it can be placed inside another one.
 *
 * Everything else in the IR is *parametric* — a box knows its corners as expressions, so a
 * resize re-derives it. A prefab is the opposite and deliberately so: it is a building
 * somebody already made and saved, and the whole point of placing one is that it comes out
 * exactly as it went in. That is also why a prefab is the only way a *hand-edited* build can
 * be reused. Once someone has placed blocks by hand there is no program describing them, and
 * a component that could only hold shapes could never hold that.
 *
 * ## Where the bytes live
 *
 * The voxels sit in `program.prefabs`, keyed, and components reference them by key. Four
 * corner towers are one entry and four `{ type: 'prefab', ref, pos }` components, which
 * matters three times over: the program is a quarter the size, the model that reads it during
 * a refine sees four legible one-line placements instead of four walls of numbers, and moving
 * one tower cannot accidentally edit the other three.
 *
 * ## The encoding
 *
 * Run-length pairs over the palette indices in YZX order — the same order `VoxelGrid` uses,
 * so encoding is a straight walk — then base64. Builds are overwhelmingly air with long runs
 * of one block, so this is worth roughly an order of magnitude over the raw array and it
 * survives `JSON.stringify` without becoming a five-figure list of integers.
 *
 * A run is two varints: palette index, then length. Varints because the common case by far is
 * a small index and a run under 128, which is one byte each. The base64 comes from
 * `util/bytes.ts`, shared with the voxel blob on the wire and the terrain heightmap.
 */

import { fromBase64, toBase64 } from '../util/bytes.js';
import { AIR_BLOCK, voxelIndex, type BlockRef, type Vec3, type VoxelGrid } from './types.js';

/** A finished build, ready to be stamped into another one. */
export interface Prefab {
  /** Extent in blocks. Never scaled — a prefab is an artifact, not a shape. */
  size: { x: number; y: number; z: number };
  /** Index 0 is always air, matching `VoxelGrid`. */
  palette: BlockRef[];
  /** Base64 of run-length-encoded palette indices, YZX order. */
  data: string;
}

/** How many non-air blocks a prefab holds, without decoding it into a grid. */
export function prefabBlockCount(prefab: Prefab): number {
  let count = 0;
  forEachPrefabRun(prefab, (index, length) => {
    if (index !== 0) count += length;
  });
  return count;
}

/**
 * Walk a prefab's runs in place.
 *
 * A callback rather than a returned array: the largest legal prefab is 10.5 million cells,
 * and the two callers (the expander and the block count) both consume runs streaming.
 */
export function forEachPrefabRun(
  prefab: Prefab,
  visit: (paletteIndex: number, length: number, start: number) => void,
): void {
  const bytes = fromBase64(prefab.data);
  let at = 0;
  let cell = 0;

  while (at < bytes.length) {
    const index = readVarint(bytes, at);
    at = index.next;
    const length = readVarint(bytes, at);
    at = length.next;
    if (length.value <= 0) continue;
    visit(index.value, length.value, cell);
    cell += length.value;
  }
}

/**
 * Pack a grid into a prefab.
 *
 * The palette is copied as-is rather than compacted. A saved build's palette is already the
 * one the expander interned for it, entries nothing references cost four bytes of JSON each,
 * and renumbering would mean rewriting every index for no gain anyone can measure.
 */
export function encodePrefab(grid: VoxelGrid): Prefab {
  const bytes: number[] = [];
  const total = grid.size.x * grid.size.y * grid.size.z;

  let run = 0;
  let current = grid.voxels[0] ?? 0;

  const flush = () => {
    if (run === 0) return;
    writeVarint(bytes, current);
    writeVarint(bytes, run);
    run = 0;
  };

  for (let i = 0; i < total; i++) {
    const value = grid.voxels[i] ?? 0;
    if (value === current) {
      run++;
      continue;
    }
    flush();
    current = value;
    run = 1;
  }
  flush();

  return {
    size: { ...grid.size },
    // Air first, always: the expander skips index 0 without consulting the palette, and a
    // prefab whose slot 0 was something else would stamp air-shaped holes of stone.
    palette: grid.palette[0] === AIR_BLOCK ? [...grid.palette] : [AIR_BLOCK, ...grid.palette],
    data: toBase64(Uint8Array.from(bytes)),
  };
}

/**
 * Unpack a prefab back into a grid.
 *
 * Only used by tests and by anything that wants to inspect a placed build on its own; the
 * expander stamps runs directly and never materialises this.
 */
export function decodePrefab(prefab: Prefab): VoxelGrid {
  const size = prefab.size;
  const voxels = new Uint16Array(size.x * size.y * size.z);

  forEachPrefabRun(prefab, (index, length, start) => {
    if (index === 0) return;
    const end = Math.min(start + length, voxels.length);
    for (let cell = start; cell < end; cell++) voxels[cell] = index;
  });

  return { size: { ...size }, palette: [...prefab.palette], voxels };
}

/**
 * The footprint a prefab occupies once turned. Odd quarters swap width and depth.
 *
 * Exported because three places need the same answer and disagreeing is invisible: the
 * compiler positions the placement, the plan canvas draws its outline, and the inspector
 * reports its size.
 */
export function turnedPrefabSize(
  size: { x: number; y: number; z: number },
  turns: number,
): { x: number; y: number; z: number } {
  const steps = ((turns % 4) + 4) % 4;
  return steps % 2 === 0 ? { ...size } : { x: size.z, y: size.y, z: size.x };
}

/**
 * How far to shift a turned prefab so its min corner lands back on the origin.
 *
 * A quarter turn about `(0,0)` sends the footprint into negative space — clockwise puts
 * `x` in `[-(d-1), 0]` — so every placement needs this correction before it can be talked
 * about as "the building at (x, z)". Kept here beside the turn it undoes.
 */
export function turnedPrefabOffset(
  size: { x: number; y: number; z: number },
  turns: number,
): { x: number; z: number } {
  switch (((turns % 4) + 4) % 4) {
    case 1:
      return { x: size.z - 1, z: 0 };
    case 2:
      return { x: size.x - 1, z: size.z - 1 };
    case 3:
      return { x: 0, z: size.x - 1 };
    default:
      return { x: 0, z: 0 };
  }
}

/** The cell at a position inside a prefab, in the same YZX order as a `VoxelGrid`. */
export function prefabIndex(prefab: Prefab, x: number, y: number, z: number): number {
  return voxelIndex(prefab.size, x, y, z);
}

/** Position of a cell index inside a prefab. */
export function prefabPosition(prefab: Prefab, index: number): Vec3 {
  const layer = prefab.size.x * prefab.size.z;
  const y = Math.floor(index / layer);
  const rest = index - y * layer;
  const z = Math.floor(rest / prefab.size.x);
  return [rest - z * prefab.size.x, y, z];
}

// --- varints ------------------------------------------------------------------------------
// Hand-rolled rather than pulled in: this runs in the browser, on the server and in the mod's
// build step, and it is twenty lines. Base64 lives in `util/bytes.ts` — three codecs share it
// now, and three private copies is how one of them ends up subtly different.

function writeVarint(out: number[], value: number): void {
	let rest = value >>> 0;
	while (rest >= 0x80) {
		out.push((rest & 0x7f) | 0x80);
		rest >>>= 7;
	}
	out.push(rest);
}

function readVarint(bytes: Uint8Array, at: number): { value: number; next: number } {
	let value = 0;
	let shift = 0;
	let index = at;

	while (index < bytes.length) {
		const byte = bytes[index]!;
		index++;
		value |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) break;
		shift += 7;
	}

	return { value: value >>> 0, next: index };
}
