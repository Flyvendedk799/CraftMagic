/**
 * Whole-build substitutions.
 *
 * Both of these edit by palette slot rather than by position, which is why they are one
 * `EditOp` over a single pass of the grid instead of a tool the user has to drag over a
 * building. Rewriting `grid.palette[i]` in place would be cheaper still — one string — but
 * it would be invisible to the undo stack and to the chunk mesher, so the swap is expressed
 * as voxel changes like every other edit.
 *
 * `swapFamily` is the reason the registry's `familySwap` exists: it maps a block to its
 * counterpart in another family by *category*, so oak stairs become spruce stairs and oak
 * planks become spruce planks without anyone enumerating the pairs. The source family is an
 * explicit argument rather than inferred, because `familySwap` alone would happily rewrite a
 * cobblestone wall into a spruce fence — it matches on category, and category is shared far
 * more widely than intent.
 */

import {
  familySwap,
  getBlock,
  parseBlockRef,
  type BlockRef,
  type EditOp,
  type VoxelGrid,
} from '@imaginecraft/core';
import { EditBuilder } from './op.js';

/** Resolves a block ref to a palette slot, growing the palette if needed. -1 if it cannot. */
export type ResolveBlock = (block: BlockRef) => number;

/** Every voxel in slot `from` becomes slot `to`. */
export function swapPaletteIndex(grid: VoxelGrid, from: number, to: number): EditOp | null {
  if (from === to || from < 0 || to < 0) return null;

  const { voxels } = grid;
  const builder = new EditBuilder(grid, 4096);
  for (let i = 0; i < voxels.length; i++) {
    if (voxels[i] === from) builder.set(i, to);
  }
  return builder.build();
}

/**
 * Re-skin one family into another across the whole build.
 *
 * `resolve` is a callback because appending to the palette is a mutation and the tools are
 * otherwise pure; the caller owns that side effect and knows it has to regenerate the
 * mesher's colour arrays afterwards. Every resolve happens before the voxel pass, so the
 * palette cannot grow underneath the scan.
 */
export function swapFamily(
  grid: VoxelGrid,
  sourceFamily: string,
  targetFamily: string,
  resolve: ResolveBlock,
): EditOp | null {
  if (sourceFamily === targetFamily) return null;

  // -1 means "leave alone", which covers air, other families, and blocks whose category has
  // no counterpart in the target family (a birch door swapped to `stone_brick`, say).
  const slots = grid.palette.length;
  const remap = new Int32Array(slots).fill(-1);
  let any = false;

  // `slots` is snapshotted because `resolve` appends: iterating the live length would walk
  // into the entries this loop just created.
  for (let i = 1; i < slots; i++) {
    const ref = grid.palette[i]!;
    if (familyOf(ref) !== sourceFamily) continue;

    const swapped = familySwap(ref, targetFamily);
    if (swapped === ref) continue;

    const index = resolve(swapped);
    if (index < 0 || index === i) continue;
    remap[i] = index;
    any = true;
  }

  if (!any) return null;

  const { voxels } = grid;
  const builder = new EditBuilder(grid, 4096);
  for (let i = 0; i < voxels.length; i++) {
    const to = remap[voxels[i]!]!;
    if (to >= 0) builder.set(i, to);
  }
  return builder.build();
}

/**
 * The registry family of a palette slot, or null for air and unknown blocks.
 *
 * The parse is not optional: `getBlock` takes a bare id, and a palette entry is a full
 * blockstate string. Handing it `minecraft:oak_stairs[facing=north,…]` returns undefined,
 * which silently excludes every stateful block from a family swap — exactly the blocks a
 * re-skin most needs to catch.
 */
export function familyOf(ref: BlockRef): string | null {
  return getBlock(parseBlockRef(ref).id)?.family ?? null;
}
