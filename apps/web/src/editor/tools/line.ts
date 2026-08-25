/**
 * Straight runs between two picked cells.
 *
 * The tool nobody asks for by name and everybody needs: beams, frames, rooflines, fence
 * runs, the four edges of a floor. Doing those with the place tool means clicking each cell
 * and getting the diagonal subtly wrong; doing them with the box tool means filling a solid
 * slab and hollowing it back out.
 *
 * The path is a 3D Bresenham walk, so it is exactly one cell per step along the dominant
 * axis and never doubles back — the same line the game's own structure tools draw, which
 * matters because a line that "looks right" in the preview has to still look right after
 * it is placed.
 *
 * Unlike `place`, a line overwrites whatever it crosses. A line is a statement about both
 * of its endpoints, and one that silently skipped the wall in the middle would leave a beam
 * with a hole in it and no way to see why.
 */

import type { EditOp, VoxelGrid } from '@craftmagic/core';
import { brushEdit, type BrushOptions, type BrushResult, type Cell } from './brush.js';

/**
 * Cells along the segment from `a` to `b`, both ends included.
 *
 * Integer arithmetic throughout: floating-point stepping accumulates error over a 250-block
 * diagonal and lands the last cell off by one, which is exactly the cell the user aimed at.
 */
export function linePath(a: Cell, b: Cell): Cell[] {
  let x = Math.round(a.x);
  let y = Math.round(a.y);
  let z = Math.round(a.z);
  const x1 = Math.round(b.x);
  const y1 = Math.round(b.y);
  const z1 = Math.round(b.z);

  const dx = Math.abs(x1 - x);
  const dy = Math.abs(y1 - y);
  const dz = Math.abs(z1 - z);
  const sx = x1 > x ? 1 : -1;
  const sy = y1 > y ? 1 : -1;
  const sz = z1 > z ? 1 : -1;

  const out: Cell[] = [{ x, y, z }];

  // The driving axis is the longest one; the other two accumulate error against it and
  // step when they have earned a whole cell. Three branches rather than a generic loop
  // because the alternative is an axis-permutation table that is harder to read than this.
  if (dx >= dy && dx >= dz) {
    let ey = 2 * dy - dx;
    let ez = 2 * dz - dx;
    while (x !== x1) {
      x += sx;
      if (ey > 0) {
        y += sy;
        ey -= 2 * dx;
      }
      if (ez > 0) {
        z += sz;
        ez -= 2 * dx;
      }
      ey += 2 * dy;
      ez += 2 * dz;
      out.push({ x, y, z });
    }
  } else if (dy >= dx && dy >= dz) {
    let ex = 2 * dx - dy;
    let ez = 2 * dz - dy;
    while (y !== y1) {
      y += sy;
      if (ex > 0) {
        x += sx;
        ex -= 2 * dy;
      }
      if (ez > 0) {
        z += sz;
        ez -= 2 * dy;
      }
      ex += 2 * dx;
      ez += 2 * dz;
      out.push({ x, y, z });
    }
  } else {
    let ex = 2 * dx - dz;
    let ey = 2 * dy - dz;
    while (z !== z1) {
      z += sz;
      if (ex > 0) {
        x += sx;
        ex -= 2 * dz;
      }
      if (ey > 0) {
        y += sy;
        ey -= 2 * dz;
      }
      ex += 2 * dx;
      ey += 2 * dy;
      out.push({ x, y, z });
    }
  }

  return out;
}

export function lineEdit(
  grid: VoxelGrid,
  a: Cell,
  b: Cell,
  value: number,
  options: BrushOptions = {},
): BrushResult {
  return brushEdit(grid, linePath(a, b), value, options);
}

/** Convenience for callers that only want the op. */
export function lineOp(grid: VoxelGrid, a: Cell, b: Cell, value: number): EditOp | null {
  return lineEdit(grid, a, b, value).op;
}
