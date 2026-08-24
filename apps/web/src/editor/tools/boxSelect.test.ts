import { describe, expect, it } from 'vitest';
import { voxelIndex, type VoxelGrid } from '@craftmagic/core';
import { boxBounds, boxEdit } from './boxSelect.js';

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

  it('is null when the box changes nothing', () => {
    const grid = grid8();
    expect(boxEdit(grid, { x: 5, y: 5, z: 5 }, { x: 7, y: 7, z: 7 }, 'clear', 2)).toBeNull();
    expect(boxEdit(grid, { x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 3 }, 'fill', 1)).toBeNull();
  });
});
