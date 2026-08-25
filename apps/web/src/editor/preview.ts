/**
 * What the next click would do, worked out before it happens.
 *
 * Every destructive tool in this editor used to be a leap of faith: a box was two clicks
 * with nothing between them but a yellow marker on the first corner, and a brush wider than
 * one block was invisible until it had already landed. Undo covers the mistake, but undo is
 * not the same as never making it — and on a 200k-block build "undo, re-aim, try again"
 * costs a re-mesh each time.
 *
 * So the tools are asked to describe their result twice: once as a preview, once as an op.
 * That duplication is deliberate and bounded — the preview reuses the same `brushCells`,
 * `linePath` and `boxBounds` the ops are built from, so the outline cannot disagree with
 * what the click does. The `label` travels with the shape because the number of cells is
 * exactly the thing that is hard to judge by eye, and it belongs next to the outline rather
 * than in a panel on the far side of the screen.
 */

import { AIR_INDEX, voxelIndex, type VoxelGrid } from '@craftmagic/core';
import { boxBounds } from './tools/boxSelect.js';
import { brushCells, type BrushShape, type Cell } from './tools/brush.js';
import { stampBounds, type Clip } from './tools/clipboard.js';
import { linePath } from './tools/line.js';
import { placementCell } from './tools/place.js';
import type { VoxelHit } from './raycast.js';

export interface PreviewBox {
  kind: 'box';
  min: Cell;
  max: Cell;
  label: string;
}

export interface PreviewCells {
  kind: 'cells';
  cells: Cell[];
  label: string;
}

export type Preview = PreviewBox | PreviewCells;

/**
 * Cells drawn individually before the preview falls back to a bounding box.
 *
 * Each cell is twelve wireframe edges rebuilt on every pointer move, so this is a frame
 * budget rather than a memory one. A radius-8 ball is 2100 cells and a full-diagonal line is
 * ~450: the first is worth summarising, the second is exactly what the user needs to see.
 */
export const PREVIEW_CELL_CAP = 800;

export interface PreviewInput {
  grid: VoxelGrid;
  tool: string;
  /** Where the pointer is, or null when it is off the build. */
  hover: VoxelHit | null;
  /** First corner of a two-click tool, if one has been taken. */
  anchor: Cell | null;
  radius: number;
  shape: BrushShape;
  clip: Clip | null;
}

export function previewFor(input: PreviewInput): Preview | null {
  const { grid, tool, hover, anchor, radius, shape, clip } = input;
  if (!hover) return null;

  const brush = { radius, shape };

  switch (tool) {
    case 'place': {
      const cell = placementCell(grid, hover);
      if (!cell) return null;
      // Only the cells that would really change: a brush hard against a wall should show the
      // half of itself that lands in the air, not a ball hanging inside the masonry.
      return cellPreview(brushCells(grid, cell, brush).filter((c) => isAir(grid, c)));
    }

    case 'erase':
      return cellPreview(brushCells(grid, hover, brush).filter((c) => !isAir(grid, c)));

    case 'line': {
      if (!anchor) return cellPreview(brushCells(grid, hover, brush));
      const path = linePath(anchor, hover);
      const cells =
        radius > 0 ? dedupe(path.flatMap((cell) => brushCells(grid, cell, brush))) : clipCells(grid, path);
      return cellPreview(cells);
    }

    case 'select': {
      if (!anchor) return null;
      const { min, max, cells } = boxBounds(grid, anchor, hover);
      return { kind: 'box', min, max, label: boxLabel(min, max, cells) };
    }

    case 'stamp': {
      if (!clip) return null;
      const cell = placementCell(grid, hover) ?? hover;
      const { min, max } = stampBounds(clip, cell);
      return {
        kind: 'box',
        min,
        max,
        label: `${clip.size.x}×${clip.size.y}×${clip.size.z} · ${clip.blocks.toLocaleString()} blocks`,
      };
    }

    default:
      // Fill, swap and pick all act on exactly the cell already under the hover highlight,
      // so a second outline around it would be noise.
      return null;
  }
}

function cellPreview(cells: Cell[]): Preview | null {
  if (cells.length === 0) return null;
  const label = `${cells.length.toLocaleString()} block${cells.length === 1 ? '' : 's'}`;
  if (cells.length <= PREVIEW_CELL_CAP) return { kind: 'cells', cells, label };

  const min = { ...cells[0]! };
  const max = { ...cells[0]! };
  for (const cell of cells) {
    if (cell.x < min.x) min.x = cell.x;
    if (cell.y < min.y) min.y = cell.y;
    if (cell.z < min.z) min.z = cell.z;
    if (cell.x > max.x) max.x = cell.x;
    if (cell.y > max.y) max.y = cell.y;
    if (cell.z > max.z) max.z = cell.z;
  }
  return { kind: 'box', min, max, label };
}

function boxLabel(min: Cell, max: Cell, cells: number): string {
  return `${max.x - min.x + 1}×${max.y - min.y + 1}×${max.z - min.z + 1} · ${cells.toLocaleString()} cells`;
}

function isAir(grid: VoxelGrid, cell: Cell): boolean {
  return (grid.voxels[voxelIndex(grid.size, cell.x, cell.y, cell.z)] ?? AIR_INDEX) === AIR_INDEX;
}

function clipCells(grid: VoxelGrid, cells: readonly Cell[]): Cell[] {
  const { size } = grid;
  return cells.filter(
    (c) => c.x >= 0 && c.y >= 0 && c.z >= 0 && c.x < size.x && c.y < size.y && c.z < size.z,
  );
}

function dedupe(cells: readonly Cell[]): Cell[] {
  const seen = new Set<number>();
  const out: Cell[] = [];
  for (const cell of cells) {
    // Packed rather than a string key: this runs per pointer move over a few thousand cells.
    const key = (cell.x << 20) | (cell.y << 10) | cell.z;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cell);
  }
  return out;
}
