/**
 * The eyedropper.
 *
 * Two lines of work and the single biggest thing missing from the editing loop: without it,
 * matching a block that is already in the build means reading its name off the hover
 * readout, opening the picker, and typing it back in — for a block the pointer is already
 * touching. With it, Alt+click makes what you are pointing at the active block.
 *
 * Air picks nothing rather than picking "air". Selecting air as the block to place would
 * turn the place tool into a second, worse erase tool, and there is no way back from it
 * except reopening the picker.
 */

import { AIR_INDEX, voxelIndex, type BlockRef, type VoxelGrid } from '@craftmagic/core';
import type { Cell } from './brush.js';

export function pickBlock(grid: VoxelGrid, cell: Cell): BlockRef | null {
  const { size } = grid;
  if (cell.x < 0 || cell.y < 0 || cell.z < 0) return null;
  if (cell.x >= size.x || cell.y >= size.y || cell.z >= size.z) return null;

  const slot = grid.voxels[voxelIndex(size, cell.x, cell.y, cell.z)] ?? AIR_INDEX;
  if (slot === AIR_INDEX) return null;
  return grid.palette[slot] ?? null;
}
