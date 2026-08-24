import { describe, expect, it } from 'vitest';
import { voxelIndex, voxelPosition, type VoxelGrid } from '@craftmagic/core';
import { place, placementCell } from './place.js';
import { erase } from './erase.js';
import { FACE_NORMAL, type VoxelFace } from '../raycast.js';

const FACES: readonly VoxelFace[] = ['up', 'down', 'north', 'south', 'east', 'west'];

/** A 5³ grid with one block dead centre, so every face has room around it. */
function loneBlock(): VoxelGrid {
  const size = { x: 5, y: 5, z: 5 };
  const voxels = new Uint16Array(size.x * size.y * size.z);
  voxels[voxelIndex(size, 2, 2, 2)] = 1;
  return { size, palette: ['minecraft:air', 'minecraft:stone'], voxels };
}

describe('place', () => {
  it('lands on the face-adjacent cell for all six faces', () => {
    for (const face of FACES) {
      const grid = loneBlock();
      const op = place(grid, { x: 2, y: 2, z: 2, face }, 1);
      expect(op, face).not.toBeNull();
      expect(op!.indices).toHaveLength(1);

      const [dx, dy, dz] = FACE_NORMAL[face];
      const [x, y, z] = voxelPosition(grid.size, op!.indices[0]!);
      expect([x, y, z], face).toEqual([2 + dx, 2 + dy, 2 + dz]);
      expect(op!.before[0]).toBe(0);
      expect(op!.after[0]).toBe(1);
    }
  });

  it('refuses to place outside the grid', () => {
    const size = { x: 3, y: 3, z: 3 };
    const grid: VoxelGrid = {
      size,
      palette: ['minecraft:air', 'minecraft:stone'],
      voxels: new Uint16Array(27),
    };
    grid.voxels[voxelIndex(size, 0, 0, 0)] = 1;

    expect(place(grid, { x: 0, y: 0, z: 0, face: 'down' }, 1)).toBeNull();
    expect(place(grid, { x: 0, y: 0, z: 0, face: 'west' }, 1)).toBeNull();
    expect(place(grid, { x: 0, y: 0, z: 0, face: 'north' }, 1)).toBeNull();
    expect(place(grid, { x: 0, y: 0, z: 0, face: 'up' }, 1)).not.toBeNull();
  });

  it('refuses to overwrite a solid neighbour', () => {
    const grid = loneBlock();
    grid.voxels[voxelIndex(grid.size, 2, 3, 2)] = 1;
    expect(placementCell(grid, { x: 2, y: 2, z: 2, face: 'up' })).toBeNull();
    expect(place(grid, { x: 2, y: 2, z: 2, face: 'up' }, 1)).toBeNull();
  });

  it('produces no op when the target already holds the block', () => {
    const grid = loneBlock();
    // Palette slot 0 is air, and the neighbour is already air.
    expect(place(grid, { x: 2, y: 2, z: 2, face: 'up' }, 0)).toBeNull();
  });
});

describe('erase', () => {
  it('clears the hit cell, not the neighbour', () => {
    const grid = loneBlock();
    const op = erase(grid, { x: 2, y: 2, z: 2, face: 'up' });
    expect(op).not.toBeNull();
    expect(voxelPosition(grid.size, op!.indices[0]!)).toEqual([2, 2, 2]);
    expect(op!.before[0]).toBe(1);
    expect(op!.after[0]).toBe(0);
  });

  it('is a no-op on air', () => {
    const grid = loneBlock();
    expect(erase(grid, { x: 0, y: 0, z: 0, face: 'up' })).toBeNull();
  });
});
