/**
 * Plan-space geometry: rectangles, wall runs, hit testing and the snapping that makes
 * drawing a floorplan feel like drawing rather than like typing coordinates.
 *
 * All of it is pure and integer-only, which is what lets the whole thing be tested without a
 * canvas. `PlanCanvas` converts pointer positions to plan cells and asks these functions what
 * that means; nothing here knows a pointer exists.
 *
 * Three ideas are ported from the level editor engine in flyvendedk799/firstpgame
 * (`src/customMaps/levelEditor.js`):
 *
 * - **Grid snapping** (`snapGrid` there): every drag lands on whole cells, so nothing is ever
 *   half a block out of line with anything else.
 * - **Wall-insert snapping** (`wallInsertSnap` there): a door or window dropped near a wall
 *   jumps *into* that wall and takes its orientation, instead of floating beside it. That one
 *   behaviour is most of what separates a plan editor from a drawing program.
 * - **Edge snapping** (its socket snapping, generalised): a room dragged near another room's
 *   edge aligns to it, and — the part that matters for architecture — overlaps it by exactly
 *   the wall thickness, so the two rooms come out sharing one wall instead of growing two
 *   parallel ones with a dead cavity between.
 */

import type { Face } from '@craftmagic/core';
import { furnishingById, furnishingFootprint } from './furniture.js';
import { placeFootprint, type LayoutPlan, type PlanAxis, type PlanItem, type Rect, type RoomItem } from './plan.js';

// Re-exported because every caller that measures with this module also has to name what it
// measured, and importing the two halves from two files invites them to drift.
export type { Rect } from './plan.js';

/** How near a dragged edge has to be, in blocks, before it snaps to a neighbour. */
export const EDGE_SNAP = 2;

/** How near a dropped door or window has to be to a wall before it jumps into it. */
export const WALL_SNAP = 3;

export interface Point {
  x: number;
  z: number;
}

/**
 * A run of wall, in plan space.
 *
 * `length` runs along `axis` and `thickness` across it, so an axis-`x` run covers
 * x…x+length-1 and z…z+thickness-1. `outward` is the side that faces away from the space the
 * run encloses — the direction a door in it would face by default.
 */
export interface WallRun {
  /** The item this run came from, so a hit on a wall can select the room that owns it. */
  ownerId: string;
  axis: PlanAxis;
  x: number;
  z: number;
  length: number;
  thickness: number;
  outward: Face;
}

export function rectFromPoints(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const z = Math.min(a.z, b.z);
  return {
    x,
    z,
    // Both ends inclusive: a drag from cell 3 to cell 3 is a 1×1 room, not a 0×0 one.
    w: Math.abs(b.x - a.x) + 1,
    d: Math.abs(b.z - a.z) + 1,
  };
}

export function rectRight(rect: Rect): number {
  return rect.x + rect.w;
}

export function rectBottom(rect: Rect): number {
  return rect.z + rect.d;
}

export function rectContains(rect: Rect, x: number, z: number): boolean {
  return x >= rect.x && x < rectRight(rect) && z >= rect.z && z < rectBottom(rect);
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < rectRight(b) && b.x < rectRight(a) && a.z < rectBottom(b) && b.z < rectBottom(a);
}

/** The rect two rects share, or null when they only touch or miss entirely. */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const z = Math.max(a.z, b.z);
  const w = Math.min(rectRight(a), rectRight(b)) - x;
  const d = Math.min(rectBottom(a), rectBottom(b)) - z;
  return w > 0 && d > 0 ? { x, z, w, d } : null;
}

/** Blocks the two rects share. Zero when they only touch or miss entirely. */
export function overlapArea(a: Rect, b: Rect): number {
  const shared = intersectRect(a, b);
  return shared ? shared.w * shared.d : 0;
}

/**
 * Is `inner` entirely within `outer`?
 *
 * Asked about rooms, where the answer decides whether an overlap is a mistake or a plan: a
 * room fully inside another is a service core, a vault, a stair enclosure — an entirely
 * ordinary thing to draw, and one that compiles correctly because the inner room's walls are
 * simply painted after the outer room's floor.
 */
export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.z >= outer.z &&
    rectRight(inner) <= rectRight(outer) &&
    rectBottom(inner) <= rectBottom(outer)
  );
}

export function clampRectToSite(rect: Rect, site: { x: number; z: number }): Rect {
  const w = Math.max(1, Math.min(rect.w, site.x));
  const d = Math.max(1, Math.min(rect.d, site.z));
  return {
    w,
    d,
    x: Math.max(0, Math.min(rect.x, site.x - w)),
    z: Math.max(0, Math.min(rect.z, site.z - d)),
  };
}

export function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const rect of rects) {
    x0 = Math.min(x0, rect.x);
    z0 = Math.min(z0, rect.z);
    x1 = Math.max(x1, rectRight(rect));
    z1 = Math.max(z1, rectBottom(rect));
  }
  return { x: x0, z: z0, w: x1 - x0, d: z1 - z0 };
}

/**
 * The plan-space footprint of any item.
 *
 * One function rather than a switch at every call site, because "what does this cover" is
 * asked by hit testing, by the bounds the compiler crops to, by validation and by the canvas
 * — and four copies of the same switch is four places to forget a new item kind.
 */
export function itemFootprint(item: PlanItem, wallThickness: number, storeyHeight: number): Rect {
  switch (item.kind) {
    case 'room':
    case 'opening':
    case 'platform':
      return item.rect;

    case 'wall':
      return item.axis === 'x'
        ? { x: item.x, z: item.z, w: item.length, d: wallThickness }
        : { x: item.x, z: item.z, w: wallThickness, d: item.length };

    case 'door': {
      const along = item.width;
      return item.facing === 'north' || item.facing === 'south'
        ? { x: item.x, z: item.z, w: along, d: wallThickness }
        : { x: item.x, z: item.z, w: wallThickness, d: along };
    }

    case 'window':
      return item.axis === 'x'
        ? { x: item.x, z: item.z, w: item.length, d: wallThickness }
        : { x: item.x, z: item.z, w: wallThickness, d: item.length };

    // A staircase covers the whole run it takes to climb a storey, which is the storey height
    // in blocks — not its width. It used to pass `width` as the number of steps, so a stair
    // drawn as a five-block run had a two-block hit box: you could see the whole flight and
    // only click its bottom step, and `planFootprint` had to special-case stairs to stop the
    // compiler cropping the top of one off.
    case 'stair':
      return stairFootprint(item.x, item.z, item.facing, item.width, storeyHeight);

    case 'column':
      return { x: item.x, z: item.z, w: item.size, d: item.size };

    case 'furnish':
      return furnishingFootprint(furnishingById(item.itemId), item.x, item.z, item.facing);

    // The footprint the plan remembers, not the library's. A placed build is drawn, selected
    // and dragged before its blocks have arrived over the network, and every one of those
    // needs a rectangle now. The catalogue's size supersedes it in the one place it matters —
    // compiling — where waiting for the fetch is the correct behaviour anyway.
    case 'place':
      return placeFootprint(item);
  }
}

/**
 * The plan-space run of a staircase.
 *
 * `steps` is the number of blocks it travels, which is the storey height — the run has to
 * climb a whole storey and each step climbs one block. The plan knows the storey, so callers
 * pass it in rather than this module reaching for it.
 */
export function stairFootprint(
  x: number,
  z: number,
  facing: Face,
  width: number,
  steps: number,
): Rect {
  const travel = Math.max(1, steps);
  switch (facing) {
    case 'south':
      return { x, z, w: width, d: travel };
    case 'north':
      return { x, z: z - travel + 1, w: width, d: travel };
    case 'east':
      return { x, z, w: travel, d: width };
    case 'west':
      return { x: x - travel + 1, z, w: travel, d: width };
  }
}

/**
 * What is under the cursor.
 *
 * Later items win, which matches the canvas's own draw order, and small items are considered
 * before large ones: a door sits inside a room's wall, so testing in plain z-order would
 * always select the room and a door could never be picked up again.
 */
export function hitTest(
  items: readonly PlanItem[],
  x: number,
  z: number,
  wallThickness: number,
  storeyHeight: number,
): PlanItem | null {
  const order: Record<PlanItem['kind'], number> = {
    door: 0,
    window: 0,
    furnish: 0,
    // With the furnishings: a placed build is a thing standing *in* the plan, so clicking one
    // must beat the room it stands in — but a door drawn on top of it still wins.
    place: 0,
    column: 1,
    stair: 2,
    opening: 3,
    platform: 3,
    wall: 4,
    room: 5,
  };

  let best: PlanItem | null = null;
  let bestRank = Infinity;

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (!rectContains(itemFootprint(item, wallThickness, storeyHeight), x, z)) continue;
    const rank = order[item.kind];
    if (rank < bestRank) {
      best = item;
      bestRank = rank;
    }
  }

  return best;
}

/**
 * Every wall run on a storey: room perimeters first, then free-standing partitions.
 *
 * This is the list doors and windows snap into and the list validation asks "is this aperture
 * actually in a wall". Deriving it rather than storing it is deliberate — a room's walls are
 * a consequence of its rect, and a stored copy would be wrong the moment the room is resized.
 */
export function wallRuns(items: readonly PlanItem[], thickness: number): WallRun[] {
  const runs: WallRun[] = [];

  for (const item of items) {
    if (item.kind === 'room') {
      runs.push(...roomWalls(item, thickness));
    } else if (item.kind === 'wall') {
      runs.push({
        ownerId: item.id,
        axis: item.axis,
        x: item.x,
        z: item.z,
        length: item.length,
        thickness,
        // A partition has no inside, so it takes the arbitrary-but-consistent choice; the
        // inspector can flip a door that came out facing the wrong way.
        outward: item.axis === 'x' ? 'south' : 'east',
      });
    }
  }

  return runs;
}

export function roomWalls(room: RoomItem, thickness: number): WallRun[] {
  const { rect, id } = room;
  const t = Math.min(thickness, Math.max(1, Math.floor(Math.min(rect.w, rect.d) / 2)) || 1);
  return [
    { ownerId: id, axis: 'x', x: rect.x, z: rect.z, length: rect.w, thickness: t, outward: 'north' },
    {
      ownerId: id,
      axis: 'x',
      x: rect.x,
      z: rectBottom(rect) - t,
      length: rect.w,
      thickness: t,
      outward: 'south',
    },
    { ownerId: id, axis: 'z', x: rect.x, z: rect.z, length: rect.d, thickness: t, outward: 'west' },
    {
      ownerId: id,
      axis: 'z',
      x: rectRight(rect) - t,
      z: rect.z,
      length: rect.d,
      thickness: t,
      outward: 'east',
    },
  ];
}

export function runFootprint(run: WallRun): Rect {
  return run.axis === 'x'
    ? { x: run.x, z: run.z, w: run.length, d: run.thickness }
    : { x: run.x, z: run.z, w: run.thickness, d: run.length };
}

/** Squared distance from a point to a rect, zero inside it. */
export function distanceToRect(rect: Rect, x: number, z: number): number {
  const cx = Math.max(rect.x, Math.min(rectRight(rect) - 1, x));
  const cz = Math.max(rect.z, Math.min(rectBottom(rect) - 1, z));
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz;
}

export interface AperturePlacement {
  x: number;
  z: number;
  axis: PlanAxis;
  /** Perpendicular to the wall, pointing out of the space it encloses. */
  facing: Face;
  run: WallRun;
}

/**
 * Drop a door or window into the nearest wall.
 *
 * The port of `wallInsertSnap`. Without it an aperture is placed wherever the pointer was,
 * which is almost never *in* a wall — and an aperture that is not in a wall is a hole in
 * mid-air that the compiler cheerfully builds. Snapping first means the common case needs no
 * correction at all, and the returned `run` lets the caller keep the aperture inside the
 * wall's ends rather than hanging off a corner.
 *
 * Returns null when nothing is near enough, which the page reports rather than silently
 * placing something the user will have to hunt for.
 */
export function snapAperture(
  runs: readonly WallRun[],
  x: number,
  z: number,
  span: number,
  maxDistance = WALL_SNAP,
): AperturePlacement | null {
  let best: WallRun | null = null;
  let bestDistance = Infinity;

  for (const run of runs) {
    const distance = distanceToRect(runFootprint(run), x, z);
    if (distance < bestDistance) {
      best = run;
      bestDistance = distance;
    }
  }

  if (!best || bestDistance > maxDistance * maxDistance) return null;

  // Keep the whole aperture inside the run: a two-block door hanging one block off the end of
  // a wall leaves a hole in the corner, which is never what was meant.
  const width = Math.max(1, Math.min(span, best.length));
  const along = best.axis === 'x' ? x : z;
  const start = best.axis === 'x' ? best.x : best.z;
  const clamped = Math.max(start, Math.min(start + best.length - width, along));

  return {
    x: best.axis === 'x' ? clamped : best.x,
    z: best.axis === 'x' ? best.z : clamped,
    axis: best.axis,
    facing: best.outward,
    run: best,
  };
}

/**
 * Nudge a room's edges onto its neighbours'.
 *
 * Two behaviours in one pass, both worth having and neither obvious to do by hand:
 *
 * - An edge within `EDGE_SNAP` of a neighbour's *far* edge overlaps it by the wall thickness,
 *   so the two rooms share a single wall. Drawn without this, adjacent rooms end up with two
 *   walls and a sealed cavity between them, which looks fine in plan and is obviously wrong
 *   the moment it is built.
 * - An edge within `EDGE_SNAP` of a neighbour's *same-side* edge lines up flush with it, so
 *   facades stay straight.
 *
 * The rect is moved, never resized, when `mode` is `'move'`; a draw or a resize adjusts the
 * edge that is being dragged. Both keep the result at least one block in each axis.
 */
export function snapRoomRect(
  rect: Rect,
  others: readonly Rect[],
  wallThickness: number,
  mode: 'draw' | 'move' = 'draw',
): Rect {
  const out = { ...rect };

  const snapAxis = (
    lowKey: 'x' | 'z',
    sizeKey: 'w' | 'd',
    otherLow: (r: Rect) => number,
    otherHigh: (r: Rect) => number,
  ) => {
    const low = out[lowKey];
    const high = out[lowKey] + out[sizeKey];

    let bestLow: number | null = null;
    let bestHigh: number | null = null;
    let bestLowDistance = EDGE_SNAP + 1;
    let bestHighDistance = EDGE_SNAP + 1;

    for (const other of others) {
      // Share a wall: this room's near edge sits `thickness` inside the neighbour's far edge.
      const candidatesLow = [otherHigh(other) - wallThickness, otherLow(other)];
      const candidatesHigh = [otherLow(other) + wallThickness, otherHigh(other)];

      for (const candidate of candidatesLow) {
        const distance = Math.abs(candidate - low);
        if (distance <= EDGE_SNAP && distance < bestLowDistance) {
          bestLow = candidate;
          bestLowDistance = distance;
        }
      }
      for (const candidate of candidatesHigh) {
        const distance = Math.abs(candidate - high);
        if (distance <= EDGE_SNAP && distance < bestHighDistance) {
          bestHigh = candidate;
          bestHighDistance = distance;
        }
      }
    }

    if (mode === 'move') {
      // Moving keeps the size, so only one edge can win — the nearer one.
      if (bestLow !== null && bestLowDistance <= bestHighDistance) out[lowKey] = bestLow;
      else if (bestHigh !== null) out[lowKey] = bestHigh - out[sizeKey];
      return;
    }

    // Drawing keeps the size too, unless *both* edges found a neighbour — in which case the
    // gap between them decides it, because a room dragged roughly into a slot between two
    // others is asking to fill that slot exactly.
    //
    // Snapping one edge and leaving the other where the pointer happened to be is what this
    // used to do, and it silently resized every room that touched a neighbour: four rooms
    // drawn as 6x6 in a two-by-two came out 6x6, 7x6, 6x7 and 7x7. The overlap that makes two
    // rooms share a wall is one block, so every snapped side grew by one — and nothing in the
    // drawing said so.
    if (bestLow !== null && bestHigh !== null) {
      out[lowKey] = bestLow;
      out[sizeKey] = Math.max(1, bestHigh - bestLow);
      return;
    }
    if (bestLow !== null) out[lowKey] = bestLow;
    else if (bestHigh !== null) out[lowKey] = bestHigh - out[sizeKey];
  };

  snapAxis('x', 'w', (r) => r.x, rectRight);
  snapAxis('z', 'd', (r) => r.z, rectBottom);

  return out;
}

/** A line drawn while dragging, to show what the thing being dragged has lined up with. */
export interface Guide {
  /** `x` for a vertical line at a constant x; `z` for a horizontal one. */
  axis: 'x' | 'z';
  at: number;
  /** The span the line covers, along the other axis — both rects plus the gap between them. */
  from: number;
  to: number;
}

/** How many guides one gesture may draw. Past this the drawing is a lattice, not a hint. */
const MAX_GUIDES = 6;

/**
 * Where the rectangle being dragged lines up with everything else on the storey.
 *
 * Exact equality rather than a tolerance, and that is not a shortcut: every coordinate in a
 * plan is a whole block and every gesture lands on one, so "nearly aligned" is not a state
 * this document can be in. A tolerance would draw a guide for a wall one block out and quietly
 * teach people that the guide means "close enough".
 *
 * The guides do not move anything. Rooms already snap to their neighbours in `snapRoomRect`,
 * which is what makes two rooms share a wall; this is the other half of that — it says what
 * the snap did, and it covers walls, platforms and voids, which do not snap at all and which
 * you therefore have to line up by eye.
 */
export function alignmentGuides(subject: Rect, others: readonly Rect[]): Guide[] {
  const found = new Map<string, Guide>();

  // / are the span along the *other* axis, so a vertical guide is measured in z.
  const consider = (axis: 'x' | 'z', at: number, lo: number, hi: number) => {
    const key = `${axis}:${at}`;
    const existing = found.get(key);
    if (existing) {
      existing.from = Math.min(existing.from, lo);
      existing.to = Math.max(existing.to, hi);
      return;
    }
    if (found.size >= MAX_GUIDES) return;
    found.set(key, { axis, at, from: lo, to: hi });
  };

  for (const other of others) {
    const xs: number[] = [subject.x, rectRight(subject)];
    const otherXs: number[] = [other.x, rectRight(other)];
    for (const a of xs) {
      for (const b of otherXs) {
        if (a !== b) continue;
        consider('x', a, Math.min(subject.z, other.z), Math.max(rectBottom(subject), rectBottom(other)));
      }
    }

    const zs: number[] = [subject.z, rectBottom(subject)];
    const otherZs: number[] = [other.z, rectBottom(other)];
    for (const a of zs) {
      for (const b of otherZs) {
        if (a !== b) continue;
        consider('z', a, Math.min(subject.x, other.x), Math.max(rectRight(subject), rectRight(other)));
      }
    }
  }

  return [...found.values()];
}

/** Every room rect on a storey, for snapping a drag against. */
export function roomRects(items: readonly PlanItem[], exceptId?: string): Rect[] {
  return items
    .filter((item): item is RoomItem => item.kind === 'room' && item.id !== exceptId)
    .map((item) => item.rect);
}

/** The footprint every storey's contents share — what the compiler crops the build to. */
export function planFootprint(plan: LayoutPlan): Rect | null {
  const rects: Rect[] = [];
  for (const floor of plan.floors) {
    for (const item of floor.items) {
      // No stair special case any more:  is told the storey height and gets
      // the whole run right, which is the only reason this needed one.
      rects.push(itemFootprint(item, plan.wallThickness, plan.storeyHeight));
    }
  }
  return unionRect(rects);
}

export function moveItem(item: PlanItem, dx: number, dz: number, site: { x: number; z: number }): PlanItem {
  if (item.kind === 'room' || item.kind === 'opening' || item.kind === 'platform') {
    return { ...item, rect: clampRectToSite({ ...item.rect, x: item.rect.x + dx, z: item.rect.z + dz }, site) };
  }
  return {
    ...item,
    x: Math.max(0, Math.min(site.x - 1, item.x + dx)),
    z: Math.max(0, Math.min(site.z - 1, item.z + dz)),
  };
}
