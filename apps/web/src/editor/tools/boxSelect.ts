/**
 * Box edits between two picked corners.
 *
 * Four modes rather than four tools, because they share every line except the predicate:
 * `fill` writes the block into every cell, `replace` only into cells that already hold
 * something (re-skin a wall without filling the room behind it), `hollow` writes only the
 * six faces of the box, and `clear` empties it. `replace` is the one that makes the tool
 * usable on a finished build — most of the time the intent is "this region, but in spruce",
 * not "this region, solid" — and `hollow` is the one that makes it usable on an empty plot,
 * where a room is a box with the inside left out.
 */

import { AIR_INDEX, voxelIndex, type EditOp, type VoxelGrid } from '@craftmagic/core';
import { EditBuilder } from './op.js';

export type BoxMode = 'fill' | 'replace' | 'hollow' | 'clear';

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
    const yShell = y === min.y || y === max.y;
    for (let z = min.z; z <= max.z; z++) {
      const zShell = z === min.z || z === max.z;
      let index = voxelIndex(size, min.x, y, z);
      for (let x = min.x; x <= max.x; x++, index++) {
        if (mode === 'replace' && voxels[index] === AIR_INDEX) continue;
        // A cell is on the shell if it is extreme on any one axis. A box thinner than three
        // cells on some axis is therefore entirely shell, which is right: a 1-block-thick
        // wall hollowed out is still the wall.
        if (mode === 'hollow' && !yShell && !zShell && x !== min.x && x !== max.x) continue;
        builder.set(index, value);
      }
    }
  }

  return builder.build();
}

/**
 * Shift everything inside a box, leaving air behind it.
 *
 * The one region operation that cannot be expressed as "walk the cells and decide a value
 * from what is there": a move of less than the region's own width overlaps its own source, so
 * the contents have to be read out in full before any of them is written back. Reading into a
 * buffer first is not an optimisation here — it is the difference between moving a wall and
 * smearing it.
 *
 * Each cell of the union of source and destination is then decided *once*, and that matters
 * more than it looks. Writing air over the source and then the contents at the offset, as two
 * passes, records two changes for every overlapping cell — and the second is skipped whenever
 * the moved value happens to equal what was already there, which is most of the interior of
 * anything uniform. A slab nudged one block along its own length would come back hollow.
 *
 * Cells that would leave the grid are dropped rather than clamped. Clamping would pile the
 * overhanging slice against the far wall — a move that quietly deforms what it moved — where
 * dropping is the rule the rest of the editor already applies at its edges.
 */
export function moveEdit(
  grid: VoxelGrid,
  a: BoxCorner,
  b: BoxCorner,
  dx: number,
  dy: number,
  dz: number,
): EditOp | null {
  if (dx === 0 && dy === 0 && dz === 0) return null;

  const { min, max, cells } = boxBounds(grid, a, b);
  const { size, voxels } = grid;

  const width = max.x - min.x + 1;
  const depth = max.z - min.z + 1;
  const held = new Uint16Array(cells);
  const at = (x: number, y: number, z: number) =>
    x - min.x + (z - min.z) * width + (y - min.y) * width * depth;

  for (let y = min.y; y <= max.y; y++) {
    for (let z = min.z; z <= max.z; z++) {
      for (let x = min.x; x <= max.x; x++) {
        held[at(x, y, z)] = voxels[voxelIndex(size, x, y, z)]!;
      }
    }
  }

  const inSource = (x: number, y: number, z: number) =>
    x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z;

  const builder = new EditBuilder(grid, cells * 2);
  // The union of where the contents came from and where they are going. Everything outside it
  // is untouched by definition, and everything inside it gets exactly one verdict.
  const lo = { x: Math.min(min.x, min.x + dx), y: Math.min(min.y, min.y + dy), z: Math.min(min.z, min.z + dz) };
  const hi = { x: Math.max(max.x, max.x + dx), y: Math.max(max.y, max.y + dy), z: Math.max(max.z, max.z + dz) };

  for (let y = lo.y; y <= hi.y; y++) {
    for (let z = lo.z; z <= hi.z; z++) {
      for (let x = lo.x; x <= hi.x; x++) {
        const from = { x: x - dx, y: y - dy, z: z - dz };
        // Destination wins over source, which is what makes an overlapping move a move.
        if (inSource(from.x, from.y, from.z)) {
          builder.setAt(x, y, z, held[at(from.x, from.y, from.z)]!);
        } else if (inSource(x, y, z)) {
          builder.setAt(x, y, z, AIR_INDEX);
        }
      }
    }
  }

  return builder.build();
}
