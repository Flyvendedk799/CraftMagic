import { describe, expect, it } from 'vitest';
import { expand, buildGuide, samples } from '@craftmagic/core';
import { cellSizeFor, columnLabel, earlierInLayer, footprint } from './layerGrid.js';

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
