/**
 * Compose is the only new idea in plans, and the two things it has to get right are both
 * silent when wrong: a rotation that turns positions one way and blockstates the other
 * produces a building whose stairs face into the wall, and an overlap rule that pastes
 * instead of stamping punches a rectangular hole through whatever a small structure is
 * tucked against. Neither throws. Both are obvious in a test and invisible in a screenshot.
 */

import { describe, expect, it } from 'vitest';
import { AIR_BLOCK, voxelIndex, type VoxelGrid } from '../ir/types.js';
import { canonical } from '../registry/registry.js';
import { clampPosition, composePlan, placementBox, rotatePoint, rotatedSize } from './compose.js';
import { PLAN_SIZE, type Placement, type PlanComponent, type Quarter } from './types.js';

/** A grid of the given size with `blocks` written into it, everything else air. */
function grid(
  size: { x: number; y: number; z: number },
  palette: string[],
  blocks: { x: number; y: number; z: number; index: number }[],
): VoxelGrid {
  const voxels = new Uint16Array(size.x * size.y * size.z);
  for (const block of blocks) voxels[voxelIndex(size, block.x, block.y, block.z)] = block.index;
  return { size, palette: [AIR_BLOCK, ...palette], voxels };
}

function component(sourceId: string, g: VoxelGrid): PlanComponent {
  return { sourceId, name: sourceId, grid: g };
}

function placement(
  sourceId: string,
  at: { x: number; y: number; z: number },
  rotation: Quarter = 0,
  id = sourceId,
): Placement {
  return { id, sourceId, at, rotation };
}

function blockAt(result: { grid: VoxelGrid }, x: number, y: number, z: number): string {
  const index = result.grid.voxels[voxelIndex(result.grid.size, x, y, z)] ?? 0;
  return result.grid.palette[index] ?? AIR_BLOCK;
}

describe('rotatedSize', () => {
  it('swaps width and depth on odd quarters only', () => {
    const size = { x: 3, y: 5, z: 7 };
    expect(rotatedSize(size, 0)).toEqual({ x: 3, y: 5, z: 7 });
    expect(rotatedSize(size, 1)).toEqual({ x: 7, y: 5, z: 3 });
    expect(rotatedSize(size, 2)).toEqual({ x: 3, y: 5, z: 7 });
    expect(rotatedSize(size, 3)).toEqual({ x: 7, y: 5, z: 3 });
  });

  it('never changes height', () => {
    for (const rotation of [0, 1, 2, 3] as const) {
      expect(rotatedSize({ x: 4, y: 9, z: 2 }, rotation).y).toBe(9);
    }
  });
});

describe('rotatePoint', () => {
  const size = { x: 3, z: 2 };

  it('is the identity at zero', () => {
    expect(rotatePoint(2, 1, size, 0)).toEqual({ x: 2, z: 1 });
  });

  it('sends the origin corner around the footprint', () => {
    // (0,0) is the north-west corner; a clockwise turn puts it in the north-east.
    expect(rotatePoint(0, 0, size, 1)).toEqual({ x: 1, z: 0 });
    expect(rotatePoint(0, 0, size, 2)).toEqual({ x: 2, z: 1 });
    expect(rotatePoint(0, 0, size, 3)).toEqual({ x: 0, z: 2 });
  });

  it('keeps every cell inside the rotated footprint', () => {
    for (const rotation of [0, 1, 2, 3] as const) {
      const placed = rotatedSize({ ...size, y: 1 }, rotation);
      for (let x = 0; x < size.x; x++) {
        for (let z = 0; z < size.z; z++) {
          const point = rotatePoint(x, z, size, rotation);
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.z).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThan(placed.x);
          expect(point.z).toBeLessThan(placed.z);
        }
      }
    }
  });

  it('is a bijection, so no cell is lost or doubled', () => {
    for (const rotation of [0, 1, 2, 3] as const) {
      const seen = new Set<string>();
      for (let x = 0; x < size.x; x++) {
        for (let z = 0; z < size.z; z++) {
          const point = rotatePoint(x, z, size, rotation);
          seen.add(`${point.x},${point.z}`);
        }
      }
      expect(seen.size).toBe(size.x * size.z);
    }
  });

  it('four quarters return every cell to where it started', () => {
    let point = { x: 2, z: 1 };
    let footprint = { x: size.x, z: size.z };
    for (let turn = 0; turn < 4; turn++) {
      point = rotatePoint(point.x, point.z, footprint, 1);
      footprint = { x: footprint.z, z: footprint.x };
    }
    expect(point).toEqual({ x: 2, z: 1 });
  });
});

describe('composePlan', () => {
  it('returns a usable empty grid when nothing is placed', () => {
    const result = composePlan([], new Map());
    expect(result.blockCount).toBe(0);
    expect(result.grid.size).toEqual({ x: 1, y: 1, z: 1 });
    expect(result.errors).toEqual([]);
  });

  it('trims to what is occupied rather than exporting the whole plot', () => {
    const one = component('a', grid({ x: 2, y: 1, z: 2 }, ['minecraft:stone'], [
      { x: 0, y: 0, z: 0, index: 1 },
    ]));
    const result = composePlan([placement('a', { x: 100, y: 0, z: 60 })], new Map([['a', one]]));

    expect(result.grid.size).toEqual({ x: 2, y: 1, z: 2 });
    expect(result.offset).toEqual({ x: 100, y: 0, z: 60 });
  });

  it('places two components side by side with one merged palette', () => {
    const stone = component('a', grid({ x: 2, y: 1, z: 1 }, ['minecraft:stone'], [
      { x: 0, y: 0, z: 0, index: 1 },
      { x: 1, y: 0, z: 0, index: 1 },
    ]));
    const oak = component('b', grid({ x: 2, y: 1, z: 1 }, ['minecraft:oak_planks'], [
      { x: 0, y: 0, z: 0, index: 1 },
    ]));

    const result = composePlan(
      [placement('a', { x: 0, y: 0, z: 0 }), placement('b', { x: 4, y: 0, z: 0 })],
      new Map([
        ['a', stone],
        ['b', oak],
      ]),
    );

    expect(result.grid.size).toEqual({ x: 6, y: 1, z: 1 });
    expect(result.blockCount).toBe(3);
    expect(blockAt(result, 0, 0, 0)).toBe('minecraft:stone');
    expect(blockAt(result, 4, 0, 0)).toBe('minecraft:oak_planks');
    // Air, both palette entries, and nothing duplicated.
    expect(result.grid.palette).toHaveLength(3);
  });

  it('places the same component twice from one entry', () => {
    const one = component('a', grid({ x: 1, y: 1, z: 1 }, ['minecraft:stone'], [
      { x: 0, y: 0, z: 0, index: 1 },
    ]));
    const result = composePlan(
      [placement('a', { x: 0, y: 0, z: 0 }, 0, 'p1'), placement('a', { x: 3, y: 0, z: 0 }, 0, 'p2')],
      new Map([['a', one]]),
    );

    expect(result.blockCount).toBe(2);
    expect(result.grid.palette).toHaveLength(2);
  });

  it('rotates positions and blockstates the same way', () => {
    // A north-facing stair at the footprint's origin corner. After one clockwise quarter it
    // must both *be* in the north-east corner and *face* east. Getting one without the other
    // is the bug this whole convention exists to prevent.
    const stairs = canonical('minecraft:oak_stairs[facing=north,half=bottom,shape=straight]');
    const one = component('a', grid({ x: 3, y: 1, z: 2 }, [stairs], [
      { x: 0, y: 0, z: 0, index: 1 },
    ]));

    const result = composePlan([placement('a', { x: 0, y: 0, z: 0 }, 1)], new Map([['a', one]]));

    expect(result.grid.size).toEqual({ x: 2, y: 1, z: 3 });
    expect(blockAt(result, 1, 0, 0)).toBe(
      canonical('minecraft:oak_stairs[facing=east,half=bottom,shape=straight]'),
    );
  });

  it('keeps every block through a rotation', () => {
    const one = component('a', grid({ x: 3, y: 2, z: 2 }, ['minecraft:stone'], [
      { x: 0, y: 0, z: 0, index: 1 },
      { x: 2, y: 0, z: 1, index: 1 },
      { x: 1, y: 1, z: 0, index: 1 },
    ]));

    for (const rotation of [0, 1, 2, 3] as const) {
      const result = composePlan([placement('a', { x: 0, y: 0, z: 0 }, rotation)], new Map([['a', one]]));
      expect(result.blockCount).toBe(3);
      expect(result.overlaps).toBe(0);
    }
  });

  it('stacks a placement raised off the ground', () => {
    const one = component('a', grid({ x: 1, y: 1, z: 1 }, ['minecraft:stone'], [
      { x: 0, y: 0, z: 0, index: 1 },
    ]));
    const result = composePlan(
      [placement('a', { x: 0, y: 0, z: 0 }, 0, 'p1'), placement('a', { x: 0, y: 4, z: 0 }, 0, 'p2')],
      new Map([['a', one]]),
    );

    expect(result.grid.size).toEqual({ x: 1, y: 5, z: 1 });
    expect(blockAt(result, 0, 0, 0)).toBe('minecraft:stone');
    expect(blockAt(result, 0, 4, 0)).toBe('minecraft:stone');
  });

  it('stamps rather than pastes: a later placement’s air keeps an earlier block', () => {
    const wall = component('a', grid({ x: 3, y: 1, z: 1 }, ['minecraft:stone'], [
      { x: 0, y: 0, z: 0, index: 1 },
      { x: 1, y: 0, z: 0, index: 1 },
      { x: 2, y: 0, z: 0, index: 1 },
    ]));
    // A 3-wide box that is mostly air, laid straight over the wall.
    const sparse = component('b', grid({ x: 3, y: 1, z: 1 }, ['minecraft:oak_planks'], [
      { x: 2, y: 0, z: 0, index: 1 },
    ]));

    const result = composePlan(
      [placement('a', { x: 0, y: 0, z: 0 }), placement('b', { x: 0, y: 0, z: 0 })],
      new Map([
        ['a', wall],
        ['b', sparse],
      ]),
    );

    expect(blockAt(result, 0, 0, 0)).toBe('minecraft:stone');
    expect(blockAt(result, 1, 0, 0)).toBe('minecraft:stone');
    expect(blockAt(result, 2, 0, 0)).toBe('minecraft:oak_planks');
    expect(result.overlaps).toBe(1);
    // The overwritten cell was already counted; it must not be counted twice.
    expect(result.blockCount).toBe(3);
  });

  it('names a component it cannot find instead of dropping it silently', () => {
    const result = composePlan([placement('gone', { x: 0, y: 0, z: 0 })], new Map());
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('gone');
  });

  it('composes the placements it can when one is missing', () => {
    const one = component('a', grid({ x: 1, y: 1, z: 1 }, ['minecraft:stone'], [
      { x: 0, y: 0, z: 0, index: 1 },
    ]));
    const result = composePlan(
      [placement('a', { x: 0, y: 0, z: 0 }), placement('gone', { x: 5, y: 0, z: 0 })],
      new Map([['a', one]]),
    );

    expect(result.blockCount).toBe(1);
    expect(result.errors).toHaveLength(1);
  });
});

describe('placementBox', () => {
  it('measures the rotated footprint, not the source one', () => {
    const one = component('a', grid({ x: 3, y: 2, z: 5 }, [], []));
    expect(placementBox(placement('a', { x: 10, y: 0, z: 20 }, 1), one)).toEqual({
      min: { x: 10, y: 0, z: 20 },
      max: { x: 14, y: 1, z: 22 },
    });
  });
});

describe('clampPosition', () => {
  it('keeps a placement on the plot', () => {
    expect(clampPosition({ x: -5, y: -1, z: 400 }, { x: 10, y: 10, z: 10 })).toEqual({
      x: 0,
      y: 0,
      z: PLAN_SIZE.z - 10,
    });
  });

  it('rounds a dragged fractional position', () => {
    expect(clampPosition({ x: 3.7, y: 0, z: 9.2 }, { x: 4, y: 4, z: 4 })).toEqual({
      x: 4,
      y: 0,
      z: 9,
    });
  });

  it('pins a component larger than the plot to the origin rather than to a negative', () => {
    expect(clampPosition({ x: 20, y: 0, z: 0 }, { x: 400, y: 10, z: 10 }).x).toBe(0);
  });
});
