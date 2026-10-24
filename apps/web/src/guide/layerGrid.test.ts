import { describe, expect, it } from 'vitest';
import { expand, buildGuide, samples } from '@craftmagic/core';
import {
  cellSizeFor,
  columnLabel,
  earlierInLayer,
  footprint,
  isInteriorVoid,
  isPlanCellOverhang,
  type LayerPlan,
} from './layerGrid.js';

/**
 * The drawing itself needs a canvas and is verified by looking at it. What is pinned here is
 * the geometry underneath — the numbers that decide whether a printed plan can be counted,
 * and the accumulation that decides which squares read as "already done".
 */

describe('cellSizeFor', () => {
  it('keeps squares countable at sample-build sizes', () => {
    // 21x13 (cottage) and 17x17 (tower) must clear the legibility floor.
    expect(cellSizeFor(21, 13)).toBeGreaterThanOrEqual(12);
    expect(cellSizeFor(17, 17)).toBeGreaterThanOrEqual(12);
  });

  it('caps the square size so one step cannot eat a page', () => {
    expect(cellSizeFor(2, 2)).toBeLessThanOrEqual(24);
  });

  it('gives up square size rather than emit an oversized canvas', () => {
    // A 150-wide stress build: an oversized image is a broken layout, a small square is only
    // hard to read, so the page cap wins.
    const cell = cellSizeFor(150, 150);
    expect(cell).toBeLessThan(12);
    expect(cell * 150).toBeLessThanOrEqual(660);
  });
});

describe('columnLabel', () => {
  it('runs A..Z then AA, so a wide plan still has unique labels', () => {
    expect(columnLabel(0)).toBe('A');
    expect(columnLabel(25)).toBe('Z');
    expect(columnLabel(26)).toBe('AA');
    expect(columnLabel(27)).toBe('AB');
    expect(columnLabel(51)).toBe('AZ');
    expect(columnLabel(52)).toBe('BA');
  });
});

describe('footprint', () => {
  it('is the inclusive x/z box of every cell', () => {
    expect(footprint([
      { x: 3, z: 7, paletteIndex: 1 },
      { x: 9, z: 2, paletteIndex: 1 },
    ])).toEqual({ x0: 3, z0: 2, x1: 9, z1: 7 });
  });

  it('degrades to a single cell rather than infinities when empty', () => {
    expect(footprint([])).toEqual({ x0: 0, z0: 0, x1: 0, z1: 0 });
  });
});

describe('earlierInLayer', () => {
  const guide = buildGuide(expand(samples.cottage!).grid, 'Cottage');

  it('gives the first step of a layer no context', () => {
    const earlier = earlierInLayer(guide.steps);
    for (const [i, step] of guide.steps.entries()) {
      const first = !step.partOfLayer || step.partOfLayer.part === 1;
      if (first) expect(earlier[i]).toHaveLength(0);
    }
  });

  it('accumulates only within the layer, never across one', () => {
    const earlier = earlierInLayer(guide.steps);
    const split = guide.steps.findIndex((step) => step.partOfLayer?.part === 2);
    expect(split).toBeGreaterThan(-1);

    const previous = guide.steps[split - 1]!;
    expect(earlier[split]).toHaveLength(previous.blocks.length);
    // The context is exactly the preceding part's cells, so a reader sees the wall they
    // just built rather than the whole storey.
    expect(earlier[split]![0]).toEqual({
      x: previous.blocks[0]!.x,
      z: previous.blocks[0]!.z,
      paletteIndex: previous.blocks[0]!.paletteIndex,
    });
  });
});

describe('overhang and void indicators', () => {
  it('detects cantilever blocks placed over air as overhangs', () => {
    // 3x3x3 grid where (1, 1, 1) has no block at (1, 0, 1)
    const size = { x: 3, y: 3, z: 3 };
    const voxels = new Uint16Array(3 * 3 * 3);
    // At y=0: block at (0, 0, 0)
    voxels[0] = 1;
    // At y=1: block placed at (1, 1, 1) -> below is air
    const placedIdx = 1 * 9 + 1 * 3 + 1;
    voxels[placedIdx] = 1;

    const plan: LayerPlan = {
      size,
      voxels,
      paletteColors: new Uint8Array(6),
      footprint: { x0: 0, z0: 0, x1: 2, z1: 2 },
      layer: 1,
      placed: [{ x: 1, z: 1, paletteIndex: 1 }],
      earlier: [],
    };

    expect(isPlanCellOverhang(plan, { x: 1, z: 1, paletteIndex: 1 })).toBe(true);

    // If y=0 has a supporting block below (1, 1, 1):
    voxels[1 * 3 + 1] = 1;
    expect(isPlanCellOverhang(plan, { x: 1, z: 1, paletteIndex: 1 })).toBe(false);
  });

  it('identifies interior void / open shaft cells in a hollow tower', () => {
    // 5x3x5 grid with a hollow tower: walls around perimeter at y=0, interior is air
    const size = { x: 5, y: 3, z: 5 };
    const voxels = new Uint16Array(5 * 3 * 5);

    // Build solid perimeter walls at layer y=0
    for (let x = 0; x < 5; x++) {
      voxels[0 * 25 + 0 * 5 + x] = 1; // North wall
      voxels[0 * 25 + 4 * 5 + x] = 1; // South wall
    }
    for (let z = 0; z < 5; z++) {
      voxels[0 * 25 + z * 5 + 0] = 1; // West wall
      voxels[0 * 25 + z * 5 + 4] = 1; // East wall
    }

    const plan: LayerPlan = {
      size,
      voxels,
      paletteColors: new Uint8Array(6),
      footprint: { x0: 0, z0: 0, x1: 4, z1: 4 },
      layer: 1,
      placed: [{ x: 0, z: 0, paletteIndex: 1 }],
      earlier: [],
    };

    // Interior shaft cell (2, 2) is enclosed by solid walls at y=0
    expect(isInteriorVoid(plan, 2, 2)).toBe(true);
    // Interior shaft cell (1, 1) is also enclosed
    expect(isInteriorVoid(plan, 1, 1)).toBe(true);

    // Placed cell on this layer is not an interior void
    expect(isInteriorVoid(plan, 0, 0)).toBe(false);
    // Solid wall below at (0, 2) is not void
    expect(isInteriorVoid(plan, 0, 2)).toBe(false);
    // Cell outside footprint is not interior void
    expect(isInteriorVoid(plan, 6, 6)).toBe(false);
  });

  it('does not classify open exterior air under an overhang as interior void', () => {
    // 6x3x5 grid with solid base at x in [2, 5], overhang at x=0 on layer y=1
    const size = { x: 6, y: 3, z: 5 };
    const voxels = new Uint16Array(6 * 3 * 5);

    // Solid base at layer y=0 for x in [2, 5]
    for (let z = 0; z < 5; z++) {
      for (let x = 2; x < 6; x++) {
        voxels[0 * 30 + z * 6 + x] = 1;
      }
    }

    // Overhang block at layer y=1
    voxels[1 * 30 + 2 * 6 + 0] = 1;

    const plan: LayerPlan = {
      size,
      voxels,
      paletteColors: new Uint8Array(6),
      footprint: { x0: 0, z0: 0, x1: 5, z1: 4 },
      layer: 1,
      placed: [{ x: 0, z: 2, paletteIndex: 1 }],
      earlier: [],
    };

    // (0, 2) is an overhang
    expect(isPlanCellOverhang(plan, { x: 0, z: 2, paletteIndex: 1 })).toBe(true);

    // Air at (1, 2) is exterior air reaching the world boundary, NOT an interior shaft
    expect(isInteriorVoid(plan, 1, 2)).toBe(false);
    // Air at (1, 0) reaches the boundary, NOT an interior shaft
    expect(isInteriorVoid(plan, 1, 0)).toBe(false);
  });
});
