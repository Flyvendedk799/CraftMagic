/**
 * Grab: lift a whole connected structure into the clipboard with one click.
 *
 * The Box tool answers "take *this region*"; this answers "take *this thing*". Click any
 * block and the entire 6-connected mass it belongs to — a tree, a statue, a chimney — jumps
 * into the clipboard as a stamp and is erased from the build, ready to be put down somewhere
 * else. One undo puts it back where it was; the clipboard keeps the copy either way.
 *
 * Connectivity is face-adjacency across *any* non-air blocks, not same-kind: a thing is its
 * whole self, leaves and trunk together. The flood is capped like the fill's, because a
 * click on the ground floor of a fortress would otherwise pick up the fortress.
 */

import { AIR_BLOCK, AIR_INDEX, canonical, voxelIndex, type VoxelGrid } from '@craftmagic/core';
import type { VoxelHit } from '../raycast.js';
import type { Clip } from './clipboard.js';
import { EditBuilder } from './op.js';

/**
 * The most cells one grab will take. Above this the click almost certainly hit something
 * structural, and "you just picked up the castle" is not a good surprise. Deliberately far
 * below the clipboard's own cap, which is sized for regions someone aimed a box at.
 */
export const GRAB_CAP = 50_000;

export interface GrabResult {
  /** The lifted structure as a stamp, or null when nothing connected was found. */
  clip: Clip | null;
  /** The erase that removes the structure from the build. */
  op: ReturnType<EditBuilder['build']>;
  cells: number;
  /** True when the flood stopped at the cap — nothing was taken, see below. */
  capped: boolean;
  /**
   * The box the structure occupies, or null when nothing was found.
   *
   * Returned so a caller can *select* the thing instead of taking it. The bounding box is not
   * the structure — a tree's box holds a lot of air, and a chimney's holds some roof — but it
   * is a box you can see, which is the difference between a selection you can trust and one
   * you have to guess at.
   */
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
}

export function grabStructure(grid: VoxelGrid, hit: VoxelHit, cap: number = GRAB_CAP): GrabResult {
  const { size, voxels } = grid;
  if (hit.x < 0 || hit.y < 0 || hit.z < 0 || hit.x >= size.x || hit.y >= size.y || hit.z >= size.z) {
    return { clip: null, op: null, cells: 0, capped: false, bounds: null };
  }

  const start = voxelIndex(size, hit.x, hit.y, hit.z);
  if ((voxels[start] ?? AIR_INDEX) === AIR_INDEX) {
    return { clip: null, op: null, cells: 0, capped: false, bounds: null };
  }

  const layer = size.x * size.z;
  const seen = new Uint8Array(voxels.length);
  const queue = new Uint32Array(Math.min(voxels.length, cap + 8));
  const collected: number[] = [];
  let head = 0;
  let tail = 0;

  seen[start] = 1;
  queue[tail++] = start;

  while (head < tail) {
    const index = queue[head++]!;
    collected.push(index);
    // A structure one cell over the cap is refused whole rather than truncated: half a
    // grabbed statue in the clipboard and the other half still standing is worse than a
    // clear "too big".
    if (collected.length > cap) return { clip: null, op: null, cells: collected.length, capped: true, bounds: null };

    const y = Math.floor(index / layer);
    const rem = index - y * layer;
    const z = Math.floor(rem / size.x);
    const x = rem - z * size.x;

    const visit = (nx: number, ny: number, nz: number) => {
      if (nx < 0 || ny < 0 || nz < 0 || nx >= size.x || ny >= size.y || nz >= size.z) return;
      const next = voxelIndex(size, nx, ny, nz);
      if (seen[next] || (voxels[next] ?? AIR_INDEX) === AIR_INDEX) return;
      seen[next] = 1;
      if (tail < queue.length) queue[tail++] = next;
    };

    visit(x - 1, y, z);
    visit(x + 1, y, z);
    visit(x, y - 1, z);
    visit(x, y + 1, z);
    visit(x, y, z - 1);
    visit(x, y, z + 1);
  }

  // Bounds of what was collected, so the clip is exactly the structure's box.
  let minX = size.x, minY = size.y, minZ = size.z;
  let maxX = 0, maxY = 0, maxZ = 0;
  for (const index of collected) {
    const y = Math.floor(index / layer);
    const rem = index - y * layer;
    const z = Math.floor(rem / size.x);
    const x = rem - z * size.x;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const clipSize = { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 };
  const clipVoxels = new Uint16Array(clipSize.x * clipSize.y * clipSize.z);
  const palette: string[] = [AIR_BLOCK];
  const remap = new Map<number, number>();
  const builder = new EditBuilder(grid, collected.length);

  for (const index of collected) {
    const y = Math.floor(index / layer);
    const rem = index - y * layer;
    const z = Math.floor(rem / size.x);
    const x = rem - z * size.x;

    const source = voxels[index]!;
    let slot = remap.get(source);
    if (slot === undefined) {
      slot = palette.length;
      palette.push(canonical(grid.palette[source] ?? AIR_BLOCK));
      remap.set(source, slot);
    }
    clipVoxels[
      (x - minX) + (z - minZ) * clipSize.x + (y - minY) * clipSize.x * clipSize.z
    ] = slot;

    builder.setAt(x, y, z, AIR_INDEX);
  }

  return {
    clip: { size: clipSize, palette, voxels: clipVoxels, blocks: collected.length },
    op: builder.build(),
    cells: collected.length,
    capped: false,
    bounds: { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } },
  };
}
