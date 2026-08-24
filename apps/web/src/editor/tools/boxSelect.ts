/**
 * Box edits between two picked corners.
 *
 * Three modes rather than three tools, because they share every line except the predicate:
 * `fill` writes the block into every cell, `replace` only into cells that already hold
 * something (re-skin a wall without filling the room behind it), and `clear` empties the
 * box. `replace` is the one that makes the tool usable on a finished build — most of the
 * time the intent is "this region, but in spruce", not "this region, solid".
 */

import { AIR_INDEX, voxelIndex, type EditOp, type VoxelGrid } from '@imaginecraft/core';
import { EditBuilder } from './op.js';

export type BoxMode = 'fill' | 'replace' | 'clear';

export interface BoxCorner {
  x: number;
  y: number;
  z: number;
}

export interface BoxBounds {
  min: BoxCorner;
  max: BoxCorner;
  cells: number;
}

/** Normalised, clamped corners. Exported because the HUD previews the cell count. */
export function boxBounds(grid: VoxelGrid, a: BoxCorner, b: BoxCorner): BoxBounds {
  const { size } = grid;
  const clamp = (v: number, extent: number) => Math.min(extent - 1, Math.max(0, Math.floor(v)));

  const min = {
    x: clamp(Math.min(a.x, b.x), size.x),
    y: clamp(Math.min(a.y, b.y), size.y),
    z: clamp(Math.min(a.z, b.z), size.z),
  };
  const max = {
    x: clamp(Math.max(a.x, b.x), size.x),
    y: clamp(Math.max(a.y, b.y), size.y),
    z: clamp(Math.max(a.z, b.z), size.z),
  };

  return {
    min,
    max,
    cells: (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1),
  };
}

export function boxEdit(
  grid: VoxelGrid,
  a: BoxCorner,
  b: BoxCorner,
  mode: BoxMode,
  paletteIndex: number,
): EditOp | null {
  const { min, max, cells } = boxBounds(grid, a, b);
  const value = mode === 'clear' ? AIR_INDEX : paletteIndex;

  const builder = new EditBuilder(grid, cells);
  const { size, voxels } = grid;

  // y → z → x matches the YZX index order, so the inner loop walks contiguous memory and
  // the index is one addition rather than a multiply per cell.
  for (let y = min.y; y <= max.y; y++) {
    for (let z = min.z; z <= max.z; z++) {
      let index = voxelIndex(size, min.x, y, z);
      for (let x = min.x; x <= max.x; x++, index++) {
        if (mode === 'replace' && voxels[index] === AIR_INDEX) continue;
        builder.set(index, value);
      }
    }
  }

  return builder.build();
}
