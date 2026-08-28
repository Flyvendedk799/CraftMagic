import { describe, expect, it } from 'vitest';
import { voxelIndex, type EditOp, type VoxelGrid } from '@craftmagic/core';
import { boxBounds, boxEdit, moveEdit } from './boxSelect.js';

function grid8(): VoxelGrid {
  const size = { x: 8, y: 8, z: 8 };
  const voxels = new Uint16Array(size.x * size.y * size.z);
  // A 4×4 pad on the floor, so `replace` has something to distinguish from air.
  for (let z = 0; z < 4; z++) {
    for (let x = 0; x < 4; x++) voxels[voxelIndex(size, x, 0, z)] = 1;
  }
  return { size, palette: ['minecraft:air', 'minecraft:stone', 'minecraft:oak_planks'], voxels };
}

describe('boxBounds', () => {
  it('normalises corner order and clamps to the grid', () => {
    const grid = grid8();
    const bounds = boxBounds(grid, { x: 6, y: 3, z: 1 }, { x: 2, y: 0, z: 40 });
    expect(bounds.min).toEqual({ x: 2, y: 0, z: 1 });
    expect(bounds.max).toEqual({ x: 6, y: 3, z: 7 });
    expect(bounds.cells).toBe(5 * 4 * 7);
  });
});

describe('boxEdit', () => {
  it('fills every cell in the box', () => {
    const grid = grid8();
    const op = boxEdit(grid, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, 'fill', 2);
    // Eight cells, four of which were stone and four air — all eight change.
    expect(op!.indices).toHaveLength(8);
    expect([...op!.after]).toEqual(new Array(8).fill(2));
  });

  it('replace leaves air alone', () => {
    const grid = grid8();
    const op = boxEdit(grid, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, 'replace', 2);
    expect(op!.indices).toHaveLength(4);
    expect([...op!.before]).toEqual([1, 1, 1, 1]);
  });

  it('clear empties the box and ignores the chosen block', () => {
    const grid = grid8();
    const op = boxEdit(grid, { x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 3 }, 'clear', 2);
    expect(op!.indices).toHaveLength(16);
    expect([...op!.after]).toEqual(new Array(16).fill(0));
  });

  it('hollow writes only the shell of the box', () => {
    const grid = grid8();
    const op = boxEdit(grid, { x: 1, y: 1, z: 1 }, { x: 5, y: 5, z: 5 }, 'hollow', 2);
    // 5^3 minus the 3^3 interior.
    expect(op!.indices).toHaveLength(125 - 27);
    // The centre cell is untouched, which is the whole point of the mode.
    expect([...op!.indices]).not.toContain(voxelIndex(grid.size, 3, 3, 3));
  });

  it('hollow on a one-block-thick box is the whole box', () => {
    const grid = grid8();
    const op = boxEdit(grid, { x: 0, y: 4, z: 0 }, { x: 7, y: 4, z: 7 }, 'hollow', 2);
    expect(op!.indices).toHaveLength(64);
  });

  it('is null when the box changes nothing', () => {
    const grid = grid8();
    expect(boxEdit(grid, { x: 5, y: 5, z: 5 }, { x: 7, y: 7, z: 7 }, 'clear', 2)).toBeNull();
    expect(boxEdit(grid, { x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 3 }, 'fill', 1)).toBeNull();
  });
});

describe('moveEdit', () => {
  /** A grid with a named palette, so a test can read a slice back as letters. */
  function grid(x: number, y: number, z: number): VoxelGrid {
    return {
      size: { x, y, z },
      voxels: new Uint16Array(x * y * z),
      palette: ['minecraft:air', 'a', 'b'],
    };
  }

  function row(g: VoxelGrid, y: number, z: number): string {
    let out = '';
    for (let x = 0; x < g.size.x; x++) {
      out += g.palette[g.voxels[voxelIndex(g.size, x, y, z)]!]![0]!.replace('m', '.');
    }
    return out;
  }

  function apply(g: VoxelGrid, op: EditOp | null): VoxelGrid {
    if (op) for (let i = 0; i < op.indices.length; i++) g.voxels[op.indices[i]!] = op.after[i]!;
    return g;
  }

  function set(g: VoxelGrid, from: number, to: number, value: number) {
    for (let x = from; x <= to; x++) g.voxels[voxelIndex(g.size, x, 0, 0)] = value;
  }

  it('moves the contents and leaves air behind', () => {
    const g = grid(10, 1, 1);
    set(g, 1, 3, 1);
    apply(g, moveEdit(g, { x: 1, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, 5, 0, 0));
    expect(row(g, 0, 0)).toBe('......aaa.');
  });

  it('survives a move that overlaps its own source', () => {
    // The case two passes get wrong: writing air over the source, then the contents, records
    // an erase for every interior cell whose moved value equals what was already there.
    const g = grid(10, 1, 1);
    set(g, 1, 5, 1);
    apply(g, moveEdit(g, { x: 1, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, 1, 0, 0));
    expect(row(g, 0, 0)).toBe('..aaaaa...');
  });

  it('undoes exactly, overlap and all', () => {
    const g = grid(10, 1, 1);
    set(g, 1, 5, 1);
    set(g, 6, 7, 2);
    const before = row(g, 0, 0);
    const op = moveEdit(g, { x: 1, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, 2, 0, 0)!;
    apply(g, op);
    // The b's are overwritten: a region moved onto something replaces it, and undo is what
    // brings it back — which is exactly what the rest of this test is checking.
    expect(row(g, 0, 0)).toBe('...aaaaa..');
    for (let i = op.indices.length - 1; i >= 0; i--) g.voxels[op.indices[i]!] = op.before[i]!;
    expect(row(g, 0, 0)).toBe(before);
  });

  it('drops the part that would leave the grid rather than piling it at the wall', () => {
    const g = grid(10, 1, 1);
    set(g, 6, 8, 1);
    apply(g, moveEdit(g, { x: 6, y: 0, z: 0 }, { x: 8, y: 0, z: 0 }, 3, 0, 0));
    expect(row(g, 0, 0)).toBe('.........a');
  });

  it('is a no-op when nothing moves', () => {
    const g = grid(4, 1, 1);
    set(g, 0, 3, 1);
    expect(moveEdit(g, { x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, 0, 0, 0)).toBeNull();
  });

  it('carries air with it, so a move does not paint holes shut', () => {
    const g = grid(10, 1, 1);
    set(g, 1, 1, 1);
    set(g, 3, 3, 1);
    apply(g, moveEdit(g, { x: 1, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, 4, 0, 0));
    expect(row(g, 0, 0)).toBe('.....a.a..');
  });
});
