import { describe, expect, it } from 'vitest';
import type { EditOp, VoxelGrid } from '@craftmagic/core';
import { EditHistory } from './history.js';

/**
 * `VoxelWorld` is the only thing that applies ops in the app, and it drags in three.js, so
 * these tests carry their own two-line applier. That is not duplication worth avoiding —
 * what is under test is the *stack*, and pinning the round-trip to a grid the test owns is
 * what proves undo restores the exact bytes rather than merely the right cells.
 */
function applyOp(grid: VoxelGrid, op: EditOp, direction: 'after' | 'before'): void {
  const values = op[direction];
  for (let i = 0; i < op.indices.length; i++) grid.voxels[op.indices[i]!] = values[i]!;
}

function makeGrid(cells: number): VoxelGrid {
  const voxels = new Uint16Array(cells);
  for (let i = 0; i < cells; i++) voxels[i] = i % 7;
  return { size: { x: cells, y: 1, z: 1 }, palette: ['minecraft:air'], voxels };
}

/** An op that sets `count` consecutive cells starting at `from` to `value`. */
function opOver(grid: VoxelGrid, from: number, count: number, value: number): EditOp {
  const indices = new Uint32Array(count);
  const before = new Uint16Array(count);
  const after = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    indices[i] = from + i;
    before[i] = grid.voxels[from + i]!;
    after[i] = value;
  }
  return { indices, before, after };
}

describe('EditHistory', () => {
  it('round-trips a stack of edits back to the exact original bytes', () => {
    const grid = makeGrid(512);
    const original = grid.voxels.slice();
    const history = new EditHistory();

    for (let n = 0; n < 20; n++) {
      const op = opOver(grid, n * 7, 11, 40 + n);
      applyOp(grid, op, 'after');
      history.push(op);
    }
    expect(grid.voxels).not.toEqual(original);

    for (let n = 0; n < 20; n++) {
      const op = history.undo();
      expect(op).not.toBeNull();
      applyOp(grid, op!, 'before');
    }

    expect(history.undo()).toBeNull();
    expect(history.canUndo).toBe(false);
    // Byte-exact, not merely "looks restored": overlapping ops make the order load-bearing.
    expect(grid.voxels).toEqual(original);

    // And forwards again.
    let op: EditOp | null;
    while ((op = history.redo()) !== null) applyOp(grid, op, 'after');
    expect(history.canRedo).toBe(false);

    const redone = grid.voxels.slice();
    while ((op = history.undo()) !== null) applyOp(grid, op, 'before');
    expect(grid.voxels).toEqual(original);
    expect(redone).not.toEqual(original);
  });

  it('drops the redo tail when a new edit is pushed after an undo', () => {
    const grid = makeGrid(64);
    const history = new EditHistory();

    const first = opOver(grid, 0, 4, 1);
    applyOp(grid, first, 'after');
    history.push(first);

    const second = opOver(grid, 8, 4, 2);
    applyOp(grid, second, 'after');
    history.push(second);

    applyOp(grid, history.undo()!, 'before');
    expect(history.canRedo).toBe(true);

    const branch = opOver(grid, 16, 4, 3);
    applyOp(grid, branch, 'after');
    history.push(branch);

    expect(history.canRedo).toBe(false);
    expect(history.depth).toBe(2);
    // The discarded op's payload must not still be counted against the memory ceiling.
    expect(history.bytes).toBe(byteCost(first) + byteCost(branch));

    // Undoing twice lands on the branch and then the first edit, never on `second`.
    expect(history.undo()).toBe(branch);
    expect(history.undo()).toBe(first);
    expect(history.undo()).toBeNull();
  });

  it('evicts the oldest ops past the depth limit', () => {
    const grid = makeGrid(4096);
    const history = new EditHistory({ maxOps: 5 });

    const ops: EditOp[] = [];
    for (let n = 0; n < 12; n++) {
      const op = opOver(grid, n * 4, 2, 100 + n);
      ops.push(op);
      history.push(op);
    }

    expect(history.depth).toBe(5);
    const seen: EditOp[] = [];
    let op: EditOp | null;
    while ((op = history.undo()) !== null) seen.push(op);
    // Newest first, and nothing older than the last five survived.
    expect(seen).toEqual([ops[11], ops[10], ops[9], ops[8], ops[7]]);
  });

  it('evicts on payload size before the depth limit is reached', () => {
    const grid = makeGrid(200_000);
    // 10 cells is 80 bytes, so eight ops fit and the ninth pushes one out — well short of
    // the 100-op depth limit, which is the case a depth-only cap would miss entirely.
    const history = new EditHistory({ maxOps: 100, maxBytes: 8 * 80 });

    for (let n = 0; n < 9; n++) history.push(opOver(grid, n * 10, 10, 1));

    expect(history.depth).toBe(8);
    expect(history.bytes).toBeLessThanOrEqual(8 * 80);
  });

  it('keeps a single op that is on its own over the byte ceiling', () => {
    const grid = makeGrid(50_000);
    const history = new EditHistory({ maxBytes: 64 });

    const huge = opOver(grid, 0, 40_000, 3);
    applyOp(grid, huge, 'after');
    history.push(huge);

    // Evicting it would leave a visible edit with no way to undo it, which is worse than
    // overshooting the ceiling by one op.
    expect(history.depth).toBe(1);
    expect(history.canUndo).toBe(true);
    expect(history.undo()).toBe(huge);
  });

  it('clears', () => {
    const grid = makeGrid(64);
    const history = new EditHistory();
    history.push(opOver(grid, 0, 4, 1));
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.bytes).toBe(0);
    expect(history.depth).toBe(0);
  });
});

function byteCost(op: EditOp): number {
  return op.indices.byteLength + op.before.byteLength + op.after.byteLength;
}
