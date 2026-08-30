import { describe, expect, it } from 'vitest';
import { voxelIndex, type VoxelGrid } from '@craftmagic/core';
import { grabStructure } from './grab.js';

function gridOf(size: { x: number; y: number; z: number }): VoxelGrid {
  return {
    size,
    palette: ['minecraft:air', 'minecraft:oak_log', 'minecraft:oak_leaves'],
    voxels: new Uint16Array(size.x * size.y * size.z),
  };
}

function set(grid: VoxelGrid, x: number, y: number, z: number, value: number): void {
  grid.voxels[voxelIndex(grid.size, x, y, z)] = value;
}

const hit = (x: number, y: number, z: number) => ({ x, y, z, face: 'up' as const });

describe('grabStructure', () => {
  it('lifts a whole connected structure, mixed blocks and all', () => {
    const grid = gridOf({ x: 8, y: 8, z: 8 });
    // A little tree: trunk of logs, one leaf on top — and an unrelated block far away.
    set(grid, 3, 0, 3, 1);
    set(grid, 3, 1, 3, 1);
    set(grid, 3, 2, 3, 2);
    set(grid, 7, 0, 7, 1);

    const result = grabStructure(grid, hit(3, 1, 3));

    expect(result.cells).toBe(3);
    expect(result.capped).toBe(false);
    expect(result.clip).not.toBeNull();
    expect(result.clip!.size).toEqual({ x: 1, y: 3, z: 1 });
    expect(result.clip!.blocks).toBe(3);
    // Canonicalised on the way in, so leaves carry their default states.
    expect(result.clip!.palette.some((ref) => ref.startsWith('minecraft:oak_leaves'))).toBe(true);

    // The erase op removes exactly the structure; the far block is untouched.
    expect(result.op).not.toBeNull();
    expect(result.op!.indices.length).toBe(3);
    const farIndex = voxelIndex(grid.size, 7, 0, 7);
    expect([...result.op!.indices]).not.toContain(farIndex);
  });

  it('returns nothing for a click on air or off the grid', () => {
    const grid = gridOf({ x: 4, y: 4, z: 4 });
    expect(grabStructure(grid, hit(1, 1, 1)).clip).toBeNull();
    expect(grabStructure(grid, hit(-1, 0, 0)).clip).toBeNull();
  });

  it('refuses whole rather than truncating when the structure exceeds the cap', () => {
    const grid = gridOf({ x: 6, y: 1, z: 6 });
    for (let z = 0; z < 6; z++) for (let x = 0; x < 6; x++) set(grid, x, 0, z, 1);

    const result = grabStructure(grid, hit(0, 0, 0), 10);
    expect(result.capped).toBe(true);
    expect(result.clip).toBeNull();
    expect(result.op).toBeNull();
  });

  it('does not connect diagonally', () => {
    const grid = gridOf({ x: 4, y: 4, z: 4 });
    set(grid, 0, 0, 0, 1);
    set(grid, 1, 1, 1, 1);
    expect(grabStructure(grid, hit(0, 0, 0)).cells).toBe(1);
  });
});
