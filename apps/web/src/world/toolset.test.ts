import { describe, expect, it } from 'vitest';
import type { WorldPlacement } from '@craftmagic/core';
import { WORLD_TOOLS, dropCorner, placementFacing, placementFootprint, turnedAboutCentre } from './toolset.js';

const long: WorldPlacement = {
  id: 'p1', buildId: 'b', x: 100, z: 100, y: 62, anchor: 'surface', turns: 0,
  name: 'Hall', w: 20, h: 10, d: 8,
};

const centre = (placement: WorldPlacement) => {
  const box = placementFootprint(placement);
  return { x: box.x + box.w / 2, z: box.z + box.d / 2 };
};

describe('turnedAboutCentre', () => {
  it('keeps a long building standing where it was', () => {
    const before = centre(long);
    const turned = { ...long, ...turnedAboutCentre(long, 1) };
    expect(turned.turns).toBe(1);
    expect(placementFootprint(turned)).toMatchObject({ w: 8, d: 20 });
    expect(centre(turned)).toEqual(before);
  });

  it('comes back to where it started after four turns either way', () => {
    let right = long;
    let left = long;
    for (let i = 0; i < 4; i++) {
      right = { ...right, ...turnedAboutCentre(right, 1) };
      left = { ...left, ...turnedAboutCentre(left, -1) };
    }
    expect(right).toEqual(long);
    expect(left).toEqual(long);
  });

  it('turns left from zero to three, not to minus one', () => {
    expect(turnedAboutCentre(long, -1).turns).toBe(3);
  });

  it('never pushes the corner off the map', () => {
    const atEdge = { ...long, x: 0, z: 0 };
    const turned = turnedAboutCentre(atEdge, 1);
    expect(turned.x).toBeGreaterThanOrEqual(0);
    expect(turned.z).toBeGreaterThanOrEqual(0);
  });
});

describe('dropCorner', () => {
  it('centres the footprint on the column', () => {
    expect(dropCorner(50, 50, { w: 10, d: 4 }, { x: 512, z: 512 })).toEqual({ x: 45, z: 48 });
  });

  it('clamps to the map', () => {
    expect(dropCorner(0, 0, { w: 10, d: 10 }, { x: 512, z: 512 })).toEqual({ x: 0, z: 0 });
    expect(dropCorner(600, 600, { w: 10, d: 10 }, { x: 512, z: 512 })).toEqual({ x: 511, z: 511 });
  });
});

describe('placementFacing', () => {
  const box = { x: 10, z: 20, w: 30, d: 40 };

  it('calculates the front edge for each quarter turn', () => {
    // 0 turns: south (+z edge, y = 20 + 40 = 60)
    expect(placementFacing(box, 0)).toEqual({ x1: 10, y1: 60, x2: 40, y2: 60 });
    // 1 turn: west (-x edge, x = 10)
    expect(placementFacing(box, 1)).toEqual({ x1: 10, y1: 20, x2: 10, y2: 60 });
    // 2 turns: north (-z edge, y = 20)
    expect(placementFacing(box, 2)).toEqual({ x1: 10, y1: 20, x2: 40, y2: 20 });
    // 3 turns: east (+x edge, x = 10 + 30 = 40)
    expect(placementFacing(box, 3)).toEqual({ x1: 40, y1: 20, x2: 40, y2: 60 });
  });

  it('handles negative and wrapping turns', () => {
    expect(placementFacing(box, -1)).toEqual(placementFacing(box, 3));
    expect(placementFacing(box, 4)).toEqual(placementFacing(box, 0));
  });
});

