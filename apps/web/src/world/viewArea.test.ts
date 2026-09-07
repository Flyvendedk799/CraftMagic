/**
 * The viewer's cell budget.
 *
 * The interesting property is not that a big rectangle gets smaller — it is *which* smaller
 * rectangle you get. The anchor has to survive, because it is the region the user picked and
 * the one the export controls cover, and the result has to stay as square as it can, because a
 * strip of five regions one deep says much less about a neighbourhood than a 2×2 does.
 *
 * The other thing worth pinning down is that the budget is in cells rather than in regions. A
 * region is only as tall as its contents, so four flat regions genuinely are cheaper than one
 * containing a spire, and a cap counted in regions would allow the expensive case and forbid
 * the cheap one.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, resizeWorld, type WorldDoc } from '@craftmagic/core';
import { areaHolds, fitArea, regionOfColumn, spanOf } from './viewArea.js';

/** A flat world of a given size, at the region size the tests reason in. */
function world(sizeX: number, sizeZ: number, regionSize: number, height = 62): WorldDoc {
  const base = createWorld();
  const sized = resizeWorld(base, { x: sizeX, z: sizeZ }).world;
  sized.settings.regionSize = regionSize;
  sized.terrain.height.fill(height);
  return sized;
}

describe('fitArea', () => {
  it('leaves an area that fits alone', () => {
    const doc = world(256, 256, 128);
    const fitted = fitArea(doc, { rx0: 0, rz0: 0, rx1: 1, rz1: 1 });
    expect(fitted.area).toEqual({ rx0: 0, rz0: 0, rx1: 1, rz1: 1 });
    expect(fitted.dropped).toBe(0);
  });

  it('shrinks a rectangle that does not, and says how much it lost', () => {
    const doc = world(512, 512, 128);
    // 512×512 columns over a 31-block extent is about eight million cells, so a budget of one
    // million can only be a fraction of it.
    const fitted = fitArea(doc, { rx0: 0, rz0: 0, rx1: 3, rz1: 3 }, undefined, 1_000_000);
    expect(fitted.cells).toBeLessThanOrEqual(1_000_000);
    expect(fitted.dropped).toBeGreaterThan(0);
    expect(fitted.area.rx0).toBe(0);
    expect(fitted.area.rz0).toBe(0);
  });

  it('keeps the anchor, shrinking away from it', () => {
    const doc = world(512, 512, 128);
    const fitted = fitArea(doc, { rx0: 2, rz0: 2, rx1: 3, rz1: 3 }, undefined, 1);
    expect(fitted.area).toEqual({ rx0: 2, rz0: 2, rx1: 2, rz1: 2 });
  });

  it('never shrinks below one region, however tall it is', () => {
    // A single region over the full 32..192 span: far past any sane budget, and still the only
    // honest answer. A viewer that renders nothing because the map is tall is a bug.
    const doc = world(256, 256, 128, 190);
    const fitted = fitArea(doc, { rx0: 0, rz0: 0, rx1: 0, rz1: 0 }, undefined, 1);
    expect(fitted.area).toEqual({ rx0: 0, rz0: 0, rx1: 0, rz1: 0 });
    expect(fitted.cells).toBeGreaterThan(1);
    expect(fitted.dropped).toBe(0);
  });

  it('takes the longer side off first, so what is left stays square', () => {
    const doc = world(512, 256, 128);
    // Four wide by two deep. The first cut has to come off the width.
    const fitted = fitArea(doc, { rx0: 0, rz0: 0, rx1: 3, rz1: 1 }, undefined, 3_000_000);
    expect(fitted.area.rz1 - fitted.area.rz0).toBe(1);
    expect(fitted.area.rx1 - fitted.area.rx0).toBeLessThan(3);
  });

  it('budgets in cells, so a tall region costs more than several flat ones', () => {
    const flat = world(512, 128, 128, 40);
    const tall = world(512, 128, 128, 40);
    // One spire in the western region. It lifts the extent of any area containing it, which is
    // the cost that a cap counted in regions would miss entirely.
    tall.terrain.height[64 * 512 + 64] = 190;

    const budget = 3_000_000;
    const across = { rx0: 0, rz0: 0, rx1: 3, rz1: 0 };
    expect(fitArea(flat, across, undefined, budget).dropped).toBe(0);
    expect(fitArea(tall, across, undefined, budget).dropped).toBeGreaterThan(0);
  });

  it('orders and clips the request before measuring it', () => {
    const doc = world(256, 256, 128);
    const fitted = fitArea(doc, { rx0: 5, rz0: 5, rx1: -3, rz1: -3 });
    expect(fitted.area).toEqual({ rx0: 0, rz0: 0, rx1: 1, rz1: 1 });
  });
});

describe('area helpers', () => {
  it('says whether a region is in view', () => {
    const area = { rx0: 1, rz0: 1, rx1: 2, rz1: 3 };
    expect(areaHolds(area, 1, 1)).toBe(true);
    expect(areaHolds(area, 2, 3)).toBe(true);
    expect(areaHolds(area, 0, 1)).toBe(false);
    expect(areaHolds(area, 2, 4)).toBe(false);
  });

  it('finds the region a column falls in', () => {
    expect(regionOfColumn(128, 0, 0)).toEqual({ rx: 0, rz: 0 });
    expect(regionOfColumn(128, 127, 128)).toEqual({ rx: 0, rz: 1 });
    expect(regionOfColumn(128, 300, 40)).toEqual({ rx: 2, rz: 0 });
  });

  it('reads a rectangle as its longer side', () => {
    expect(spanOf({ rx0: 0, rz0: 0, rx1: 0, rz1: 0 })).toBe(1);
    expect(spanOf({ rx0: 0, rz0: 0, rx1: 1, rz1: 1 })).toBe(2);
    expect(spanOf({ rx0: 0, rz0: 0, rx1: 0, rz1: 4 })).toBe(5);
  });
});
