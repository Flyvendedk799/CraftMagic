/**
 * The preview vocabulary — shapes, caps and the small geometry helpers.
 *
 * Split out of `preview.ts` so the tool registry can build previews from the same pieces
 * without an import cycle: shapes know nothing about tools, tools build shapes, and
 * `preview.ts` keeps the public `previewFor` the page and the tests call.
 */

import { AIR_INDEX, voxelIndex, type VoxelGrid } from '@craftmagic/core';
import type { Cell } from './tools/brush.js';

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

export function cellPreview(cells: Cell[]): Preview | null {
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

export function boxLabel(min: Cell, max: Cell, cells: number): string {
  return `${max.x - min.x + 1}×${max.y - min.y + 1}×${max.z - min.z + 1} · ${cells.toLocaleString()} cells`;
}

export function isAir(grid: VoxelGrid, cell: Cell): boolean {
  return (grid.voxels[voxelIndex(grid.size, cell.x, cell.y, cell.z)] ?? AIR_INDEX) === AIR_INDEX;
}

export function clipCells(grid: VoxelGrid, cells: readonly Cell[]): Cell[] {
  const { size } = grid;
  return cells.filter(
    (c) => c.x >= 0 && c.y >= 0 && c.z >= 0 && c.x < size.x && c.y < size.y && c.z < size.z,
  );
}

export function dedupe(cells: readonly Cell[]): Cell[] {
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
