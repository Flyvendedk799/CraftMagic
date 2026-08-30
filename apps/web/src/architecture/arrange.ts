/**
 * What you can do to several plan items at once.
 *
 * Architecture mode could always move one thing precisely. What it could not do is make two things
 * agree — line four rooms up along a corridor, space three windows evenly across a wall — and
 * that is most of what drafting a floorplan actually consists of. Doing it by hand means
 * reading a coordinate off one item, typing it into another, and repeating until the numbers
 * match; the arithmetic is trivial and the tedium is the point.
 *
 * Everything here is expressed as an *offset per item* rather than as a new item. Two reasons.
 * The caller already owns the one function that knows how to move each kind of item — a room
 * carries a rect and a door carries a bare x/z — so returning offsets means this module never
 * has to learn that difference. And an offset of zero is self-evidently a no-op, which is what
 * lets "align six rooms that are already aligned" collapse to nothing and leave the undo stack
 * alone.
 *
 * Alignment is to the selection's own bounding box, not to a key item. Aligning to whichever
 * item happened to be clicked last is more powerful once you know the rule and baffling until
 * you do, and the bounding box is the reading that matches what is drawn on screen: the
 * selection outline is right there, and the items move to its edge.
 */

import { itemFootprint, rectBottom, rectRight, type Rect } from './geometry.js';
import type { PlanItem } from './plan.js';

/** Which edge, or which centreline, the selection lines up on. */
export type AlignMode = 'left' | 'centerX' | 'right' | 'top' | 'centerZ' | 'bottom';

/** Which way items are spaced out evenly. */
export type DistributeAxis = 'x' | 'z';

export interface Offset {
  dx: number;
  dz: number;
}

/**
 * A move per item id. Ids absent from the map do not move.
 *
 * Empty when there is nothing to do, so a caller can treat "no entries" as "leave history
 * alone" without inspecting the values.
 */
export type Offsets = Map<string, Offset>;

interface Measured {
  id: string;
  rect: Rect;
}

function measure(
  items: readonly PlanItem[],
  ids: readonly string[],
  wallThickness: number,
  storeyHeight: number,
): Measured[] {
  const wanted = new Set(ids);
  return items
    .filter((item) => wanted.has(item.id))
    .map((item) => ({ id: item.id, rect: itemFootprint(item, wallThickness, storeyHeight) }));
}

/** Drops the zero moves, so an already-aligned selection produces an empty map. */
function pack(moves: Iterable<[string, Offset]>): Offsets {
  const out: Offsets = new Map();
  for (const [id, offset] of moves) {
    if (offset.dx !== 0 || offset.dz !== 0) out.set(id, offset);
  }
  return out;
}

/** The box every selected item fits inside, in plan coordinates. */
export function selectionBounds(
  items: readonly PlanItem[],
  ids: readonly string[],
  wallThickness: number,
  storeyHeight: number,
): Rect | null {
  const measured = measure(items, ids, wallThickness, storeyHeight);
  if (measured.length === 0) return null;

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const { rect } of measured) {
    minX = Math.min(minX, rect.x);
    minZ = Math.min(minZ, rect.z);
    maxX = Math.max(maxX, rectRight(rect));
    maxZ = Math.max(maxZ, rectBottom(rect));
  }
  return { x: minX, z: minZ, w: maxX - minX, d: maxZ - minZ };
}

export function alignOffsets(
  items: readonly PlanItem[],
  ids: readonly string[],
  wallThickness: number,
  storeyHeight: number,
  mode: AlignMode,
): Offsets {
  const measured = measure(items, ids, wallThickness, storeyHeight);
  // One item is already aligned with itself. Refusing here rather than returning zeroes keeps
  // the button's disabled state and the function's behaviour saying the same thing.
  if (measured.length < 2) return new Map();

  const bounds = selectionBounds(items, ids, wallThickness, storeyHeight)!;

  return pack(
    measured.map(({ id, rect }): [string, Offset] => {
      switch (mode) {
        case 'left':
          return [id, { dx: bounds.x - rect.x, dz: 0 }];
        case 'right':
          return [id, { dx: rectRight(bounds) - rectRight(rect), dz: 0 }];
        case 'centerX':
          // Rounded, because a plan coordinate is a block. Centring an odd-width item inside
          // an even-width selection has to land somewhere, and half a block is not a place.
          return [id, { dx: Math.round(bounds.x + bounds.w / 2 - (rect.x + rect.w / 2)), dz: 0 }];
        case 'top':
          return [id, { dx: 0, dz: bounds.z - rect.z }];
        case 'bottom':
          return [id, { dx: 0, dz: rectBottom(bounds) - rectBottom(rect) }];
        case 'centerZ':
          return [id, { dx: 0, dz: Math.round(bounds.z + bounds.d / 2 - (rect.z + rect.d / 2)) }];
      }
    }),
  );
}

/**
 * Space items evenly along one axis, holding the two outermost where they are.
 *
 * Equal *gaps*, not equal centres. Design tools usually distribute centres, and for icons of
 * a similar size the two agree; for rooms they do not, and a row of a 12-block room, a 4-block
 * closet and a 9-block room with evenly spaced centres has visibly uneven walls between them.
 * A floorplan is read by its gaps.
 *
 * A negative gap — items that overlap more than the span allows — is left alone rather than
 * distributed into a pile: there is no arrangement that satisfies the request, and silently
 * producing overlapping rooms would look like a bug in the room snap.
 */
export function distributeOffsets(
  items: readonly PlanItem[],
  ids: readonly string[],
  wallThickness: number,
  storeyHeight: number,
  axis: DistributeAxis,
): Offsets {
  const measured = measure(items, ids, wallThickness, storeyHeight);
  // Two items have no space between them to even out — the ends are the ends.
  if (measured.length < 3) return new Map();

  const low = (rect: Rect) => (axis === 'x' ? rect.x : rect.z);
  const extent = (rect: Rect) => (axis === 'x' ? rect.w : rect.d);

  const order = [...measured].sort((a, b) => low(a.rect) - low(b.rect));
  const first = order[0]!;
  const last = order[order.length - 1]!;

  const span = low(last.rect) + extent(last.rect) - low(first.rect);
  let occupied = 0;
  for (const { rect } of order) occupied += extent(rect);

  const gap = (span - occupied) / (order.length - 1);
  if (gap < 0) return new Map();

  const moves: [string, Offset][] = [];
  let cursor = low(first.rect);
  for (const { id, rect } of order) {
    // Rounded per item against the running cursor rather than accumulated from a rounded gap,
    // so the drift never compounds and the last item lands exactly where it started.
    const target = Math.round(cursor);
    const delta = target - low(rect);
    moves.push([id, axis === 'x' ? { dx: delta, dz: 0 } : { dx: 0, dz: delta }]);
    cursor += extent(rect) + gap;
  }

  // The two ends are fixed by definition; rounding must never be allowed to nudge them.
  moves[0] = [first.id, { dx: 0, dz: 0 }];
  moves[moves.length - 1] = [last.id, { dx: 0, dz: 0 }];

  return pack(moves);
}
