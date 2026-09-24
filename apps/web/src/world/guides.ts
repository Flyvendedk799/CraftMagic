/**
 * How a placement sits relative to the rest of the map.
 *
 * The inspector used to show a footprint and nothing about the gap to the next building, and
 * a door had no way onto a road except painting the path by hand.
 */

import type { WorldDoc, WorldPlacement } from '@craftmagic/core';
import { placementFootprint } from './toolset.js';

export interface Spacing {
  blocks: number;
  name: string;
}

/** Edge gap to the nearest other placement, in blocks. Overlap is zero. */
export function spacingToNearest(doc: WorldDoc, placement: WorldPlacement): Spacing | null {
  const a = placementFootprint(placement);
  let best: Spacing | null = null;
  for (const other of doc.placements) {
    if (other.id === placement.id) continue;
    const b = placementFootprint(other);
    const dx = a.x + a.w <= b.x ? b.x - (a.x + a.w) : b.x + b.w <= a.x ? a.x - (b.x + b.w) : 0;
    const dz = a.z + a.d <= b.z ? b.z - (a.z + a.d) : b.z + b.d <= a.z ? a.z - (b.z + b.d) : 0;
    const blocks = dx === 0 && dz === 0 ? 0 : dx > 0 && dz > 0 ? Math.hypot(dx, dz) : dx + dz;
    const rounded = Math.round(blocks);
    if (!best || rounded < best.blocks) best = { blocks: rounded, name: other.name || 'another build' };
  }
  return best;
}

/**
 * Columns from the middle of the placement's near edge to the nearest path cell.
 *
 * The near edge is the south side of the turned footprint — the side a door drawn on the
 * plan's bottom edge lands on. The search is a square around that point, not the whole map.
 */
export function pathToRoad(doc: WorldDoc, placement: WorldPlacement): Array<{ x: number; z: number }> {
  const box = placementFootprint(placement);
  const door = { x: box.x + Math.floor(box.w / 2), z: box.z + box.d };
  const path = doc.settings.strata.findIndex((entry) => entry.id === 'path');
  if (path < 0) return [door];

  const { size } = doc.settings;
  let target: { x: number; z: number } | null = null;
  let best = Infinity;
  const reach = 48;
  for (let z = door.z - reach; z <= door.z + reach; z++) {
    if (z < 0 || z >= size.z) continue;
    for (let x = door.x - reach; x <= door.x + reach; x++) {
      if (x < 0 || x >= size.x) continue;
      if ((doc.terrain.strata[z * size.x + x] ?? 0) !== path) continue;
      const dist = (x - door.x) ** 2 + (z - door.z) ** 2;
      if (dist < best) {
        best = dist;
        target = { x, z };
      }
    }
  }
  const end = target ?? { x: door.x, z: Math.min(size.z - 1, door.z + 8) };
  return line(door, end);
}

function line(from: { x: number; z: number }, to: { x: number; z: number }): Array<{ x: number; z: number }> {
  const cells: Array<{ x: number; z: number }> = [];
  let x = from.x;
  let z = from.z;
  const dx = Math.abs(to.x - from.x);
  const dz = Math.abs(to.z - from.z);
  const sx = from.x < to.x ? 1 : -1;
  const sz = from.z < to.z ? 1 : -1;
  let err = dx - dz;
  for (;;) {
    cells.push({ x, z });
    if (x === to.x && z === to.z) break;
    const e2 = 2 * err;
    if (e2 > -dz) {
      err -= dz;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      z += sz;
    }
  }
  return cells;
}
