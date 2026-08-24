/**
 * 6-connected flood fill over cells sharing the hit's palette index.
 *
 * Bounded, and that bound is the feature. A build may legally hold 500,000 blocks, and a
 * checkerboard foundation or a stone shell is one connected region across most of it — an
 * unbounded flood there would spend a second or two building a multi-megabyte op while the
 * tab is frozen, on a gesture the user may well have meant as a single click. Stopping at
 * `FILL_CAP` and saying so leaves them with something undoable and an explanation.
 *
 * Connectivity is face-only. Diagonal connectivity would leak a wall fill through the corner
 * where two walls meet a floor of the same block, which reads as a bug rather than a feature.
 */

import { voxelIndex, type EditOp, type VoxelGrid } from '@imaginecraft/core';
import type { VoxelHit } from '../raycast.js';
import { EditBuilder } from './op.js';

export const FILL_CAP = 100_000;

export interface FillResult {
  /** Null when the region was already the target block. */
  op: EditOp | null;
  /** Cells the flood reached — not all of them necessarily changed. */
  cells: number;
  /** True when the region was larger than `cap` and the flood stopped early. */
  capped: boolean;
}

export function floodFill(
  grid: VoxelGrid,
  hit: VoxelHit,
  paletteIndex: number,
  cap: number = FILL_CAP,
): FillResult {
  const { size, voxels } = grid;
  if (hit.x < 0 || hit.y < 0 || hit.z < 0 || hit.x >= size.x || hit.y >= size.y || hit.z >= size.z) {
    return { op: null, cells: 0, capped: false };
  }

  const start = voxelIndex(size, hit.x, hit.y, hit.z);
  const target = voxels[start];
  if (target === undefined) return { op: null, cells: 0, capped: false };

  const limit = Math.max(1, Math.floor(cap));

  // One byte per cell — 10 MB at the largest legal size, transient, and far cheaper per
  // lookup than a Set once the region runs into six figures. The grid it shadows is already
  // twice that size, so this is not what decides whether a fill fits in memory.
  const seen = new Uint8Array(voxels.length);
  // Cells are marked on enqueue, so the queue can never hold more than `limit` entries and
  // needs no wraparound: it is a flat buffer walked once.
  const queue = new Uint32Array(limit);

  queue[0] = start;
  seen[start] = 1;
  let head = 0;
  let tail = 1;
  let capped = false;

  // Declared once and closed over `tail`/`capped`, rather than taking them as arguments:
  // this runs up to six times per cell, and a per-neighbour closure would allocate 600k
  // times on a capped fill.
  const enqueue = (index: number): void => {
    if (seen[index] === 1 || voxels[index] !== target) return;
    if (tail >= limit) {
      capped = true;
      return;
    }
    seen[index] = 1;
    queue[tail++] = index;
  };

  const layer = size.x * size.z;
  const builder = new EditBuilder(grid, Math.min(limit, 4096));

  while (head < tail) {
    const index = queue[head++]!;
    builder.set(index, paletteIndex);

    const y = Math.floor(index / layer);
    const rem = index - y * layer;
    const z = Math.floor(rem / size.x);
    const x = rem - z * size.x;

    // Bounds are checked per axis rather than by clamping the index, because the flat index
    // wraps between rows: x-1 at x=0 is the last cell of the previous row, not out of range.
    if (x > 0) enqueue(index - 1);
    if (x + 1 < size.x) enqueue(index + 1);
    if (z > 0) enqueue(index - size.x);
    if (z + 1 < size.z) enqueue(index + size.x);
    if (y > 0) enqueue(index - layer);
    if (y + 1 < size.y) enqueue(index + layer);
  }

  return { op: builder.build(), cells: head, capped };
}
