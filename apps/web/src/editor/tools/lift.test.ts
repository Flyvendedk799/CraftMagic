import { describe, expect, it } from 'vitest';
import { voxelIndex, type VoxelGrid } from '@craftmagic/core';
import { liftBlock } from './lift.js';
import { placementCell } from './place.js';

function gridOf(size = { x: 8, y: 8, z: 8 }): VoxelGrid {
  return {
    size,
    palette: ['minecraft:air', 'minecraft:oak_planks', 'minecraft:oak_stairs[facing=north]'],
    voxels: new Uint16Array(size.x * size.y * size.z),
  };
}

const at = (grid: VoxelGrid, x: number, y: number, z: number) =>
  grid.voxels[voxelIndex(grid.size, x, y, z)];

function set(grid: VoxelGrid, x: number, y: number, z: number, value: number): void {
  grid.voxels[voxelIndex(grid.size, x, y, z)] = value;
}

/** Apply an op the way the session does, so a test can look at the result. */
function apply(grid: VoxelGrid, op: NonNullable<ReturnType<typeof liftBlock>['op']>): void {
  for (let i = 0; i < op.indices.length; i++) grid.voxels[op.indices[i]!] = op.after[i]!;
}

describe('liftBlock', () => {
  it('moves one block, as a single op over exactly two cells', () => {
    const grid = gridOf();
    set(grid, 2, 0, 2, 1);

    const result = liftBlock(grid, { x: 2, y: 0, z: 2 }, { x: 5, y: 0, z: 5 });

    expect(result.refusal).toBeNull();
    expect(result.op).not.toBeNull();
    // Two cells and no more: one undo puts the block back where it was.
    expect(result.op!.indices.length).toBe(2);

    apply(grid, result.op!);
    expect(at(grid, 2, 0, 2)).toBe(0);
    expect(at(grid, 5, 0, 5)).toBe(1);
  });

  it('carries the palette slot, so a stair keeps its facing', () => {
    const grid = gridOf();
    set(grid, 1, 1, 1, 2);

    const result = liftBlock(grid, { x: 1, y: 1, z: 1 }, { x: 1, y: 2, z: 1 });
    apply(grid, result.op!);

    expect(at(grid, 1, 2, 1)).toBe(2);
    expect(grid.palette[2]).toBe('minecraft:oak_stairs[facing=north]');
  });

  it('does nothing, and says nothing, when the block is dropped where it started', () => {
    const grid = gridOf();
    set(grid, 3, 0, 3, 1);

    const result = liftBlock(grid, { x: 3, y: 0, z: 3 }, { x: 3, y: 0, z: 3 });

    expect(result.op).toBeNull();
    expect(result.refusal).toBeNull();
  });

  it('refuses to drop a block onto an occupied cell rather than deleting what is there', () => {
    const grid = gridOf();
    set(grid, 0, 0, 0, 1);
    set(grid, 0, 1, 0, 2);

    const result = liftBlock(grid, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });

    expect(result.op).toBeNull();
    expect(result.refusal).toMatch(/already there/);
    expect(at(grid, 0, 1, 0)).toBe(2);
  });

  it('refuses a source with nothing in it, and a destination off the plot', () => {
    const grid = gridOf();
    set(grid, 4, 0, 4, 1);

    expect(liftBlock(grid, { x: 6, y: 0, z: 6 }, { x: 1, y: 0, z: 1 }).refusal).toMatch(/Nothing there/);
    expect(liftBlock(grid, { x: 4, y: 0, z: 4 }, { x: 8, y: 0, z: 4 }).refusal).toMatch(/off the edge/);
    expect(liftBlock(grid, { x: 4, y: 0, z: 4 }, { x: -1, y: 0, z: 4 }).refusal).toMatch(/off the edge/);
  });

  it('lands against the face the drop was aimed at — the same rule a place follows', () => {
    const grid = gridOf();
    // A wall block at (4,1,4) and the block being carried, on the floor.
    set(grid, 4, 1, 4, 1);
    set(grid, 0, 0, 0, 2);

    // Pointing at the wall's west face means the cell in front of it, not the wall itself.
    const to = placementCell(grid, { x: 4, y: 1, z: 4, face: 'west' })!;
    expect(to).toEqual({ x: 3, y: 1, z: 4 });

    const result = liftBlock(grid, { x: 0, y: 0, z: 0 }, to);
    apply(grid, result.op!);
    expect(at(grid, 3, 1, 4)).toBe(2);
    expect(at(grid, 4, 1, 4)).toBe(1);
    expect(at(grid, 0, 0, 0)).toBe(0);
  });
});
