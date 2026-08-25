import { describe, expect, it } from 'vitest';
import { canonical, parseBlockRef, voxelIndex, type VoxelGrid } from '@craftmagic/core';
import {
  ClipTooLargeError,
  copyRegion,
  mirrorClip,
  rotateClip,
  stampBounds,
  stampEdit,
  type Clip,
} from './clipboard.js';
import { resolvePaletteIndex } from './palette.js';

function grid16(): VoxelGrid {
  const size = { x: 16, y: 16, z: 16 };
  return {
    size,
    palette: ['minecraft:air', 'minecraft:stone', canonical('minecraft:oak_stairs[facing=north]')],
    voxels: new Uint16Array(size.x * size.y * size.z),
  };
}

function at(clip: Clip, x: number, y: number, z: number): string {
  return clip.palette[clip.voxels[voxelIndex(clip.size, x, y, z)] ?? 0] ?? 'minecraft:air';
}

describe('copyRegion', () => {
  it('lifts the region with a palette of only what it holds', () => {
    const grid = grid16();
    grid.voxels[voxelIndex(grid.size, 1, 1, 1)] = 1;
    const clip = copyRegion(grid, { x: 0, y: 0, z: 0 }, { x: 2, y: 2, z: 2 });

    expect(clip.size).toEqual({ x: 3, y: 3, z: 3 });
    expect(clip.blocks).toBe(1);
    // Air plus the one block actually present — the source's oak stairs are not carried.
    expect(clip.palette).toEqual(['minecraft:air', 'minecraft:stone']);
    expect(at(clip, 1, 1, 1)).toBe('minecraft:stone');
  });

  it('normalises corner order and clamps to the grid', () => {
    const grid = grid16();
    const clip = copyRegion(grid, { x: 4, y: 2, z: 40 }, { x: 1, y: 0, z: 1 });
    expect(clip.size).toEqual({ x: 4, y: 3, z: 15 });
  });

  it('does not modify the grid it copied from', () => {
    const grid = grid16();
    grid.voxels[voxelIndex(grid.size, 1, 1, 1)] = 1;
    const before = grid.voxels.slice();
    copyRegion(grid, { x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 });
    expect([...grid.voxels]).toEqual([...before]);
  });

  it('refuses a region larger than the clipboard holds', () => {
    const size = { x: 256, y: 256, z: 256 };
    const huge: VoxelGrid = {
      size,
      palette: ['minecraft:air'],
      // Never read past the bounds check, so the array can stay small.
      voxels: new Uint16Array(1),
    };
    expect(() => copyRegion(huge, { x: 0, y: 0, z: 0 }, { x: 255, y: 255, z: 255 })).toThrow(
      ClipTooLargeError,
    );
  });
});

describe('rotateClip', () => {
  it('turns the shape and the block states the same way', () => {
    const grid = grid16();
    grid.voxels[voxelIndex(grid.size, 0, 0, 0)] = 2; // oak stairs facing north
    const clip = copyRegion(grid, { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 });
    expect(clip.size).toEqual({ x: 3, y: 1, z: 1 });

    const turned = rotateClip(clip, 1);
    // A 3x1 run along X becomes a 1x3 run along Z.
    expect(turned.size).toEqual({ x: 1, y: 1, z: 3 });
    // (x,z) -> (-z,x): the cell at x=0 lands at z=0.
    expect(parseBlockRef(at(turned, 0, 0, 0)).id).toBe('minecraft:oak_stairs');
    expect(parseBlockRef(at(turned, 0, 0, 0)).states.facing).toBe('east');
  });

  it('four quarter turns are the identity', () => {
    const grid = grid16();
    grid.voxels[voxelIndex(grid.size, 0, 0, 0)] = 2;
    grid.voxels[voxelIndex(grid.size, 2, 1, 3)] = 1;
    const clip = copyRegion(grid, { x: 0, y: 0, z: 0 }, { x: 3, y: 2, z: 3 });

    const full = rotateClip(clip, 4);
    expect(full.size).toEqual(clip.size);
    expect([...full.voxels].map((v) => full.palette[v])).toEqual(
      [...clip.voxels].map((v) => clip.palette[v]),
    );
  });

  it('keeps every block it was given', () => {
    const grid = grid16();
    for (let i = 0; i < 5; i++) grid.voxels[voxelIndex(grid.size, i, 0, 1)] = 1;
    const clip = copyRegion(grid, { x: 0, y: 0, z: 0 }, { x: 5, y: 3, z: 5 });
    const turned = rotateClip(clip, 1);
    expect(turned.voxels.filter((v) => v !== 0)).toHaveLength(5);
    expect(turned.blocks).toBe(clip.blocks);
  });
});

describe('mirrorClip', () => {
  it('flips the geometry and the facing together', () => {
    const grid = grid16();
    grid.voxels[voxelIndex(grid.size, 0, 0, 0)] = 2; // facing north
    const clip = copyRegion(grid, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 });
    const flipped = mirrorClip(clip, 'z');

    expect(flipped.size).toEqual(clip.size);
    expect(parseBlockRef(at(flipped, 0, 0, 2)).states.facing).toBe('south');
  });

  it('mirroring twice is the identity', () => {
    const grid = grid16();
    grid.voxels[voxelIndex(grid.size, 3, 0, 0)] = 1;
    const clip = copyRegion(grid, { x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 });
    const back = mirrorClip(mirrorClip(clip, 'x'), 'x');
    expect([...back.voxels]).toEqual([...clip.voxels]);
  });
});

describe('stampEdit', () => {
  function stoneClip(): Clip {
    const grid = grid16();
    grid.voxels[voxelIndex(grid.size, 0, 0, 0)] = 1;
    grid.voxels[voxelIndex(grid.size, 1, 0, 0)] = 1;
    return copyRegion(grid, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 });
  }

  it('writes the clip with its minimum corner at the target', () => {
    const grid = grid16();
    const clip = stoneClip();
    const result = stampEdit(grid, clip, { x: 5, y: 5, z: 5 }, (ref) => resolvePaletteIndex(grid, ref).index);

    expect(result.op!.indices).toHaveLength(2);
    expect([...result.op!.indices]).toEqual([
      voxelIndex(grid.size, 5, 5, 5),
      voxelIndex(grid.size, 6, 5, 5),
    ]);
    expect(stampBounds(clip, { x: 5, y: 5, z: 5 })).toEqual({
      min: { x: 5, y: 5, z: 5 },
      max: { x: 6, y: 6, z: 5 },
    });
  });

  it('merge leaves the destination alone where the clip is empty', () => {
    const grid = grid16();
    grid.voxels[voxelIndex(grid.size, 5, 6, 5)] = 1; // under the clip's empty upper row
    const result = stampEdit(grid, stoneClip(), { x: 5, y: 5, z: 5 }, () => 1, 'merge');
    expect([...result.op!.indices]).not.toContain(voxelIndex(grid.size, 5, 6, 5));
  });

  it('replace carries the clip’s holes across', () => {
    const grid = grid16();
    grid.voxels[voxelIndex(grid.size, 5, 6, 5)] = 1;
    const result = stampEdit(grid, stoneClip(), { x: 5, y: 5, z: 5 }, () => 1, 'replace');
    const indices = [...result.op!.indices];
    const hole = indices.indexOf(voxelIndex(grid.size, 5, 6, 5));
    expect(hole).toBeGreaterThanOrEqual(0);
    expect(result.op!.after[hole]).toBe(0);
  });

  it('grows the destination palette once per clip block', () => {
    const grid = grid16();
    grid.palette = ['minecraft:air'];
    let calls = 0;
    stampEdit(grid, stoneClip(), { x: 0, y: 0, z: 0 }, (ref) => {
      calls++;
      return resolvePaletteIndex(grid, ref).index;
    });
    expect(calls).toBe(1);
    expect(grid.palette).toEqual(['minecraft:air', 'minecraft:stone']);
  });

  it('clips at the edge of the grid rather than wrapping', () => {
    const grid = grid16();
    const result = stampEdit(grid, stoneClip(), { x: 15, y: 5, z: 5 }, () => 1);
    expect(result.op!.indices).toHaveLength(1);
  });

  it('reports truncation when the destination palette is full', () => {
    const grid = grid16();
    const result = stampEdit(grid, stoneClip(), { x: 5, y: 5, z: 5 }, () => -1);
    expect(result.truncated).toBe(true);
    expect(result.op).toBeNull();
  });
});
