/**
 * Brushes and strokes — the two things that turn "click, click, click" into one gesture.
 *
 * Both problems are the same problem underneath. A radius-3 ball around one click and a
 * hundred clicks dragged across a wall are both *a set of cells that should become one
 * edit*, and the reason that matters is the undo stack: a drag that pushed one op per
 * pointer move would need eighty presses of Ctrl+Z to take back one stroke, and the byte
 * ceiling in `history.ts` would evict the beginning of the stroke while its end was still
 * on screen. So the caller collects centres — one for a click, many for a drag — and gets a
 * single `EditOp` back.
 *
 * The de-duplication is not an optimisation. Overlapping brush stamps along a drag hit the
 * same cell many times, and an op that recorded a cell twice would count it twice in
 * `blockDelta`, leaving the HUD's block count permanently wrong. `before` is read from a
 * grid this module never mutates, so the second record would also be a lie about what was
 * there.
 */

import { AIR_INDEX, voxelIndex, type EditOp, type VoxelGrid } from '@craftmagic/core';
import { EditBuilder } from './op.js';

export interface Cell {
  x: number;
  y: number;
  z: number;
}

/** A round brush feels like a brush; a square one is what you want for beams and walls. */
export type BrushShape = 'ball' | 'cube';

/** Radius in blocks around the centre. 0 is a single cell — the classic one-block click. */
export const MAX_BRUSH_RADIUS = 8;

/**
 * Ceiling on the cells one stroke may change.
 *
 * A radius-8 ball is ~2100 cells, and a drag across a large build can collect hundreds of
 * centres, so an uncapped stroke could build a 20 MB op from a single flick of the wrist.
 * The cap is generous enough that no deliberate gesture reaches it and low enough that an
 * accidental one stays undoable.
 */
export const MAX_STROKE_CELLS = 250_000;

export interface BrushOptions {
  radius?: number;
  shape?: BrushShape;
  /** Write only where the grid currently holds air — placing must not eat what you aimed at. */
  onlyAir?: boolean;
  /** Write only where the grid currently holds a block — erasing must not "erase" empty space. */
  onlySolid?: boolean;
  /** Cells beyond this are dropped and reported. */
  cap?: number;
}

export interface BrushResult {
  /** Null when nothing would change, so an empty gesture never reaches the history. */
  op: EditOp | null;
  /** Cells the brush actually changed. */
  cells: number;
  /** True when the stroke hit `cap` and was cut short. */
  capped: boolean;
}

const OFFSET_CACHE = new Map<string, readonly Cell[]>();

/**
 * Offsets covering one brush stamp, centre first.
 *
 * Cached per (radius, shape): a drag stamps the same brush at every centre, and rebuilding a
 * 2000-entry offset list per pointer move is the one part of a stroke that is genuinely hot.
 * Centre first so a radius-0 brush is a single-element array with no allocation surprises.
 */
export function brushOffsets(radius: number, shape: BrushShape = 'ball'): readonly Cell[] {
  const r = Math.min(MAX_BRUSH_RADIUS, Math.max(0, Math.floor(radius)));
  if (r === 0) return CENTRE_ONLY;

  const key = `${shape}:${r}`;
  const cached = OFFSET_CACHE.get(key);
  if (cached) return cached;

  const out: Cell[] = [];
  // `+ 0.5` on the radius: a ball of radius 2 tested against `<= 4` loses its poles and
  // reads as a cube with the corners bitten off. Testing against the cell centre distance
  // is what makes small radii look round.
  const limit = (r + 0.5) * (r + 0.5);
  for (let y = -r; y <= r; y++) {
    for (let z = -r; z <= r; z++) {
      for (let x = -r; x <= r; x++) {
        if (shape === 'ball' && x * x + y * y + z * z > limit) continue;
        out.push({ x, y, z });
      }
    }
  }

  OFFSET_CACHE.set(key, out);
  return out;
}

const CENTRE_ONLY: readonly Cell[] = [{ x: 0, y: 0, z: 0 }];

/** Cells one stamp of the brush would cover, clamped to the grid. Used for the live preview. */
export function brushCells(grid: VoxelGrid, centre: Cell, options: BrushOptions = {}): Cell[] {
  const offsets = brushOffsets(options.radius ?? 0, options.shape ?? 'ball');
  const { size } = grid;
  const out: Cell[] = [];
  for (const offset of offsets) {
    const x = centre.x + offset.x;
    const y = centre.y + offset.y;
    const z = centre.z + offset.z;
    if (x < 0 || y < 0 || z < 0 || x >= size.x || y >= size.y || z >= size.z) continue;
    out.push({ x, y, z });
  }
  return out;
}

/**
 * Stamp the brush at every centre and fold the result into one op.
 *
 * `centres` is the whole gesture: one cell for a click, the path of a drag for a stroke.
 */
export function brushEdit(
  grid: VoxelGrid,
  centres: readonly Cell[],
  value: number,
  options: BrushOptions = {},
): BrushResult {
  const offsets = brushOffsets(options.radius ?? 0, options.shape ?? 'ball');
  const cap = Math.max(1, Math.floor(options.cap ?? MAX_STROKE_CELLS));
  const { size, voxels } = grid;

  const builder = new EditBuilder(grid, Math.min(cap, offsets.length * centres.length));
  // Flat indices already recorded. A Set rather than a Uint8Array shadow of the grid: a
  // stroke touches thousands of cells, not millions, and the shadow would cost 16 MB on a
  // full-size build for every gesture.
  const seen = new Set<number>();
  let capped = false;

  outer: for (const centre of centres) {
    for (const offset of offsets) {
      const x = centre.x + offset.x;
      const y = centre.y + offset.y;
      const z = centre.z + offset.z;
      if (x < 0 || y < 0 || z < 0 || x >= size.x || y >= size.y || z >= size.z) continue;

      const index = voxelIndex(size, x, y, z);
      if (seen.has(index)) continue;

      const current = voxels[index];
      if (current === undefined) continue;
      if (options.onlyAir && current !== AIR_INDEX) continue;
      if (options.onlySolid && current === AIR_INDEX) continue;

      seen.add(index);
      builder.set(index, value);

      if (seen.size >= cap) {
        capped = true;
        break outer;
      }
    }
  }

  return { op: builder.build(), cells: builder.size, capped };
}
