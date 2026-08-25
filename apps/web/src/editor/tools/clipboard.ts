/**
 * Copy, transform and stamp a region — the difference between decorating one window and
 * decorating a facade.
 *
 * A clip is a standalone little grid with its *own* palette of block refs rather than
 * indices into the grid it came from. That is what lets it survive the two things that
 * would otherwise break it: being pasted into a build whose palette is numbered completely
 * differently, and being rotated, which has to rewrite `facing=north` into `facing=east`
 * on the ref itself. Indices cannot be rotated; refs can.
 *
 * Rotation is 90° clockwise around Y, matching `rotate()` in the registry so the geometry
 * and the block states turn the same way. Getting those out of step is the classic voxel
 * editor bug: the staircase moves to the right wall and keeps facing the old one.
 */

import {
  AIR_BLOCK,
  AIR_INDEX,
  canonical,
  mirror,
  rotate,
  voxelIndex,
  type BlockRef,
  type EditOp,
  type VoxelGrid,
} from '@craftmagic/core';
import { boxBounds, type BoxCorner } from './boxSelect.js';
import type { Cell } from './brush.js';
import { EditBuilder } from './op.js';

export interface Clip {
  size: { x: number; y: number; z: number };
  /** Slot 0 is always air, so an empty cell needs no special case anywhere below. */
  palette: string[];
  voxels: Uint16Array;
  /** Non-air cells, counted once at copy time — the HUD shows it and stamping re-uses it. */
  blocks: number;
}

/**
 * Ceiling on a clip, in cells.
 *
 * A clip is held in memory for as long as the session lasts and is copied again by every
 * rotation, so this is a standing cost rather than a transient one. Two million cells is a
 * 128×128×128 region — far more than any decoration worth stamping — at 4 MB.
 */
export const MAX_CLIP_CELLS = 2_000_000;

export class ClipTooLargeError extends Error {
  constructor(readonly cells: number) {
    super(
      `That region is ${cells.toLocaleString()} cells — the clipboard holds ${MAX_CLIP_CELLS.toLocaleString()}.`,
    );
    this.name = 'ClipTooLargeError';
  }
}

/** Lift a box out of the grid. The grid is not modified — cut is copy plus a box clear. */
export function copyRegion(grid: VoxelGrid, a: BoxCorner, b: BoxCorner): Clip {
  const { min, max, cells } = boxBounds(grid, a, b);
  if (cells > MAX_CLIP_CELLS) throw new ClipTooLargeError(cells);

  const size = { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };
  const voxels = new Uint16Array(size.x * size.y * size.z);
  const palette: string[] = [AIR_BLOCK];
  // Source slot -> clip slot. The source palette may hold entries this region never uses,
  // and carrying them would make every rotation rewrite refs nothing references.
  const remap = new Map<number, number>();
  let blocks = 0;

  let out = 0;
  for (let y = 0; y < size.y; y++) {
    for (let z = 0; z < size.z; z++) {
      for (let x = 0; x < size.x; x++, out++) {
        const source = grid.voxels[voxelIndex(grid.size, min.x + x, min.y + y, min.z + z)] ?? AIR_INDEX;
        if (source === AIR_INDEX) continue;

        let slot = remap.get(source);
        if (slot === undefined) {
          slot = palette.length;
          palette.push(canonical(grid.palette[source] ?? AIR_BLOCK));
          remap.set(source, slot);
        }
        voxels[out] = slot;
        blocks++;
      }
    }
  }

  return { size, palette, voxels, blocks };
}

/** 90° clockwise around Y, `times` times. Geometry and block states turn together. */
export function rotateClip(clip: Clip, times = 1): Clip {
  const steps = ((Math.round(times) % 4) + 4) % 4;
  if (steps === 0) return clip;

  let out = clip;
  for (let i = 0; i < steps; i++) out = rotateOnce(out);
  return out;
}

function rotateOnce(clip: Clip): Clip {
  const size = { x: clip.size.z, y: clip.size.y, z: clip.size.x };
  const voxels = new Uint16Array(voxelCount(size));

  for (let y = 0; y < clip.size.y; y++) {
    for (let z = 0; z < clip.size.z; z++) {
      for (let x = 0; x < clip.size.x; x++) {
        const value = clip.voxels[voxelIndex(clip.size, x, y, z)] ?? AIR_INDEX;
        if (value === AIR_INDEX) continue;
        // north(0,-1) becomes east(1,0), i.e. (x,z) -> (-z,x); shifted back into the box by
        // the new width. Any other sign convention here would rotate the shape one way and
        // the stairs the other.
        voxels[voxelIndex(size, size.x - 1 - z, y, x)] = value;
      }
    }
  }

  return {
    size,
    palette: clip.palette.map((ref, index) => (index === AIR_INDEX ? ref : rotate(ref, 1))),
    voxels,
    blocks: clip.blocks,
  };
}

/** Mirror across the plane perpendicular to `axis`. */
export function mirrorClip(clip: Clip, axis: 'x' | 'z'): Clip {
  const voxels = new Uint16Array(clip.voxels.length);

  for (let y = 0; y < clip.size.y; y++) {
    for (let z = 0; z < clip.size.z; z++) {
      for (let x = 0; x < clip.size.x; x++) {
        const value = clip.voxels[voxelIndex(clip.size, x, y, z)] ?? AIR_INDEX;
        if (value === AIR_INDEX) continue;
        const tx = axis === 'x' ? clip.size.x - 1 - x : x;
        const tz = axis === 'z' ? clip.size.z - 1 - z : z;
        voxels[voxelIndex(clip.size, tx, y, tz)] = value;
      }
    }
  }

  return {
    size: clip.size,
    palette: clip.palette.map((ref, index) => (index === AIR_INDEX ? ref : mirror(ref, axis))),
    voxels,
    blocks: clip.blocks,
  };
}

export type StampMode =
  /** Air in the clip leaves the destination alone: stamp a window into a wall. */
  | 'merge'
  /** Air in the clip erases: stamp the region exactly as it was copied, hole and all. */
  | 'replace';

export interface StampResult {
  op: EditOp | null;
  cells: number;
  /** True when the destination palette filled up and part of the clip could not be written. */
  truncated: boolean;
}

/** The box a stamp at `at` would occupy — the ghost outline reads this. */
export function stampBounds(clip: Clip, at: Cell): { min: Cell; max: Cell } {
  return {
    min: { x: at.x, y: at.y, z: at.z },
    max: { x: at.x + clip.size.x - 1, y: at.y + clip.size.y - 1, z: at.z + clip.size.z - 1 },
  };
}

/**
 * Write a clip into the grid with its minimum corner at `at`.
 *
 * `resolve` maps a block ref to a slot in the destination palette, appending one if needed —
 * the same callback the tools use, so a stamp of spruce into an oak build grows the palette
 * exactly once per new block. Cells that fall outside the grid are dropped rather than
 * wrapped: a stamp near the edge should be clipped, not scattered across the far wall.
 */
export function stampEdit(
  grid: VoxelGrid,
  clip: Clip,
  at: Cell,
  resolve: (ref: BlockRef) => number,
  mode: StampMode = 'merge',
): StampResult {
  const builder = new EditBuilder(grid, Math.min(clip.voxels.length, 1 << 16));
  const { size } = grid;
  // Resolved lazily and once per clip slot: `resolve` may grow the destination palette, and
  // asking it per cell would turn a linear scan into a per-voxel one.
  const slots = new Map<number, number>();
  let truncated = false;

  for (let y = 0; y < clip.size.y; y++) {
    const ty = at.y + y;
    if (ty < 0 || ty >= size.y) continue;
    for (let z = 0; z < clip.size.z; z++) {
      const tz = at.z + z;
      if (tz < 0 || tz >= size.z) continue;
      for (let x = 0; x < clip.size.x; x++) {
        const tx = at.x + x;
        if (tx < 0 || tx >= size.x) continue;

        const source = clip.voxels[voxelIndex(clip.size, x, y, z)] ?? AIR_INDEX;
        if (source === AIR_INDEX) {
          if (mode === 'replace') builder.set(voxelIndex(size, tx, ty, tz), AIR_INDEX);
          continue;
        }

        let slot = slots.get(source);
        if (slot === undefined) {
          slot = resolve(clip.palette[source] ?? AIR_BLOCK);
          slots.set(source, slot);
        }
        if (slot < 0) {
          truncated = true;
          continue;
        }
        builder.set(voxelIndex(size, tx, ty, tz), slot);
      }
    }
  }

  return { op: builder.build(), cells: builder.size, truncated };
}

function voxelCount(size: { x: number; y: number; z: number }): number {
  return size.x * size.y * size.z;
}
