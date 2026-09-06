/**
 * The edge-region fix, checked against a model of what the mod actually does.
 *
 * `placed` below is `BuildTask.plan()` in miniature: a turned schematic's cells run from the
 * build origin as the low corner of the turned box. `onMap` is what the whole map *should*
 * look like once region 0 has been placed at the anchor with a rotation — every cell of every
 * region at the turned position of its world coordinate, relative to region 0's own corner.
 * The test is that the two agree for every cell of every region, at every rotation, on a map
 * whose far edges are truncated — which is the one case the raw `anchor + turn(offset)` sum
 * gets wrong, and the common case in practice.
 */

import { describe, expect, it } from 'vitest';
import { deliveryOffset, turnOffset, turnedCornerShift, unturnOffset } from './delivery.js';

const REGION = 128;
/** 300 is not a multiple of 128, so the east and south regions are 44 wide. */
const MAP = { x: 300, z: 300 };
const ANCHOR = { x: -40, y: 64, z: 210 };

interface Box {
  x: number;
  z: number;
  w: number;
  d: number;
}

function regions(): Box[] {
  const out: Box[] = [];
  for (let rz = 0; rz * REGION < MAP.z; rz++) {
    for (let rx = 0; rx * REGION < MAP.x; rx++) {
      const x = rx * REGION;
      const z = rz * REGION;
      out.push({ x, z, w: Math.min(REGION, MAP.x - x), d: Math.min(REGION, MAP.z - z) });
    }
  }
  return out;
}

/** The mod: cells of a `w×d` schematic built from `origin` with `turns` quarter-turns. */
function placed(origin: { x: number; z: number }, size: { w: number; d: number }, turns: number): Set<string> {
  const shift = turnedCornerShift({ x: size.w, z: size.d }, turns);
  const cells = new Set<string>();
  for (let lz = 0; lz < size.d; lz++) {
    for (let lx = 0; lx < size.w; lx++) {
      const t = turnOffset(lx, lz, turns);
      cells.add(`${origin.x + t.x - shift.x},${origin.z + t.z - shift.z}`);
    }
  }
  return cells;
}

/** The map: where a world column should land, given where region 0 was built from. */
function onMap(wx: number, wz: number, first: Box, turns: number): string {
  const shift = turnedCornerShift({ x: first.w, z: first.d }, turns);
  const t = turnOffset(wx, wz, turns);
  return `${ANCHOR.x + t.x - shift.x},${ANCHOR.z + t.z - shift.z}`;
}

describe('the turn and its inverse', () => {
  it('turns clockwise the way the mod and the region materialiser do', () => {
    expect(turnOffset(3, 0, 1)).toEqual({ x: 0, z: 3 });
    expect(turnOffset(3, 0, 2)).toEqual({ x: -3, z: 0 });
    expect(turnOffset(3, 0, 3)).toEqual({ x: 0, z: -3 });
    expect(turnOffset(3, 5, 0)).toEqual({ x: 3, z: 5 });
  });

  it('undoes itself', () => {
    for (let turns = 0; turns < 4; turns++) {
      const t = turnOffset(7, -11, turns);
      expect(unturnOffset(t.x, t.z, turns)).toEqual({ x: 7, z: -11 });
    }
  });
});

describe('deliveryOffset', () => {
  it('hands back the offset untouched when every region shares a footprint', () => {
    const offset = { x: 128, y: 0, z: 256 };
    for (let turns = 0; turns < 4; turns++) {
      expect(deliveryOffset(offset, turns, { x: 128, z: 128 }, { x: 128, z: 128 })).toBe(offset);
    }
  });

  it('hands back the offset untouched on an unrotated map, edge regions included', () => {
    const offset = { x: 256, y: 0, z: 256 };
    expect(deliveryOffset(offset, 0, { x: 128, z: 128 }, { x: 44, z: 44 })).toBe(offset);
  });

  it('lands every cell of every region where the map says, at every quarter turn', () => {
    const [first, ...rest] = regions();
    expect(rest.length).toBe(8);
    for (let turns = 0; turns < 4; turns++) {
      // Region 0 is placed by the player at the anchor, and defines the map.
      expect(placed(ANCHOR, { w: first!.w, d: first!.d }, turns)).toEqual(
        new Set(cellsOf(first!).map(([wx, wz]) => onMap(wx, wz, first!, turns))),
      );

      for (const region of rest) {
        const offset = deliveryOffset(
          { x: region.x, y: 0, z: region.z },
          turns,
          { x: first!.w, z: first!.d },
          { x: region.w, z: region.d },
        );
        // The mod's one sum, on the corrected offset.
        const turned = turnOffset(offset.x, offset.z, turns);
        const origin = { x: ANCHOR.x + turned.x, z: ANCHOR.z + turned.z };

        const expected = new Set(cellsOf(region).map(([wx, wz]) => onMap(wx, wz, first!, turns)));
        expect(placed(origin, { w: region.w, d: region.d }, turns)).toEqual(expected);
      }
    }
  });

  it('is the raw sum that goes wrong on a truncated region under a quarter turn', () => {
    // Pinning the bug this exists to fix, so the test above cannot pass for a trivial reason.
    const [first, ...rest] = regions();
    const edge = rest.find((region) => region.d < REGION)!;
    const raw = turnOffset(edge.x, edge.z, 1);
    const origin = { x: ANCHOR.x + raw.x, z: ANCHOR.z + raw.z };
    const expected = new Set(cellsOf(edge).map(([wx, wz]) => onMap(wx, wz, first!, 1)));
    expect(placed(origin, { w: edge.w, d: edge.d }, 1)).not.toEqual(expected);
  });
});

function cellsOf(box: Box): [number, number][] {
  const out: [number, number][] = [];
  for (let z = box.z; z < box.z + box.d; z++) {
    for (let x = box.x; x < box.x + box.w; x++) out.push([x, z]);
  }
  return out;
}
