import { describe, expect, it } from 'vitest';
import { canonical, expand, samples } from '@craftmagic/core';
import { resolvePaletteIndex } from './palette.js';

describe('resolvePaletteIndex', () => {
  it('reuses a slot whose canonical form already matches', () => {
    const { grid } = expand(samples.cottage!);
    const before = grid.palette.length;

    // The cottage palette holds the fully-specified stair state. Asking for the same block
    // spelled differently must land on that slot: the whole point of canonicalising here is
    // that a palette cannot grow a duplicate every time two callers write a state two ways.
    const stairs = grid.palette.findIndex((ref) => ref.startsWith('minecraft:dark_oak_stairs'));
    expect(stairs).toBeGreaterThan(0);

    const spelledShort = 'minecraft:dark_oak_stairs[facing=south]';
    expect(canonical(spelledShort)).toBe(grid.palette[stairs]);

    const resolved = resolvePaletteIndex(grid, spelledShort);
    expect(resolved).toEqual({ index: stairs, grew: false });
    expect(grid.palette).toHaveLength(before);
  });

  it('reuses a plain block already in the palette', () => {
    const { grid } = expand(samples.cottage!);
    const before = grid.palette.length;

    const resolved = resolvePaletteIndex(grid, 'minecraft:oak_planks');
    expect(resolved.grew).toBe(false);
    expect(grid.palette[resolved.index]).toBe('minecraft:oak_planks');
    expect(grid.palette).toHaveLength(before);
  });

  it('appends once for a block the program never used', () => {
    const { grid } = expand(samples.cottage!);
    const before = grid.palette.length;

    const first = resolvePaletteIndex(grid, 'minecraft:spruce_planks');
    expect(first.grew).toBe(true);
    expect(first.index).toBe(before);
    expect(grid.palette).toHaveLength(before + 1);
    expect(grid.palette[first.index]).toBe(canonical('minecraft:spruce_planks'));

    const second = resolvePaletteIndex(grid, 'minecraft:spruce_planks');
    expect(second).toEqual({ index: first.index, grew: false });
    expect(grid.palette).toHaveLength(before + 1);
  });

  it('stores the canonical form, not what the caller typed', () => {
    const { grid } = expand(samples.cottage!);
    // Properties out of order and defaults omitted — two spellings of one blockstate.
    const a = resolvePaletteIndex(grid, 'minecraft:spruce_stairs[half=top,facing=east]');
    const b = resolvePaletteIndex(grid, 'minecraft:spruce_stairs[facing=east,half=top]');

    expect(a.grew).toBe(true);
    expect(b).toEqual({ index: a.index, grew: false });
    expect(grid.palette[a.index]).toBe(canonical('minecraft:spruce_stairs[facing=east,half=top]'));
  });
});
