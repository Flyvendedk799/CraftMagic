/**
 * Recording a terrain drag so it can be undone as one thing.
 *
 * Two requirements pull against each other. A hill has to appear *while* you drag — you
 * cannot sculpt a shape you cannot see, and Architecture mode's rule of previewing the drag
 * and committing on release is the same instinct — but the whole drag has to be one undo, not
 * the four hundred dabs it is made of.
 *
 * So the tools write into the live terrain immediately, and this collects the *original* value
 * of every column they touch. The word original is doing the work: a brush dragged in a circle
 * crosses its own path constantly, and remembering the value from the most recent visit would
 * make undo restore a half-raised hill from the middle of the stroke rather than the ground
 * that was there before it started. First touch wins, and later touches are ignored.
 *
 * The finished stroke is a `TerrainDelta` over exactly the touched columns — eight bytes each,
 * against the 3 MB a snapshot of a 1024² heightfield would cost.
 */

import type { Terrain } from '@craftmagic/core';
import type { TerrainDelta } from './history.js';

/**
 * Height and stratum packed into one number, so the ledger is one `Map` rather than two.
 *
 * Heights are signed and run to -64; biasing by 32768 keeps the packed value positive so the
 * shift below does not have to reason about sign extension.
 */
const HEIGHT_BIAS = 32768;

function pack(height: number, stratum: number): number {
  return (height + HEIGHT_BIAS) | (stratum << 17);
}

function unpackHeight(value: number): number {
  return (value & 0x1ffff) - HEIGHT_BIAS;
}

function unpackStratum(value: number): number {
  return value >>> 17;
}

export class TerrainStroke {
  /** Column index → its value at first touch. Insertion order is the order columns are emitted. */
  private readonly origin = new Map<number, number>();

  get touched(): number {
    return this.origin.size;
  }

  /**
   * Note a column about to change.
   *
   * Call this *before* writing. The `has` check is what makes re-crossing free, and it is the
   * hot path of every drag — a 32-block brush is 3,200 columns per dab.
   */
  note(terrain: Terrain, index: number): void {
    if (this.origin.has(index)) return;
    this.origin.set(index, pack(terrain.height[index] ?? 0, terrain.strata[index] ?? 0));
  }

  /** Note every column of a disc without needing the tool to thread the recorder through. */
  noteAll(terrain: Terrain, indices: Iterable<number>): void {
    for (const index of indices) this.note(terrain, index);
  }

  /**
   * Close the stroke against the terrain as it now stands.
   *
   * Columns whose value came back to where it started are dropped: a raise-then-lower that
   * nets to nothing should not survive as an entry, and at the edges of a smooth brush a
   * great many columns round to no change at all.
   */
  finish(terrain: Terrain): TerrainDelta {
    const columns: number[] = [];
    const beforeHeight: number[] = [];
    const afterHeight: number[] = [];
    const beforeStratum: number[] = [];
    const afterStratum: number[] = [];

    for (const [index, packed] of this.origin) {
      const wasHeight = unpackHeight(packed);
      const wasStratum = unpackStratum(packed);
      const isHeight = terrain.height[index] ?? 0;
      const isStratum = terrain.strata[index] ?? 0;
      if (wasHeight === isHeight && wasStratum === isStratum) continue;
      columns.push(index);
      beforeHeight.push(wasHeight);
      afterHeight.push(isHeight);
      beforeStratum.push(wasStratum);
      afterStratum.push(isStratum);
    }

    return {
      kind: 'terrain',
      columns: Uint32Array.from(columns),
      beforeHeight: Int16Array.from(beforeHeight),
      afterHeight: Int16Array.from(afterHeight),
      beforeStratum: Uint8Array.from(beforeStratum),
      afterStratum: Uint8Array.from(afterStratum),
    };
  }
}

/** Write one side of a terrain delta back. `side` picks undo from redo. */
export function applyTerrainDelta(terrain: Terrain, delta: TerrainDelta, side: 'before' | 'after'): void {
  const heights = side === 'before' ? delta.beforeHeight : delta.afterHeight;
  const strata = side === 'before' ? delta.beforeStratum : delta.afterStratum;
  for (let i = 0; i < delta.columns.length; i++) {
    const index = delta.columns[i]!;
    if (index >= terrain.height.length) continue;
    terrain.height[index] = heights[i]!;
    terrain.strata[index] = strata[i]!;
  }
}

/**
 * The columns a drag passed through between two samples.
 *
 * A pointer at 60 Hz moving quickly reports positions tens of blocks apart, and a brush
 * stamped only at those positions paints a dotted line. Bresenham between the samples is what
 * turns the dots back into a stroke. The editor's own stroke path has this same gap; here it
 * is not survivable, because a terrain brush is the one tool whose whole purpose is the drag.
 */
export function interpolate(
  x0: number, z0: number, x1: number, z1: number,
  visit: (x: number, z: number) => void,
): void {
  let x = Math.round(x0);
  let z = Math.round(z0);
  const tx = Math.round(x1);
  const tz = Math.round(z1);

  const dx = Math.abs(tx - x);
  const dz = -Math.abs(tz - z);
  const sx = x < tx ? 1 : -1;
  const sz = z < tz ? 1 : -1;
  let error = dx + dz;

  // Bounded rather than trusted: a NaN coordinate from a malformed pointer event would
  // otherwise spin here forever, and a frozen tab is a much worse bug than a dropped dab.
  for (let guard = 0; guard < 4096; guard++) {
    visit(x, z);
    if (x === tx && z === tz) return;
    const doubled = error * 2;
    if (doubled >= dz) {
      error += dz;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      z += sz;
    }
  }
}
