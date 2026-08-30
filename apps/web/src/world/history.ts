/**
 * Undo over terrain strokes, as deltas.
 *
 * The editor's `EditHistory` makes the same argument about voxels that this file makes about
 * columns, and for a sharper reason: a 1024² heightfield is 3 MB, so snapshotting one per
 * stroke would spend a gigabyte to remember three hundred brush dabs. A stroke instead
 * records only the columns it actually touched — eight bytes each — which makes a small brush
 * cost almost nothing and a map-wide flatten cost what it genuinely is.
 *
 * The other three edit kinds a world has are different enough in shape that folding them into
 * one entry type would mean a struct where most fields are null. They share a discriminator
 * instead, and `WorldHistory` stays ignorant of how any of them are applied — `useWorldSession`
 * owns that, exactly as `VoxelWorld` owns applying an `EditOp`.
 *
 * The two ceilings are the editor's, for the editor's reason: a depth limit alone cannot bound
 * memory when one entry may be the whole map, and a byte limit alone lets ten thousand small
 * dabs turn every undo into a linear walk. Whichever binds first wins.
 */

import type { Overlay, WorldPlacement } from '@craftmagic/core';

/** Deep enough that undo feels unlimited while sculpting. */
export const MAX_ENTRIES = 120;

/** Payload ceiling for the whole stack. */
export const MAX_BYTES = 48 * 1024 * 1024;

/**
 * A terrain stroke: the columns it touched, and both sides of each.
 *
 * Heights and strata travel together even when a stroke only changed one of them. A Terrainer
 * dab writes strata and leaves heights alone, and storing the untouched half costs two bytes
 * per column — against a branch at every apply site, and an entry whose meaning depends on
 * which of its arrays happen to be present. The bytes are cheaper than the ambiguity.
 */
export interface TerrainDelta {
  kind: 'terrain';
  columns: Uint32Array;
  beforeHeight: Int16Array;
  afterHeight: Int16Array;
  beforeStratum: Uint8Array;
  afterStratum: Uint8Array;
}

/**
 * A carve stroke, as whole overlay chunks.
 *
 * Cell-level deltas would be the consistent choice and are the wrong one here: a carve writes
 * dense runs through a handful of 16³ chunks, and a chunk that is entirely air encodes to a
 * few bytes under the RLE. Recording "these six chunks looked like this" is both smaller than
 * the cells it stands for and immune to the ordering questions a cell delta raises when two
 * strokes overlap. `null` means the chunk did not exist, which restores to deletion.
 */
export interface CarveDelta {
  kind: 'carve';
  before: Overlay;
  after: Overlay;
  /** Keys touched, including ones that only exist on one side. */
  keys: string[];
}

/** Placements are small and few; there is nothing to gain from a finer delta than the list. */
export interface PlacementDelta {
  kind: 'placements';
  before: WorldPlacement[];
  after: WorldPlacement[];
}

/**
 * A settings change — resize, sea level, region size.
 *
 * A resize rewrites the whole heightfield, so this one carries snapshots and is honest about
 * it. They are rare, they are the edits most worth being able to take back, and a 3 MB entry
 * for an operation the user performs twice a session is a bargain.
 */
export interface WorldSnapshot {
  kind: 'snapshot';
  before: unknown;
  after: unknown;
  bytes: number;
}

export type WorldDelta = TerrainDelta | CarveDelta | PlacementDelta | WorldSnapshot;

function costOf(delta: WorldDelta): number {
  switch (delta.kind) {
    case 'terrain':
      return (
        delta.columns.byteLength +
        delta.beforeHeight.byteLength + delta.afterHeight.byteLength +
        delta.beforeStratum.byteLength + delta.afterStratum.byteLength
      );
    case 'carve':
      // The encoded blobs are the payload; the keys and palettes round to noise beside them.
      return overlayBytes(delta.before) + overlayBytes(delta.after) + delta.keys.length * 16;
    case 'placements':
      // Denormalised name and footprint included, a placement is on the order of 100 bytes.
      return (delta.before.length + delta.after.length) * 128;
    case 'snapshot':
      return delta.bytes;
  }
}

function overlayBytes(overlay: Overlay): number {
  let total = 0;
  for (const key in overlay) {
    const chunk = overlay[key];
    if (chunk) total += chunk.data.length + chunk.palette.length * 24;
  }
  return total;
}

export interface WorldHistoryLimits {
  maxEntries?: number;
  maxBytes?: number;
}

export class WorldHistory {
  /** Oldest first. Entries below `cursor` are applied; from it up is the redo tail. */
  private readonly entries: WorldDelta[] = [];
  /** Byte cost parallel to `entries`, so eviction is not an O(depth) re-measure. */
  private readonly costs: number[] = [];

  private cursor = 0;
  private total = 0;

  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(limits: WorldHistoryLimits = {}) {
    this.maxEntries = Math.max(1, limits.maxEntries ?? MAX_ENTRIES);
    this.maxBytes = Math.max(1, limits.maxBytes ?? MAX_BYTES);
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.entries.length;
  }

  get depth(): number {
    return this.entries.length;
  }

  get bytes(): number {
    return this.total;
  }

  /**
   * Record a completed edit.
   *
   * Pushing discards the redo tail, which is the ordinary rule, and an empty terrain delta is
   * dropped rather than stored: a stroke that landed entirely off the map would otherwise
   * become an undo the user has to press twice for, once for the stroke they saw and once for
   * the one they did not.
   */
  push(delta: WorldDelta): void {
    if (delta.kind === 'terrain' && delta.columns.length === 0) return;
    if (delta.kind === 'carve' && delta.keys.length === 0) return;

    while (this.entries.length > this.cursor) {
      this.total -= this.costs.pop()!;
      this.entries.pop();
    }

    this.entries.push(delta);
    this.costs.push(costOf(delta));
    this.total += this.costs[this.costs.length - 1]!;
    this.cursor = this.entries.length;

    this.evict();
  }

  /** The entry to reverse, or null. The caller applies it and the cursor has already moved. */
  undo(): WorldDelta | null {
    if (!this.canUndo) return null;
    this.cursor--;
    return this.entries[this.cursor] ?? null;
  }

  /** The entry to re-apply, or null. */
  redo(): WorldDelta | null {
    if (!this.canRedo) return null;
    const entry = this.entries[this.cursor] ?? null;
    this.cursor++;
    return entry;
  }

  clear(): void {
    this.entries.length = 0;
    this.costs.length = 0;
    this.cursor = 0;
    this.total = 0;
  }

  /**
   * Drop the oldest entries until both ceilings hold.
   *
   * Evicting from the bottom moves the cursor with it — the entries below it are the applied
   * ones, and forgetting one means the stack is shorter, not that the document changed.
   */
  private evict(): void {
    while (
      this.entries.length > 0 &&
      (this.entries.length > this.maxEntries || this.total > this.maxBytes)
    ) {
      this.total -= this.costs.shift()!;
      this.entries.shift();
      if (this.cursor > 0) this.cursor--;
    }
  }
}
