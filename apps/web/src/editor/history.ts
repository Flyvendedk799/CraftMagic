/**
 * Undo/redo over `EditOp`s.
 *
 * Snapshots are the obvious alternative and the wrong one at this scale: a 200k-block grid
 * is 400 KB of `Uint16Array`, so remembering a hundred single-voxel edits by snapshot costs
 * 40 MB to preserve about a kilobyte of information. An op costs 8 bytes per voxel it
 * actually touched, and nothing for the ones it did not.
 *
 * That asymmetry is also why there are two ceilings rather than one. A depth limit alone
 * cannot bound memory — a single box fill over a 150×60×150 region is 10 MB, and a hundred
 * of those is a gigabyte. A byte limit alone would let ten thousand one-voxel pokes pile up
 * and turn every undo into a linear walk. Whichever binds first wins.
 *
 * The history stores ops; it never applies them. `VoxelWorld.applyEdit`/`revertEdit` own
 * that, so this module has no opinion about grids, meshing or React and is testable on its
 * own.
 */

import type { EditOp } from '@imaginecraft/core';

/** Depth ceiling. Deep enough that undo feels unlimited in practice. */
export const MAX_OPS = 100;

/** Payload ceiling for the whole stack, in bytes. */
export const MAX_BYTES = 64 * 1024 * 1024;

export interface EditHistoryLimits {
  maxOps?: number;
  maxBytes?: number;
}

/** Uint32 index + Uint16 before + Uint16 after. */
function costOf(op: EditOp): number {
  return op.indices.byteLength + op.before.byteLength + op.after.byteLength;
}

export class EditHistory {
  /** Oldest first. Entries below `cursor` are applied; entries from it up are the redo tail. */
  private readonly ops: EditOp[] = [];
  /**
   * Byte cost per op, parallel to `ops`. Kept rather than recomputed because eviction has
   * to subtract a cost on a stack that may already be a hundred ops deep, and doing that by
   * re-measuring turns every push into an O(depth) walk.
   */
  private readonly costs: number[] = [];

  private cursor = 0;
  private total = 0;

  private readonly maxOps: number;
  private readonly maxBytes: number;

  constructor(limits: EditHistoryLimits = {}) {
    this.maxOps = Math.max(1, limits.maxOps ?? MAX_OPS);
    this.maxBytes = Math.max(1, limits.maxBytes ?? MAX_BYTES);
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.ops.length;
  }

  /** Ops on the stack, undo tail plus redo tail. Diagnostics only. */
  get depth(): number {
    return this.ops.length;
  }

  /** Total payload currently retained. The HUD and the tests both read this. */
  get bytes(): number {
    return this.total;
  }

  /**
   * Record an op that has already been applied.
   *
   * Pushing after an undo discards the redo tail. Anything else means keeping a redo that
   * would replay onto voxels its `before` no longer describes — the branch is unreachable
   * from here, so it is dropped rather than kept as a booby trap.
   */
  push(op: EditOp): void {
    for (let i = this.ops.length - 1; i >= this.cursor; i--) this.total -= this.costs[i]!;
    this.ops.length = this.cursor;
    this.costs.length = this.cursor;

    this.ops.push(op);
    this.costs.push(costOf(op));
    this.total += this.costs[this.costs.length - 1]!;
    this.cursor++;

    // `length > 1` rather than `length > 0`: an op that is on its own bigger than the byte
    // ceiling would otherwise evict itself, leaving an edit on screen that cannot be undone.
    // Keeping it costs one op's worth of overshoot and keeps undo honest.
    while (this.ops.length > 1 && (this.ops.length > this.maxOps || this.total > this.maxBytes)) {
      this.total -= this.costs.shift()!;
      this.ops.shift();
      this.cursor--;
    }
  }

  /** The op to revert, or null at the bottom of the stack. */
  undo(): EditOp | null {
    if (!this.canUndo) return null;
    this.cursor--;
    return this.ops[this.cursor]!;
  }

  /** The op to re-apply, or null if nothing was undone. */
  redo(): EditOp | null {
    if (!this.canRedo) return null;
    const op = this.ops[this.cursor]!;
    this.cursor++;
    return op;
  }

  clear(): void {
    this.ops.length = 0;
    this.costs.length = 0;
    this.cursor = 0;
    this.total = 0;
  }
}
