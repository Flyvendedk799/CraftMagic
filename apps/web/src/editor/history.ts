/**
 * Undo/redo over `EditOp`s.
 *
 * Snapshots are the obvious alternative and the wrong one at this scale: a 200k-block grid is
 * 400 KB of `Uint16Array`, so remembering a hundred single-voxel edits by snapshot costs 40 MB
 * to preserve about a kilobyte of information. An op costs 8 bytes per voxel it actually
 * touched, and nothing for the ones it did not.
 *
 * That asymmetry is why there are two ceilings rather than one, and both — along with the
 * cursor, the redo-tail truncation and eviction from the bottom — now live in `studio/history`,
 * which the other two modes share. What is left here is the part that is genuinely about voxels:
 * what an op costs.
 *
 * The history stores ops; it never applies them. `VoxelWorld.applyEdit`/`revertEdit` own that,
 * so this module has no opinion about grids, meshing or React and is testable on its own.
 */

import type { EditOp } from '@craftmagic/core';
import { History } from '../studio/history.js';

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

/**
 * The editor's stack.
 *
 * A thin naming layer over the shared one: `ops`/`maxOps` are what the editor and its tests have
 * always called these, and renaming them to match the generic would be churn in a dozen files to
 * no one's benefit.
 */
export class EditHistory {
  private readonly inner: History<EditOp>;

  constructor(limits: EditHistoryLimits = {}) {
    this.inner = new History(costOf, {
      maxEntries: limits.maxOps ?? MAX_OPS,
      maxBytes: limits.maxBytes ?? MAX_BYTES,
    });
  }

  get canUndo(): boolean {
    return this.inner.canUndo;
  }

  get canRedo(): boolean {
    return this.inner.canRedo;
  }

  /** Ops on the stack, undo tail plus redo tail. Diagnostics only. */
  get depth(): number {
    return this.inner.depth;
  }

  /** Total payload currently retained. The HUD and the tests both read this. */
  get bytes(): number {
    return this.inner.bytes;
  }

  push(op: EditOp): void {
    this.inner.push(op);
  }

  /** The op to revert, or null at the bottom of the stack. */
  undo(): EditOp | null {
    return this.inner.undo();
  }

  /** The op to re-apply, or null if nothing was undone. */
  redo(): EditOp | null {
    return this.inner.redo();
  }

  clear(): void {
    this.inner.clear();
  }
}
