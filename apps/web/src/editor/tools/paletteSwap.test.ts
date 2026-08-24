import { describe, expect, it } from 'vitest';
import { canonical, expand, samples, voxelIndex, type VoxelGrid } from '@craftmagic/core';
import { familyOf, swapFamily, swapPaletteIndex } from './paletteSwap.js';
import { resolvePaletteIndex } from './palette.js';

/**
 * Palette slots deliberately mix two wood families with a stone one. The interesting failure
 * is not "did the oak change" but "did anything else" — `familySwap` matches on category, so
 * a re-skin driven by category alone would happily turn the stone brick stairs into spruce.
 */
function mixedGrid(): VoxelGrid {
  const size = { x: 4, y: 1, z: 4 };
  const palette = [
    'minecraft:air',
    canonical('minecraft:oak_planks'),
    canonical('minecraft:oak_stairs'),
    canonical('minecraft:stone_brick_stairs'),
    canonical('minecraft:birch_planks'),
  ];
  const voxels = new Uint16Array(size.x * size.z);
  // Row z=0 oak planks, z=1 oak stairs, z=2 stone brick stairs, z=3 birch planks.
  for (let z = 0; z < 4; z++) {
    for (let x = 0; x < 4; x++) voxels[voxelIndex(size, x, 0, z)] = z + 1;
  }
  return { size, palette, voxels };
}

function countOf(grid: VoxelGrid, index: number): number {
  let n = 0;
  for (const value of grid.voxels) if (value === index) n++;
  return n;
}

function applyOp(grid: VoxelGrid, op: { indices: Uint32Array; after: Uint16Array }): void {
  for (let i = 0; i < op.indices.length; i++) grid.voxels[op.indices[i]!] = op.after[i]!;
}

describe('swapFamily', () => {
  it('re-skins every voxel of the source family and nothing else', () => {
    const grid = mixedGrid();
    const op = swapFamily(grid, 'oak', 'spruce', (ref) => resolvePaletteIndex(grid, ref).index);

    expect(op).not.toBeNull();
    // Eight voxels: four planks and four stairs. The stone stairs and birch planks are not
    // in the source family and must be untouched even though their categories match.
    expect(op!.indices).toHaveLength(8);
    for (let i = 0; i < op!.indices.length; i++) {
      expect([1, 2]).toContain(op!.before[i]);
    }

    applyOp(grid, op!);
    expect(countOf(grid, 1)).toBe(0);
    expect(countOf(grid, 2)).toBe(0);
    expect(countOf(grid, 3)).toBe(4);
    expect(countOf(grid, 4)).toBe(4);

    const sprucePlanks = grid.palette.indexOf(canonical('minecraft:spruce_planks'));
    const spruceStairs = grid.palette.indexOf(canonical('minecraft:spruce_stairs'));
    expect(sprucePlanks).toBeGreaterThan(0);
    expect(spruceStairs).toBeGreaterThan(0);
    expect(countOf(grid, sprucePlanks)).toBe(4);
    expect(countOf(grid, spruceStairs)).toBe(4);
  });

  it('is a no-op when the build has none of the source family', () => {
    const grid = mixedGrid();
    expect(swapFamily(grid, 'cherry', 'spruce', (ref) => resolvePaletteIndex(grid, ref).index)).toBeNull();
    expect(swapFamily(grid, 'oak', 'oak', () => 0)).toBeNull();
  });

  it('re-skins a real build end to end', () => {
    const { grid } = expand(samples.cottage!);
    const oakBefore = grid.palette.reduce(
      (n, ref, i) => (familyOf(ref) === 'oak' ? n + countOf(grid, i) : n),
      0,
    );
    expect(oakBefore).toBeGreaterThan(0);

    const op = swapFamily(grid, 'oak', 'spruce', (ref) => resolvePaletteIndex(grid, ref).index);
    expect(op!.indices).toHaveLength(oakBefore);

    applyOp(grid, op!);
    for (let i = 0; i < grid.palette.length; i++) {
      if (familyOf(grid.palette[i]!) === 'oak') expect(countOf(grid, i)).toBe(0);
    }
  });
});

describe('swapPaletteIndex', () => {
  it('rewrites exactly one palette slot', () => {
    const grid = mixedGrid();
    const op = swapPaletteIndex(grid, 2, 4);
    expect(op!.indices).toHaveLength(4);

    applyOp(grid, op!);
    expect(countOf(grid, 2)).toBe(0);
    expect(countOf(grid, 4)).toBe(8);
    expect(countOf(grid, 1)).toBe(4);
    expect(countOf(grid, 3)).toBe(4);
  });

  it('refuses degenerate swaps', () => {
    const grid = mixedGrid();
    expect(swapPaletteIndex(grid, 2, 2)).toBeNull();
    expect(swapPaletteIndex(grid, -1, 2)).toBeNull();
    // Slot 0 is air and this grid is solid, so there is nothing to rewrite.
    expect(swapPaletteIndex(grid, 0, 1)).toBeNull();
  });
});
