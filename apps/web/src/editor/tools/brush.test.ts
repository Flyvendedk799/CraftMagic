import { describe, expect, it } from 'vitest';
import { voxelIndex, type VoxelGrid } from '@craftmagic/core';
import { brushCells, brushEdit, brushOffsets, MAX_BRUSH_RADIUS } from './brush.js';

function grid16(): VoxelGrid {
  const size = { x: 16, y: 16, z: 16 };
  const voxels = new Uint16Array(size.x * size.y * size.z);
  // A floor, so the "only air" and "only solid" predicates have both cases to see.
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) voxels[voxelIndex(size, x, 0, z)] = 1;
  }
  return { size, palette: ['minecraft:air', 'minecraft:stone', 'minecraft:oak_planks'], voxels };
}

describe('brushOffsets', () => {
  it('is a single cell at radius 0', () => {
    expect(brushOffsets(0, 'ball')).toEqual([{ x: 0, y: 0, z: 0 }]);
    expect(brushOffsets(0, 'cube')).toEqual([{ x: 0, y: 0, z: 0 }]);
  });

  it('a cube brush is the full (2r+1)^3', () => {
    expect(brushOffsets(1, 'cube')).toHaveLength(27);
    expect(brushOffsets(2, 'cube')).toHaveLength(125);
  });

  it('a ball brush keeps its poles but drops its corners', () => {
    const ball = brushOffsets(2, 'ball');
    expect(ball).toContainEqual({ x: 0, y: 2, z: 0 });
    expect(ball).not.toContainEqual({ x: 2, y: 2, z: 2 });
    expect(ball.length).toBeLessThan(brushOffsets(2, 'cube').length);
  });

  it('clamps the radius rather than allocating whatever it is asked for', () => {
    expect(brushOffsets(999, 'cube')).toEqual(brushOffsets(MAX_BRUSH_RADIUS, 'cube'));
    expect(brushOffsets(-3, 'ball')).toHaveLength(1);
  });

  it('returns the same array for the same brush', () => {
    expect(brushOffsets(3, 'ball')).toBe(brushOffsets(3, 'ball'));
  });
});

describe('brushCells', () => {
  it('clips to the grid rather than reporting cells outside it', () => {
    const cells = brushCells(grid16(), { x: 0, y: 0, z: 0 }, { radius: 1, shape: 'cube' });
    expect(cells).toHaveLength(8);
    expect(cells.every((c) => c.x >= 0 && c.y >= 0 && c.z >= 0)).toBe(true);
  });
});

describe('brushEdit', () => {
  it('places into air only, so a brush cannot eat what it was aimed at', () => {
    const grid = grid16();
    const result = brushEdit(grid, [{ x: 5, y: 0, z: 5 }], 2, {
      radius: 1,
      shape: 'cube',
      onlyAir: true,
    });
    // y=-1 is off the grid and y=0 is floor the predicate refuses, so only the 3x3 slice
    // of air at y=1 is written.
    expect(result.cells).toBe(9);
    expect([...result.op!.before].every((v) => v === 0)).toBe(true);
  });

  it('erases solid only', () => {
    const grid = grid16();
    const result = brushEdit(grid, [{ x: 5, y: 0, z: 5 }], 0, {
      radius: 1,
      shape: 'cube',
      onlySolid: true,
    });
    expect(result.cells).toBe(9);
    expect([...result.op!.after].every((v) => v === 0)).toBe(true);
  });

  it('records an overlapping stroke once per cell', () => {
    const grid = grid16();
    const centres = [
      { x: 5, y: 5, z: 5 },
      { x: 5, y: 5, z: 5 },
      { x: 6, y: 5, z: 5 },
    ];
    const result = brushEdit(grid, centres, 1, { radius: 1, shape: 'cube' });
    const indices = [...result.op!.indices];
    expect(new Set(indices).size).toBe(indices.length);
    // Two 3x3x3 cubes one apart share a 3x3x2 overlap: 27 + 27 - 18.
    expect(result.cells).toBe(36);
  });

  it('folds a whole stroke into one op', () => {
    const grid = grid16();
    const centres = Array.from({ length: 10 }, (_, i) => ({ x: i, y: 5, z: 5 }));
    const result = brushEdit(grid, centres, 1, {});
    expect(result.op!.indices).toHaveLength(10);
  });

  it('stops at the cap and says so', () => {
    const grid = grid16();
    const result = brushEdit(grid, [{ x: 8, y: 8, z: 8 }], 1, {
      radius: 4,
      shape: 'cube',
      cap: 20,
    });
    expect(result.capped).toBe(true);
    expect(result.cells).toBe(20);
  });

  it('is null when nothing would change', () => {
    const grid = grid16();
    // Painting the floor stone over stone.
    const result = brushEdit(grid, [{ x: 5, y: 0, z: 5 }], 1, { onlySolid: true });
    expect(result.op).toBeNull();
    expect(result.cells).toBe(0);
  });

  it('never writes outside the grid', () => {
    const grid = grid16();
    const result = brushEdit(grid, [{ x: 15, y: 15, z: 15 }], 1, { radius: 3, shape: 'cube' });
    for (const index of result.op!.indices) {
      expect(index).toBeLessThan(grid.voxels.length);
    }
  });
});
