import { describe, expect, it } from 'vitest';
import { voxelIndex, type VoxelGrid } from '@craftmagic/core';
import { raycastVoxel } from './raycast.js';

/** A solid 8x8 slab at y=0 and one pillar block at (4,3,4). */
function grid8(): VoxelGrid {
  const size = { x: 8, y: 8, z: 8 };
  const voxels = new Uint16Array(size.x * size.y * size.z);
  for (let z = 0; z < 8; z++) {
    for (let x = 0; x < 8; x++) voxels[voxelIndex(size, x, 0, z)] = 1;
  }
  voxels[voxelIndex(size, 4, 3, 4)] = 1;
  return { size, palette: ['minecraft:air', 'minecraft:stone'], voxels };
}

describe('raycastVoxel', () => {
  it('hits the first solid cell and reports the face it entered', () => {
    const hit = raycastVoxel(grid8(), { x: 4.5, y: 6, z: 4.5 }, { x: 0, y: -1, z: 0 });
    expect(hit).toEqual({ x: 4, y: 3, z: 4, face: 'up' });
  });

  it('misses when the ray never enters the grid', () => {
    expect(raycastVoxel(grid8(), { x: -5, y: 6, z: 4.5 }, { x: 0, y: 1, z: 0 })).toBeNull();
  });

  it('returns null for a zero-length direction', () => {
    expect(raycastVoxel(grid8(), { x: 4.5, y: 6, z: 4.5 }, { x: 0, y: 0, z: 0 })).toBeNull();
  });

  it('maxY hides everything above the cut, so the pick follows the layer slider', () => {
    const grid = grid8();
    const down = { x: 0, y: -1, z: 0 };
    expect(raycastVoxel(grid, { x: 4.5, y: 6, z: 4.5 }, down, { maxY: 2 })).toEqual({
      x: 4,
      y: 0,
      z: 4,
      face: 'up',
    });
  });

  it('minY hides everything below the cut, so an isolated slice cannot be picked through', () => {
    const grid = grid8();
    const down = { x: 0, y: -1, z: 0 };
    // The floor is at y=0; isolating layer 3 leaves only the pillar block visible.
    expect(raycastVoxel(grid, { x: 4.5, y: 6, z: 4.5 }, down, { minY: 3, maxY: 3 })).toEqual({
      x: 4,
      y: 3,
      z: 4,
      face: 'up',
    });
    // ...and a column with nothing in that slice hits nothing at all, rather than the floor.
    expect(raycastVoxel(grid, { x: 1.5, y: 6, z: 1.5 }, down, { minY: 3, maxY: 3 })).toBeNull();
  });

  it('an empty range picks nothing', () => {
    expect(
      raycastVoxel(grid8(), { x: 4.5, y: 6, z: 4.5 }, { x: 0, y: -1, z: 0 }, { minY: 5, maxY: 4 }),
    ).toBeNull();
  });

  it('reports the side face of a block approached horizontally', () => {
    const grid = grid8();
    const hit = raycastVoxel(grid, { x: -2, y: 3.5, z: 4.5 }, { x: 1, y: 0, z: 0 });
    expect(hit).toEqual({ x: 4, y: 3, z: 4, face: 'west' });
  });
});
