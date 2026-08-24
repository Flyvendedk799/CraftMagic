import { describe, expect, it } from 'vitest';
import { voxelIndex, type VoxelGrid } from '@craftmagic/core';
import { FILL_CAP, floodFill } from './fill.js';

function emptyGrid(x: number, y: number, z: number): VoxelGrid {
  return {
    size: { x, y, z },
    palette: ['minecraft:air', 'minecraft:stone', 'minecraft:oak_planks', 'minecraft:glass'],
    voxels: new Uint16Array(x * y * z),
  };
}

function setBox(
  grid: VoxelGrid,
  from: [number, number, number],
  to: [number, number, number],
  value: number,
): void {
  for (let y = from[1]; y <= to[1]; y++) {
    for (let z = from[2]; z <= to[2]; z++) {
      for (let x = from[0]; x <= to[0]; x++) grid.voxels[voxelIndex(grid.size, x, y, z)] = value;
    }
  }
}

describe('floodFill', () => {
  it('follows 6-connectivity and stops at a different palette index', () => {
    const grid = emptyGrid(8, 4, 8);
    // An L of stone, and a slab of planks sharing a face with it.
    setBox(grid, [0, 0, 0], [5, 0, 0], 1);
    setBox(grid, [5, 0, 0], [5, 0, 4], 1);
    setBox(grid, [5, 0, 5], [7, 0, 7], 2);

    const result = floodFill(grid, { x: 0, y: 0, z: 0, face: 'up' }, 3);
    expect(result.capped).toBe(false);
    // 6 along x plus 4 more along z: the shared corner is counted once.
    expect(result.cells).toBe(10);
    expect(result.op).not.toBeNull();
    expect(result.op!.indices).toHaveLength(10);

    for (let i = 0; i < result.op!.indices.length; i++) {
      expect(result.op!.before[i]).toBe(1);
      expect(result.op!.after[i]).toBe(3);
    }
  });

  it('does not leak across a diagonal touch', () => {
    const grid = emptyGrid(6, 6, 6);
    grid.voxels[voxelIndex(grid.size, 1, 1, 1)] = 1;
    // Corner-adjacent only — a 26-connected flood would swallow it.
    grid.voxels[voxelIndex(grid.size, 2, 2, 2)] = 1;

    const result = floodFill(grid, { x: 1, y: 1, z: 1, face: 'up' }, 2);
    expect(result.cells).toBe(1);
    expect(grid.voxels[voxelIndex(grid.size, 2, 2, 2)]).toBe(1);
  });

  it('never crosses into a neighbouring region of another block', () => {
    const grid = emptyGrid(10, 1, 10);
    setBox(grid, [0, 0, 0], [4, 0, 9], 1);
    setBox(grid, [5, 0, 0], [9, 0, 9], 2);

    const result = floodFill(grid, { x: 0, y: 0, z: 0, face: 'up' }, 3);
    expect(result.cells).toBe(50);

    // Nothing on the far side of the seam is in the op at all.
    for (let i = 0; i < result.op!.indices.length; i++) {
      expect(result.op!.before[i]).toBe(1);
    }
  });

  it('stops at the cap and says so', () => {
    // 64³ of one block is 262,144 connected cells — comfortably past the cap.
    const grid = emptyGrid(64, 64, 64);
    grid.voxels.fill(1);

    const result = floodFill(grid, { x: 32, y: 32, z: 32, face: 'up' }, 2);
    expect(result.capped).toBe(true);
    expect(result.cells).toBe(FILL_CAP);
    expect(result.op!.indices).toHaveLength(FILL_CAP);
  });

  it('honours a caller-supplied cap', () => {
    const grid = emptyGrid(32, 32, 32);
    grid.voxels.fill(1);

    const result = floodFill(grid, { x: 0, y: 0, z: 0, face: 'up' }, 2, 500);
    expect(result.capped).toBe(true);
    expect(result.cells).toBe(500);
  });

  it('produces no op when the region is already the target block', () => {
    const grid = emptyGrid(4, 4, 4);
    setBox(grid, [0, 0, 0], [3, 0, 3], 1);

    const result = floodFill(grid, { x: 0, y: 0, z: 0, face: 'up' }, 1);
    expect(result.cells).toBe(16);
    expect(result.op).toBeNull();
  });

  it('floods air too, so an interior can be filled in', () => {
    const grid = emptyGrid(5, 5, 5);
    grid.voxels.fill(1);
    setBox(grid, [1, 1, 1], [3, 3, 3], 0);

    const result = floodFill(grid, { x: 2, y: 2, z: 2, face: 'up' }, 1);
    expect(result.cells).toBe(27);
    expect(result.op!.indices).toHaveLength(27);
  });
});
