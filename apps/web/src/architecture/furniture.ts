/**
 * The furnishing catalogue: interior pieces a plan can place.
 *
 * A furnishing is a tiny recipe — one to three blocks with their states — authored once for a
 * south-facing piece and rotated into the other three facings with the same registry
 * machinery the editor's clipboard uses, so a chair's stair block and its footprint always
 * turn together. The compiler emits these as the program's `details` ops (raw voxel patches,
 * painted last), which is exactly what details exist for: singular, placed things that no
 * parametric component describes.
 *
 * The catalogue leans on what the block registry actually contains — there are no bed or
 * chest blocks in it — so every piece here is buildable vanilla furniture-language: a stair
 * is a chair, a fence under a trapdoor is a table, wool is bedding. That is not a workaround;
 * it is how furniture is built in the game.
 */

import { rotate, type BlockRef, type Face } from '@craftmagic/core';
import type { Rect } from './plan.js';

export interface FurnishingCell {
  /** Offsets within the footprint, south-facing: dx east, dy up, dz south. */
  dx: number;
  dy: number;
  dz: number;
  block: BlockRef;
}

export interface Furnishing {
  id: string;
  label: string;
  /** Footprint at facing 'south'. */
  w: number;
  d: number;
  cells: FurnishingCell[];
}

export const FURNISHINGS: Furnishing[] = [
  {
    id: 'chair',
    label: 'Chair',
    w: 1,
    d: 1,
    cells: [{ dx: 0, dy: 0, dz: 0, block: 'minecraft:oak_stairs[facing=south]' }],
  },
  {
    id: 'table',
    label: 'Table',
    w: 1,
    d: 1,
    cells: [
      { dx: 0, dy: 0, dz: 0, block: 'minecraft:oak_fence' },
      { dx: 0, dy: 1, dz: 0, block: 'minecraft:oak_trapdoor[half=top]' },
    ],
  },
  {
    id: 'bench',
    label: 'Bench',
    w: 2,
    d: 1,
    cells: [
      { dx: 0, dy: 0, dz: 0, block: 'minecraft:oak_slab' },
      { dx: 1, dy: 0, dz: 0, block: 'minecraft:oak_slab' },
    ],
  },
  {
    id: 'bed',
    label: 'Bed',
    w: 1,
    d: 2,
    cells: [
      // Pillow at the head (north end when facing south), blanket at the foot.
      { dx: 0, dy: 0, dz: 0, block: 'minecraft:white_wool' },
      { dx: 0, dy: 0, dz: 1, block: 'minecraft:red_wool' },
    ],
  },
  {
    id: 'bookshelf',
    label: 'Bookshelf',
    w: 1,
    d: 1,
    cells: [{ dx: 0, dy: 0, dz: 0, block: 'minecraft:bookshelf' }],
  },
  {
    id: 'barrel',
    label: 'Barrel',
    w: 1,
    d: 1,
    cells: [{ dx: 0, dy: 0, dz: 0, block: 'minecraft:barrel' }],
  },
  {
    id: 'workbench',
    label: 'Workbench',
    w: 1,
    d: 1,
    cells: [{ dx: 0, dy: 0, dz: 0, block: 'minecraft:crafting_table' }],
  },
  {
    id: 'furnace',
    label: 'Furnace',
    w: 1,
    d: 1,
    cells: [{ dx: 0, dy: 0, dz: 0, block: 'minecraft:furnace[facing=south]' }],
  },
  {
    id: 'lantern',
    label: 'Lantern',
    w: 1,
    d: 1,
    cells: [{ dx: 0, dy: 0, dz: 0, block: 'minecraft:lantern' }],
  },
];

export function furnishingById(id: string): Furnishing {
  return FURNISHINGS.find((piece) => piece.id === id) ?? FURNISHINGS[0]!;
}

/** Quarter-turns from the authored south facing, matching `registry.rotate`'s direction. */
const TURNS: Record<Face, number> = { south: 0, west: 1, north: 2, east: 3 };

/** The plan-space footprint of a piece at a position and facing. */
export function furnishingFootprint(piece: Furnishing, x: number, z: number, facing: Face): Rect {
  const swapped = TURNS[facing] % 2 === 1;
  return { x, z, w: swapped ? piece.d : piece.w, d: swapped ? piece.w : piece.d };
}

export interface PlacedCell {
  x: number;
  y: number;
  z: number;
  block: BlockRef;
}

/**
 * The piece's blocks at a position and facing, in plan coordinates (y relative to the
 * walking surface). Offsets and blockstates rotate together — the same quarter-turn count
 * goes to the footprint transform and to `registry.rotate`, which is what keeps a chair's
 * seat facing the way the plan's arrow points.
 */
export function furnishingCells(piece: Furnishing, x: number, z: number, facing: Face): PlacedCell[] {
  const turns = TURNS[facing];
  return piece.cells.map((cell) => {
    let dx = cell.dx;
    let dz = cell.dz;
    let w = piece.w;
    let d = piece.d;
    for (let i = 0; i < turns; i++) {
      // One quarter-turn, byte-for-byte the clipboard's `rotateOnce`: (dx, dz) → (d-1-dz, dx),
      // footprint (w, d) → (d, w). Sharing the convention is what keeps a chair's seat facing
      // the way the plan's arrow points — any other sign here rotates the shape one way and
      // the stair block the other.
      [dx, dz] = [d - 1 - dz, dx];
      [w, d] = [d, w];
    }
    return { x: x + dx, y: cell.dy, z: z + dz, block: rotate(cell.block, turns) };
  });
}
