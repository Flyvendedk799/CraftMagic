import { describe, expect, it } from 'vitest';
import { alignOffsets, distributeOffsets, selectionBounds } from './arrange.js';
import { createColumn, createRoom, type PlanItem } from './plan.js';

/** Rooms with predictable ids, so a test can name them. */
function room(id: string, x: number, z: number, w: number, d: number): PlanItem {
  return { ...createRoom({ x, z, w, d }, { label: id }), id };
}

const WALL = 1;
const STOREY = 5;

function applied(items: readonly PlanItem[], offsets: Map<string, { dx: number; dz: number }>) {
  return items.map((item) => {
    const move = offsets.get(item.id) ?? { dx: 0, dz: 0 };
    const rect = 'rect' in item ? item.rect : null;
    return rect
      ? `${item.id}:${rect.x + move.dx},${rect.z + move.dz}`
      : `${item.id}:${(item as { x: number }).x + move.dx},${(item as { z: number }).z + move.dz}`;
  });
}

describe('selectionBounds', () => {
  it('boxes every selected item and ignores the rest', () => {
    const items = [room('a', 2, 3, 6, 6), room('b', 20, 1, 4, 10), room('c', 40, 40, 5, 5)];
    expect(selectionBounds(items, ['a', 'b'], WALL, STOREY)).toEqual({ x: 2, z: 1, w: 22, d: 10 });
  });

  it('is null when nothing is selected', () => {
    expect(selectionBounds([room('a', 0, 0, 4, 4)], [], WALL, STOREY)).toBeNull();
  });
});

describe('alignOffsets', () => {
  const items = [room('a', 0, 0, 10, 4), room('b', 4, 8, 6, 4), room('c', 2, 20, 8, 4)];
  const ids = ['a', 'b', 'c'];

  it('pulls every left edge to the selection box', () => {
    expect(applied(items, alignOffsets(items, ids, WALL, STOREY, 'left'))).toEqual([
      'a:0,0',
      'b:0,8',
      'c:0,20',
    ]);
  });

  it('pushes every right edge to the selection box', () => {
    // The box runs to x=10, so b (6 wide) starts at 4 and c (8 wide) at 2.
    expect(applied(items, alignOffsets(items, ids, WALL, STOREY, 'right'))).toEqual([
      'a:0,0',
      'b:4,8',
      'c:2,20',
    ]);
  });

  it('centres on the box, rounding to whole blocks', () => {
    expect(applied(items, alignOffsets(items, ids, WALL, STOREY, 'centerX'))).toEqual([
      'a:0,0',
      'b:2,8',
      'c:1,20',
    ]);
  });

  it('aligns on z as readily as on x', () => {
    expect(applied(items, alignOffsets(items, ids, WALL, STOREY, 'top'))).toEqual([
      'a:0,0',
      'b:4,0',
      'c:2,0',
    ]);
    expect(applied(items, alignOffsets(items, ids, WALL, STOREY, 'bottom'))).toEqual([
      'a:0,20',
      'b:4,20',
      'c:2,20',
    ]);
  });

  it('measures a stair or a column by its footprint, not by its corner', () => {
    // A column is 1x1 at its own x/z; aligning it right must land its far edge on the box.
    const mixed = [room('a', 0, 0, 10, 4), { ...createColumn(3, 3), id: 'col' }];
    expect(applied(mixed, alignOffsets(mixed, ['a', 'col'], WALL, STOREY, 'right'))).toEqual([
      'a:0,0',
      'col:9,3',
    ]);
  });

  it('does nothing to a selection of one, or to one already aligned', () => {
    expect(alignOffsets(items, ['a'], WALL, STOREY, 'left').size).toBe(0);
    const flush = [room('a', 5, 0, 4, 4), room('b', 5, 9, 7, 4)];
    expect(alignOffsets(flush, ['a', 'b'], WALL, STOREY, 'left').size).toBe(0);
  });
});

describe('distributeOffsets', () => {
  it('evens out the gaps and leaves the two ends where they are', () => {
    // Widths 4, 2, 4 across a span of 0..20: 10 blocks of gap over two gaps is 5 each.
    const items = [room('a', 0, 0, 4, 4), room('b', 6, 0, 2, 4), room('c', 16, 0, 4, 4)];
    expect(applied(items, distributeOffsets(items, ['a', 'b', 'c'], WALL, STOREY, 'x'))).toEqual([
      'a:0,0',
      'b:9,0',
      'c:16,0',
    ]);
  });

  it('spaces by gap rather than by centre, so uneven widths still read evenly', () => {
    // Centres would put the 2-wide item at 9; equal gaps put it at 8, which is where the wall
    // either side of it is the same thickness.
    const items = [room('a', 0, 0, 6, 4), room('b', 7, 0, 2, 4), room('c', 12, 0, 6, 4)];
    const out = distributeOffsets(items, ['a', 'b', 'c'], WALL, STOREY, 'x');
    expect(applied(items, out)).toEqual(['a:0,0', 'b:8,0', 'c:12,0']);
  });

  it('works down the z axis too, and sorts by position rather than by selection order', () => {
    const items = [room('c', 0, 16, 4, 4), room('a', 0, 0, 4, 4), room('b', 0, 6, 4, 4)];
    expect(applied(items, distributeOffsets(items, ['a', 'b', 'c'], WALL, STOREY, 'z'))).toEqual([
      'c:0,16',
      'a:0,0',
      'b:0,8',
    ]);
  });

  it('refuses when there is no room to distribute into', () => {
    const items = [room('a', 0, 0, 8, 4), room('b', 2, 0, 8, 4), room('c', 4, 0, 8, 4)];
    expect(distributeOffsets(items, ['a', 'b', 'c'], WALL, STOREY, 'x').size).toBe(0);
  });

  it('needs three items before there is a gap to even out', () => {
    const items = [room('a', 0, 0, 4, 4), room('b', 20, 0, 4, 4)];
    expect(distributeOffsets(items, ['a', 'b'], WALL, STOREY, 'x').size).toBe(0);
  });

  it('lands the last item exactly where it started, however the rounding fell', () => {
    const items = [
      room('a', 0, 0, 3, 4),
      room('b', 5, 0, 3, 4),
      room('c', 11, 0, 3, 4),
      room('d', 17, 0, 3, 4),
      room('e', 25, 0, 3, 4),
    ];
    const out = distributeOffsets(items, ['a', 'b', 'c', 'd', 'e'], WALL, STOREY, 'x');
    expect(out.get('a')).toBeUndefined();
    expect(out.get('e')).toBeUndefined();
  });
});
