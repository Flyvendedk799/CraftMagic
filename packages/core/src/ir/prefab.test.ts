/**
 * The prefab codec.
 *
 * This is a format written on one side of the wire and read on the other, so the property
 * that matters is the round trip — and the failure mode if it is wrong is a building that
 * comes out subtly shifted or recoloured rather than an exception anyone would notice.
 */

import { describe, expect, it } from 'vitest';
import { decodePrefab, encodePrefab, forEachPrefabRun, prefabBlockCount } from './prefab.js';
import { AIR_BLOCK, voxelIndex, type VoxelGrid } from './types.js';

function grid(size: { x: number; y: number; z: number }, palette: string[], fill: (x: number, y: number, z: number) => number): VoxelGrid {
  const voxels = new Uint16Array(size.x * size.y * size.z);
  for (let y = 0; y < size.y; y++) {
    for (let z = 0; z < size.z; z++) {
      for (let x = 0; x < size.x; x++) voxels[voxelIndex(size, x, y, z)] = fill(x, y, z);
    }
  }
  return { size, palette: [AIR_BLOCK, ...palette], voxels };
}

describe('encodePrefab / decodePrefab', () => {
  it('round-trips an empty grid', () => {
    const original = grid({ x: 3, y: 2, z: 4 }, ['minecraft:stone'], () => 0);
    const back = decodePrefab(encodePrefab(original));
    expect(back.size).toEqual(original.size);
    expect([...back.voxels]).toEqual([...original.voxels]);
  });

  it('round-trips a solid grid', () => {
    const original = grid({ x: 4, y: 3, z: 2 }, ['minecraft:stone'], () => 1);
    const back = decodePrefab(encodePrefab(original));
    expect([...back.voxels]).toEqual([...original.voxels]);
    expect(prefabBlockCount(encodePrefab(original))).toBe(24);
  });

  it('round-trips a grid with structure in it', () => {
    // A hollow shell: every face solid, the middle air. Runs of both kinds, in both orders.
    const size = { x: 5, y: 4, z: 6 };
    const original = grid(size, ['minecraft:stone', 'minecraft:oak_planks'], (x, y, z) => {
      const onShell =
        x === 0 || y === 0 || z === 0 || x === size.x - 1 || y === size.y - 1 || z === size.z - 1;
      if (!onShell) return 0;
      return y === 0 ? 1 : 2;
    });

    const back = decodePrefab(encodePrefab(original));
    expect([...back.voxels]).toEqual([...original.voxels]);
  });

  it('round-trips a palette index above one byte', () => {
    // 200 entries forces a two-byte varint for the index, which is the easiest thing in a
    // hand-rolled encoder to get wrong and the hardest to notice: it only shows up on a build
    // with a big palette, and then only in the blocks near the end of it.
    const palette = Array.from({ length: 200 }, (_, i) => `minecraft:block_${i}`);
    const original = grid({ x: 20, y: 1, z: 10 }, palette, (x, _y, z) => (x + z * 20) % 201);
    const back = decodePrefab(encodePrefab(original));
    expect([...back.voxels]).toEqual([...original.voxels]);
  });

  it('round-trips a run longer than a byte can count', () => {
    // 4096 identical cells: the length varint has to carry past 127 or the tail is dropped.
    const original = grid({ x: 16, y: 16, z: 16 }, ['minecraft:stone'], () => 1);
    const back = decodePrefab(encodePrefab(original));
    expect([...back.voxels]).toEqual([...original.voxels]);
    expect(prefabBlockCount(encodePrefab(original))).toBe(4096);
  });

  it('keeps the palette, with air in slot zero', () => {
    const original = grid({ x: 2, y: 1, z: 1 }, ['minecraft:stone'], () => 1);
    expect(encodePrefab(original).palette).toEqual([AIR_BLOCK, 'minecraft:stone']);
  });

  it('inserts air at slot zero for a grid that lacks it', () => {
    // Defensive: nothing in this codebase produces such a grid, but a prefab whose slot 0 was
    // stone would stamp stone everywhere the expander skips, which is everywhere.
    const original: VoxelGrid = {
      size: { x: 2, y: 1, z: 1 },
      palette: ['minecraft:stone'],
      voxels: Uint16Array.of(0, 0),
    };
    expect(encodePrefab(original).palette[0]).toBe(AIR_BLOCK);
  });

  it('is much smaller than the raw indices for a realistic build', () => {
    // The reason the format exists: a program carrying one of these goes into Postgres and
    // past a language model, and 6,000 comma-separated integers is not a thing to send twice.
    const size = { x: 21, y: 19, z: 13 };
    const original = grid(size, ['minecraft:stone'], (x, y, z) => {
      const shell = x === 0 || z === 0 || x === size.x - 1 || z === size.z - 1;
      return y < 12 && shell ? 1 : 0;
    });

    const encoded = encodePrefab(original);
    const raw = JSON.stringify([...original.voxels]).length;
    expect(encoded.data.length).toBeLessThan(raw / 8);
  });
});

describe('forEachPrefabRun', () => {
  it('covers every cell exactly once, in order', () => {
    const original = grid({ x: 3, y: 2, z: 3 }, ['minecraft:stone'], (x) => (x === 1 ? 1 : 0));
    const seen: number[] = [];

    forEachPrefabRun(encodePrefab(original), (index, length, start) => {
      expect(start).toBe(seen.length);
      for (let i = 0; i < length; i++) seen.push(index);
    });

    expect(seen).toEqual([...original.voxels]);
  });

  it('counts blocks without materialising a grid', () => {
    const original = grid({ x: 4, y: 4, z: 4 }, ['minecraft:stone'], (x, y, z) => (x + y + z) % 2);
    expect(prefabBlockCount(encodePrefab(original))).toBe(32);
  });
});
