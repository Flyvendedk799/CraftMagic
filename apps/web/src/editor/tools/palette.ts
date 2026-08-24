/**
 * Palette growth.
 *
 * An expanded grid's palette holds exactly the blocks its program used, so the first time a
 * user places anything else there is no slot for it. Growing the palette rather than
 * rewriting voxels is the cheap direction: one string appended versus a pass over the grid.
 *
 * This is the one place in the editing path that mutates something other than voxels, which
 * is why it lives apart from the tools — the tools stay pure, the caller grows the palette
 * first and hands the resulting index in. The caller also has to regenerate the mesher's
 * `paletteColors`/`paletteFlags` afterwards; `grew` is the signal for that.
 */

import { canonical, type BlockRef, type VoxelGrid } from '@craftmagic/core';

/** Voxels are `Uint16Array`, so slot 65535 is the last addressable one. */
export const MAX_PALETTE = 65536;

export interface PaletteResolution {
  /** Slot for the block, or -1 if the palette is full. */
  index: number;
  /** True when a slot was appended, i.e. the colour/flag arrays are now stale. */
  grew: boolean;
}

/**
 * Slot for `block`, appending one if it is not already there.
 *
 * Canonicalised first, so `oak_stairs` and `oak_stairs[facing=north,half=bottom,…]` — the
 * same state written two ways — reuse one slot instead of quietly doubling the palette
 * every time the block picker and the expander spell a block differently.
 *
 * The lookup is a linear scan. Palettes are program-sized (the cottage has ten entries) and
 * this runs once per click, so an index would cost more to keep in sync than it saves.
 */
export function resolvePaletteIndex(grid: VoxelGrid, block: BlockRef): PaletteResolution {
  const ref = canonical(block);

  for (let i = 0; i < grid.palette.length; i++) {
    if (grid.palette[i] === ref) return { index: i, grew: false };
  }

  if (grid.palette.length >= MAX_PALETTE) return { index: -1, grew: false };

  grid.palette.push(ref);
  return { index: grid.palette.length - 1, grew: true };
}
