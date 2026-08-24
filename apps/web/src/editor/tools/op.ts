/**
 * Shared `EditOp` construction.
 *
 * Every tool ends up doing the same thing — walk some cells, decide a new palette index,
 * remember what was there — and the temptation is to collect `{index, before, after}`
 * objects and convert at the end. At the 100k-cell cap a fill would allocate 100k objects
 * to produce three typed arrays, which is most of a garbage collection pause for nothing.
 * This builder writes straight into growable typed arrays instead.
 *
 * The builder reads `before` from the grid on `set`, so it must be used *before* the op is
 * applied. That is the natural order — tools are pure and the caller applies afterwards —
 * but it does mean a builder is single-use against a grid it does not mutate.
 */

import { voxelIndex, type EditOp, type VoxelGrid } from '@craftmagic/core';

export class EditBuilder {
  private indices: Uint32Array;
  private before: Uint16Array;
  private after: Uint16Array;
  private n = 0;

  /**
   * `capacity` is a hint only. Callers that know the exact cell count should pass it —
   * a box fill knows its volume — but it is clamped, because a box over a full 256³ grid
   * would otherwise pre-allocate 130 MB for an op that may change three voxels.
   */
  constructor(
    private readonly grid: VoxelGrid,
    capacity = 64,
  ) {
    const cap = Math.min(Math.max(1, Math.ceil(capacity)), 1 << 18);
    this.indices = new Uint32Array(cap);
    this.before = new Uint16Array(cap);
    this.after = new Uint16Array(cap);
  }

  /** Cells recorded so far — i.e. cells that would actually change. */
  get size(): number {
    return this.n;
  }

  /**
   * Record a change at a flat voxel index. Returns false when nothing was recorded.
   *
   * Cells already holding `value` are skipped rather than recorded as no-ops: they would
   * inflate the undo record, and a fill that changes nothing should produce a null op so
   * the caller can leave the history alone.
   */
  set(index: number, value: number): boolean {
    const prev = this.grid.voxels[index];
    if (prev === undefined || prev === value) return false;

    if (this.n === this.indices.length) this.grow();
    this.indices[this.n] = index;
    this.before[this.n] = prev;
    this.after[this.n] = value;
    this.n++;
    return true;
  }

  /** Bounds-checked coordinate form. Out-of-range cells are silently ignored. */
  setAt(x: number, y: number, z: number, value: number): boolean {
    const { size } = this.grid;
    if (x < 0 || y < 0 || z < 0 || x >= size.x || y >= size.y || z >= size.z) return false;
    return this.set(voxelIndex(size, x, y, z), value);
  }

  /** Null when nothing changed, so an empty edit never reaches the history. */
  build(): EditOp | null {
    if (this.n === 0) return null;
    // `slice` and not `subarray`: the op outlives this builder inside the undo stack, and a
    // view onto an oversized backing buffer would pin up to twice the memory it needs.
    return {
      indices: this.indices.slice(0, this.n),
      before: this.before.slice(0, this.n),
      after: this.after.slice(0, this.n),
    };
  }

  private grow(): void {
    const cap = this.indices.length * 2;
    const indices = new Uint32Array(cap);
    indices.set(this.indices);
    const before = new Uint16Array(cap);
    before.set(this.before);
    const after = new Uint16Array(cap);
    after.set(this.after);
    this.indices = indices;
    this.before = before;
    this.after = after;
  }
}

/** Net change in non-air blocks, so the HUD's block count can follow edits without rescanning. */
export function blockDelta(op: EditOp): number {
  let delta = 0;
  for (let i = 0; i < op.indices.length; i++) {
    const was = op.before[i] !== 0;
    const is = op.after[i] !== 0;
    if (was !== is) delta += is ? 1 : -1;
  }
  return delta;
}
