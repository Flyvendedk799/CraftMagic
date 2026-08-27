import { describe, expect, it } from 'vitest';
import {
  containsRect,
  hitTest,
  intersectRect,
  rectFromPoints,
  snapAperture,
  snapRoomRect,
  stairFootprint,
  wallRuns,
} from './geometry.js';
import { createColumn, createDoor, createRoom, type PlanItem } from './plan.js';

describe('rectFromPoints', () => {
  it('includes both ends, so a single-cell drag is a 1×1', () => {
    expect(rectFromPoints({ x: 3, z: 5 }, { x: 3, z: 5 })).toEqual({ x: 3, z: 5, w: 1, d: 1 });
  });

  it('normalizes a drag made in any direction', () => {
    expect(rectFromPoints({ x: 8, z: 9 }, { x: 4, z: 2 })).toEqual({ x: 4, z: 2, w: 5, d: 8 });
  });
});

describe('intersectRect and containsRect', () => {
  it('reports the shared rect, and nothing for rects that merely touch', () => {
    expect(intersectRect({ x: 0, z: 0, w: 5, d: 5 }, { x: 4, z: 0, w: 5, d: 5 })).toEqual({
      x: 4,
      z: 0,
      w: 1,
      d: 5,
    });
    // Edge to edge with no overlap: neighbours, not a collision.
    expect(intersectRect({ x: 0, z: 0, w: 5, d: 5 }, { x: 5, z: 0, w: 5, d: 5 })).toBeNull();
  });

  it('knows a room drawn inside another from one drawn across it', () => {
    const outer = { x: 0, z: 0, w: 20, d: 20 };
    expect(containsRect(outer, { x: 5, z: 5, w: 6, d: 6 })).toBe(true);
    expect(containsRect(outer, { x: 15, z: 5, w: 10, d: 6 })).toBe(false);
  });
});

describe('snapRoomRect', () => {
  it('overlaps a neighbour by the wall thickness, so the two share one wall', () => {
    const neighbour = { x: 10, z: 10, w: 8, d: 8 };
    // Drawn one block clear of the neighbour's east edge — the near miss a drag actually makes.
    const drawn = { x: 19, z: 10, w: 6, d: 8 };

    const snapped = snapRoomRect(drawn, [neighbour], 1, 'draw');

    // The east edge of the neighbour is 18; sharing means starting one thickness inside it.
    expect(snapped.x).toBe(17);
    expect(snapped.z).toBe(10);
  });

  it('keeps the size when moving rather than drawing', () => {
    const neighbour = { x: 10, z: 10, w: 8, d: 8 };
    const moved = { x: 19, z: 11, w: 6, d: 8 };

    const snapped = snapRoomRect(moved, [neighbour], 1, 'move');

    expect(snapped.w).toBe(6);
    expect(snapped.d).toBe(8);
    expect(snapped.x).toBe(17);
  });

  it('leaves a room that is nowhere near anything alone', () => {
    const drawn = { x: 40, z: 40, w: 5, d: 5 };
    expect(snapRoomRect(drawn, [{ x: 10, z: 10, w: 8, d: 8 }], 1, 'draw')).toEqual(drawn);
  });
});

describe('snapAperture', () => {
  const room = createRoom({ x: 10, z: 10, w: 9, d: 9 });
  const runs = wallRuns([room], 1);

  it('pulls a click near a wall into that wall and takes its facing', () => {
    // Two blocks south of the room's south wall, which sits at z = 18.
    const snapped = snapAperture(runs, 14, 20, 1);

    expect(snapped).not.toBeNull();
    expect(snapped!.z).toBe(18);
    expect(snapped!.x).toBe(14);
    expect(snapped!.facing).toBe('south');
    expect(snapped!.axis).toBe('x');
  });

  it('keeps the whole opening inside the wall it lands on', () => {
    // Hard against the east end of the south wall, with a two-block opening.
    const snapped = snapAperture(runs, 18, 19, 2);

    expect(snapped).not.toBeNull();
    // The run covers x 10–18, so a 2-wide opening can start no further east than 17.
    expect(snapped!.x).toBe(17);
  });

  it('refuses a click that is not near any wall', () => {
    expect(snapAperture(runs, 40, 40, 1)).toBeNull();
  });
});

describe('hitTest', () => {
  it('picks a door out of the wall it was cut into', () => {
    const room = createRoom({ x: 10, z: 10, w: 9, d: 9 });
    const door = createDoor(14, 18, 'south');
    const items: PlanItem[] = [room, door];

    expect(hitTest(items, 14, 18, 1)?.id).toBe(door.id);
    // And still finds the room everywhere else.
    expect(hitTest(items, 14, 14, 1)?.id).toBe(room.id);
  });

  it('prefers a column to the room it stands in', () => {
    const room = createRoom({ x: 10, z: 10, w: 9, d: 9 });
    const column = createColumn(14, 14);

    expect(hitTest([room, column], 14, 14, 1)?.id).toBe(column.id);
  });

  it('reports nothing on empty ground', () => {
    expect(hitTest([createRoom({ x: 10, z: 10, w: 4, d: 4 })], 30, 30, 1)).toBeNull();
  });
});

describe('stairFootprint', () => {
  it('runs forward from the bottom step going south', () => {
    expect(stairFootprint(5, 5, 'south', 2, 5)).toEqual({ x: 5, z: 5, w: 2, d: 5 });
  });

  it('runs back from the bottom step going north, so the click stays where you clicked', () => {
    expect(stairFootprint(5, 10, 'north', 2, 5)).toEqual({ x: 5, z: 6, w: 2, d: 5 });
  });

  it('swaps the axes for an east-west run', () => {
    expect(stairFootprint(5, 5, 'east', 3, 4)).toEqual({ x: 5, z: 5, w: 4, d: 3 });
    expect(stairFootprint(10, 5, 'west', 3, 4)).toEqual({ x: 7, z: 5, w: 4, d: 3 });
  });
});
