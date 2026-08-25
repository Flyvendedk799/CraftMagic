import { describe, expect, it } from 'vitest';
import { voxelIndex, type VoxelGrid } from '@craftmagic/core';
import { lineEdit, linePath } from './line.js';

function grid16(): VoxelGrid {
  const size = { x: 16, y: 16, z: 16 };
  return {
    size,
    palette: ['minecraft:air', 'minecraft:stone', 'minecraft:oak_planks'],
    voxels: new Uint16Array(size.x * size.y * size.z),
  };
}

describe('linePath', () => {
  it('includes both endpoints', () => {
    const path = linePath({ x: 1, y: 2, z: 3 }, { x: 9, y: 2, z: 3 });
    expect(path[0]).toEqual({ x: 1, y: 2, z: 3 });
    expect(path[path.length - 1]).toEqual({ x: 9, y: 2, z: 3 });
  });

  it('is a single cell when both ends are the same', () => {
    expect(linePath({ x: 4, y: 4, z: 4 }, { x: 4, y: 4, z: 4 })).toHaveLength(1);
  });

  it('walks one cell per step along the dominant axis', () => {
    const path = linePath({ x: 0, y: 0, z: 0 }, { x: 10, y: 3, z: 1 });
    expect(path).toHaveLength(11);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      expect(Math.abs(b.x - a.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(b.y - a.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(b.z - a.z)).toBeLessThanOrEqual(1);
      expect(a).not.toEqual(b);
    }
  });

  it('drives on whichever axis is longest', () => {
    expect(linePath({ x: 0, y: 0, z: 0 }, { x: 2, y: 9, z: 1 })).toHaveLength(10);
    expect(linePath({ x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: 7 })).toHaveLength(8);
  });

  it('lands exactly on the far end of a long diagonal', () => {
    const end = { x: 200, y: 61, z: 137 };
    const path = linePath({ x: 0, y: 0, z: 0 }, end);
    expect(path[path.length - 1]).toEqual(end);
  });

  it('is the same set of cells in either direction', () => {
    const key = (c: { x: number; y: number; z: number }) => `${c.x},${c.y},${c.z}`;
    const forward = new Set(linePath({ x: 0, y: 0, z: 0 }, { x: 7, y: 4, z: 2 }).map(key));
    const back = new Set(linePath({ x: 7, y: 4, z: 2 }, { x: 0, y: 0, z: 0 }).map(key));
    expect(forward.size).toBe(back.size);
  });
});

describe('lineEdit', () => {
  it('writes one block per cell of the path', () => {
    const grid = grid16();
    const result = lineEdit(grid, { x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, 1);
    expect(result.op!.indices).toHaveLength(6);
    expect([...result.op!.after]).toEqual(new Array(6).fill(1));
  });

  it('overwrites what it crosses, so a beam has no gaps', () => {
    const grid = grid16();
    grid.voxels[voxelIndex(grid.size, 3, 0, 0)] = 2;
    const result = lineEdit(grid, { x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, 1);
    expect(result.op!.indices).toHaveLength(6);
  });

  it('thickens with a brush radius', () => {
    const grid = grid16();
    const thin = lineEdit(grid, { x: 2, y: 8, z: 8 }, { x: 12, y: 8, z: 8 }, 1);
    const thick = lineEdit(grid, { x: 2, y: 8, z: 8 }, { x: 12, y: 8, z: 8 }, 1, {
      radius: 1,
      shape: 'cube',
    });
    expect(thick.cells).toBeGreaterThan(thin.cells);
  });

  it('clips to the grid instead of wrapping', () => {
    const grid = grid16();
    const result = lineEdit(grid, { x: -5, y: 8, z: 8 }, { x: 5, y: 8, z: 8 }, 1);
    expect(result.op!.indices).toHaveLength(6);
  });
});
