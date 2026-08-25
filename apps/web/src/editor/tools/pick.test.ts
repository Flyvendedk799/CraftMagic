import { describe, expect, it } from 'vitest';
import { voxelIndex, type VoxelGrid } from '@craftmagic/core';
import { pickBlock } from './pick.js';

function grid8(): VoxelGrid {
  const size = { x: 8, y: 8, z: 8 };
  const voxels = new Uint16Array(size.x * size.y * size.z);
  voxels[voxelIndex(size, 2, 3, 4)] = 2;
  return { size, palette: ['minecraft:air', 'minecraft:stone', 'minecraft:oak_planks'], voxels };
}

describe('pickBlock', () => {
  it('returns the block under the cell', () => {
    expect(pickBlock(grid8(), { x: 2, y: 3, z: 4 })).toBe('minecraft:oak_planks');
  });

  it('picks nothing from air', () => {
    expect(pickBlock(grid8(), { x: 0, y: 0, z: 0 })).toBeNull();
  });

  it('picks nothing outside the grid', () => {
    expect(pickBlock(grid8(), { x: -1, y: 0, z: 0 })).toBeNull();
    expect(pickBlock(grid8(), { x: 8, y: 0, z: 0 })).toBeNull();
  });
});
