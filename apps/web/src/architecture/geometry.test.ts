import { describe, expect, it } from 'vitest';
import {
  alignmentGuides,
  rectRight,
  containsRect,
  itemFootprint,
  hitTest,
  intersectRect,
  rectFromPoints,
  snapAperture,
  snapRoomRect,
  stairFootprint,
  wallRuns,
} from './geometry.js';
import { createColumn, createDoor, createRoom, createStair, type PlanItem } from './plan.js';

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

    expect(hitTest(items, 14, 18, 1, 5)?.id).toBe(door.id);
    // And still finds the room everywhere else.
    expect(hitTest(items, 14, 14, 1, 5)?.id).toBe(room.id);
  });

  it('prefers a column to the room it stands in', () => {
    const room = createRoom({ x: 10, z: 10, w: 9, d: 9 });
    const column = createColumn(14, 14);

    expect(hitTest([room, column], 14, 14, 1, 5)?.id).toBe(column.id);
  });

  it('reports nothing on empty ground', () => {
    expect(hitTest([createRoom({ x: 10, z: 10, w: 4, d: 4 })], 30, 30, 1, 5)).toBeNull();
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

describe('alignmentGuides', () => {
  it('finds a guide where two left edges agree', () => {
    const guides = alignmentGuides({ x: 4, z: 20, w: 6, d: 5 }, [{ x: 4, z: 2, w: 3, d: 4 }]);
    expect(guides).toEqual([{ axis: 'x', at: 4, from: 2, to: 25 }]);
  });

  it('finds one where a right edge meets a left edge, which is what sharing a wall looks like', () => {
    const guides = alignmentGuides({ x: 10, z: 0, w: 5, d: 5 }, [{ x: 4, z: 0, w: 6, d: 5 }]);
    // The subject starts at 10 and the neighbour ends at 10.
    expect(guides.some((guide) => guide.axis === 'x' && guide.at === 10)).toBe(true);
  });

  it('spans both rectangles, so the line reaches the thing it is claiming alignment with', () => {
    const [guide] = alignmentGuides({ x: 0, z: 40, w: 4, d: 4 }, [{ x: 0, z: 0, w: 4, d: 4 }]);
    expect(guide).toEqual({ axis: 'x', at: 0, from: 0, to: 44 });
  });

  it('is exact — a block out is not aligned, and pretending otherwise teaches the wrong lesson', () => {
    expect(alignmentGuides({ x: 5, z: 20, w: 4, d: 4 }, [{ x: 4, z: 0, w: 4, d: 4 }])).toEqual([]);
  });

  it('reports both axes when a corner lands on a corner', () => {
    const guides = alignmentGuides({ x: 8, z: 8, w: 4, d: 4 }, [{ x: 0, z: 0, w: 8, d: 8 }]);
    expect(guides.map((guide) => guide.axis).sort()).toEqual(['x', 'z']);
  });

  it('merges duplicates rather than stacking one line per neighbour', () => {
    const guides = alignmentGuides({ x: 4, z: 20, w: 6, d: 5 }, [
      { x: 4, z: 0, w: 3, d: 4 },
      { x: 4, z: 8, w: 3, d: 4 },
    ]);
    expect(guides).toHaveLength(1);
    // ...and the merged line reaches the further of the two.
    expect(guides[0]).toEqual({ axis: 'x', at: 4, from: 0, to: 25 });
  });

  it('caps how many it will draw, so a dense storey does not become a lattice', () => {
    const others = Array.from({ length: 40 }, (_, i) => ({ x: i, z: i, w: 1, d: 1 }));
    expect(alignmentGuides({ x: 0, z: 0, w: 40, d: 40 }, others).length).toBeLessThanOrEqual(6);
  });
});

describe('itemFootprint', () => {
  it('covers a staircase for its whole climb, not just its width', () => {
    const stair = createStair(5, 5, 'south', { width: 2 });
    // Five blocks of storey means five treads, which is what the canvas draws — and what has
    // to be clickable. It used to report 2×2 and leave four fifths of the flight inert.
    expect(itemFootprint(stair, 1, 5)).toEqual({ x: 5, z: 5, w: 2, d: 5 });
  });

  it('so a click anywhere along a flight selects it', () => {
    const stair = createStair(5, 5, 'south', { width: 2 });
    expect(hitTest([stair], 5, 8, 1, 5)?.id).toBe(stair.id);
  });
});

describe('snapRoomRect keeps the size you drew', () => {
  const A = { x: 0, z: 0, w: 6, d: 6 };

  it('shifts a room onto its neighbour instead of stretching it', () => {
    // Dragged flush against A's east edge. Sharing a wall means overlapping it by the wall
    // thickness, so the rect has to move one west — and stay 6 wide.
    expect(snapRoomRect({ x: 6, z: 0, w: 6, d: 6 }, [A], 1, 'draw')).toEqual({ x: 5, z: 0, w: 6, d: 6 });
  });

  it('tiles a 2×2 of 6×6 rooms into four 6×6 rooms', () => {
    // The bug this exists for: every snapped side used to grow the room by one, so four rooms
    // drawn the same size came out 6×6, 7×6, 6×7 and 7×7 and nothing lined up.
    const drawn = [
      { x: 0, z: 0, w: 6, d: 6 },
      { x: 6, z: 0, w: 6, d: 6 },
      { x: 0, z: 6, w: 6, d: 6 },
      { x: 6, z: 6, w: 6, d: 6 },
    ];
    const placed: typeof drawn = [];
    for (const rect of drawn) placed.push(snapRoomRect(rect, placed.slice(), 1, 'draw'));

    expect(placed.map((r) => `${r.w}x${r.d}`)).toEqual(['6x6', '6x6', '6x6', '6x6']);
    expect(placed.map((r) => `${r.x},${r.z}`)).toEqual(['0,0', '5,0', '0,5', '5,5']);
  });

  it('still resizes to fill a gap, when both edges find a neighbour', () => {
    // The one case where the drawn size cannot be honoured, and should not be: a room dragged
    // roughly into a slot between two others is asking to fill the slot exactly.
    const east = { x: 14, z: 0, w: 6, d: 6 };
    const filled = snapRoomRect({ x: 6, z: 0, w: 7, d: 6 }, [A, east], 1, 'draw');
    expect(filled.x).toBe(5);
    expect(filled.x + filled.w).toBe(15);
  });

  it('leaves a room alone when nothing is near enough to snap to', () => {
    expect(snapRoomRect({ x: 20, z: 20, w: 6, d: 6 }, [A], 1, 'draw')).toEqual({
      x: 20,
      z: 20,
      w: 6,
      d: 6,
    });
  });

  it('never resizes on a move, whichever edge is nearer', () => {
    expect(snapRoomRect({ x: 6, z: 0, w: 9, d: 4 }, [A], 1, 'move')).toMatchObject({ w: 9, d: 4 });
  });

  it('shares exactly one wall thickness, so two rooms have one wall between them', () => {
    const b = snapRoomRect({ x: 6, z: 0, w: 6, d: 6 }, [A], 1, 'draw');
    // A covers x 0..5, B covers 5..10: they share column 5 and nothing more.
    expect(rectRight(A) - b.x).toBe(1);
  });

  it('shares a thicker wall when the plan has one', () => {
    const b = snapRoomRect({ x: 6, z: 0, w: 6, d: 6 }, [A], 2, 'draw');
    expect(rectRight(A) - b.x).toBe(2);
    expect(b.w).toBe(6);
  });
});
