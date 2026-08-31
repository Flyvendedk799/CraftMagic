/**
 * Lift: pick up one block and put it down somewhere else.
 *
 * The gap this fills is small to describe and was large to live with. Grab answers "take
 * *this thing*" and the Box tool answers "take *this region*", but the most ordinary edit of
 * all — that block, one course to the left — had no gesture at all. It was erase, re-aim,
 * place: three actions, two undo entries, and a lost block state if the block was a stair
 * facing a direction the picker does not carry.
 *
 * A move is deliberately *not* an erase followed by a place. It is one op over two cells, so
 * it is one press of Ctrl+Z, and the palette index travels rather than the block ref — which
 * is what keeps the stair's facing, the log's axis and the slab's half exactly as they were.
 * A block that leaves the grid or lands on top of something is refused rather than resolved
 * generously: the drop cell comes from the same `placementCell` a place uses, so the only
 * ways to get here are aiming at the edge of the plot or at a face with no room in front of
 * it, and quietly deleting whatever was in the way is not a good answer to either.
 */

import { AIR_INDEX, voxelIndex, type EditOp, type VoxelGrid } from '@craftmagic/core';
import type { Cell } from './brush.js';
import { EditBuilder } from './op.js';

export interface LiftResult {
  /** The move, or null when nothing happened. */
  op: EditOp | null;
  /** Why nothing happened, when the answer is anything other than "it did not move". */
  refusal: string | null;
}

const NOTHING = { op: null, refusal: null } as const;

/** True for a cell inside the grid. */
function inside(grid: VoxelGrid, cell: Cell): boolean {
  const { size } = grid;
  return (
    cell.x >= 0 && cell.y >= 0 && cell.z >= 0 &&
    cell.x < size.x && cell.y < size.y && cell.z < size.z
  );
}

/**
 * Move the block at `from` to `to`.
 *
 * Null op and no refusal for a move that goes nowhere: a drag that ends where it started is
 * a change of mind, not an error, and it should not push an undo entry or say anything.
 */
export function liftBlock(grid: VoxelGrid, from: Cell, to: Cell): LiftResult {
  if (!inside(grid, from) || !inside(grid, to)) {
    return { op: null, refusal: 'That is off the edge of the plot.' };
  }

  const value = grid.voxels[voxelIndex(grid.size, from.x, from.y, from.z)] ?? AIR_INDEX;
  if (value === AIR_INDEX) return { op: null, refusal: 'Nothing there to move.' };

  if (from.x === to.x && from.y === to.y && from.z === to.z) return NOTHING;

  if ((grid.voxels[voxelIndex(grid.size, to.x, to.y, to.z)] ?? AIR_INDEX) !== AIR_INDEX) {
    return { op: null, refusal: 'Something is already there — drop it against a free face.' };
  }

  // Two cells, one op. Written destination-first only for readability; `EditBuilder` records
  // both against the grid as it stands, so the order of the two writes cannot matter.
  const builder = new EditBuilder(grid, 2);
  builder.setAt(to.x, to.y, to.z, value);
  builder.setAt(from.x, from.y, from.z, AIR_INDEX);
  return { op: builder.build(), refusal: null };
}
