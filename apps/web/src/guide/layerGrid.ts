/**
 * The top-down plan for one step, drawn on a 2D canvas.
 *
 * 2D on purpose. This panel's job is to answer "which square does this block go in", and a
 * ruled grid with A..Z across and 1..n down does that better than any projection — the
 * reader counts squares on it. Three.js would only make it prettier and less useful.
 *
 * Three depths are drawn at once because a plan of the current step alone is unplaceable:
 * the layer below anchors it to the structure, and what was placed earlier in *this* layer
 * says which of the squares in front of you are already done. Only the new blocks get full
 * saturation and an outline, so "what do I place now" survives being photocopied.
 *
 * It is drawn on paper white in both themes. A dark plan that inverted for print would make
 * the booklet on screen and the booklet in your hand two different documents, and the alpha
 * blending of the ghost layers would land on a different background in each.
 */

import type { BuildStep } from '@imaginecraft/core';
import type { GridSize } from '../editor/mesher.js';

export interface PlanCell {
  x: number;
  z: number;
  paletteIndex: number;
}

/** Inclusive x/z bounds of everything the build ever occupies — see {@link footprint}. */
export interface Footprint {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface LayerPlan {
  size: GridSize;
  /** The finished build. Bottom-up ordering means layer `y-1` is already complete here. */
  voxels: Uint16Array;
  /** 3 bytes per palette slot, as the editor builds them. */
  paletteColors: Uint8Array;
  footprint: Footprint;
  layer: number;
  /** Placed by this step — full colour, outlined. */
  placed: readonly PlanCell[];
  /** Placed earlier in the same layer — context only. */
  earlier: readonly PlanCell[];
}

/** Below this a square is too small to count reliably on paper. */
const MIN_CELL = 12;
/** Above this the plan just wastes page for no extra clarity. */
const MAX_CELL = 24;
/** CSS-pixel cap on the whole canvas, so a 150-wide build cannot emit a 2000px image. */
const MAX_CANVAS = 660;
/** Room for the row numbers and column letters. */
const GUTTER_LEFT = 26;
const GUTTER_TOP = 18;
const PAD = 6;

const PAPER = '#f6f7f9';
const RULE = 'rgba(20, 26, 33, 0.14)';
const EDGE = 'rgba(20, 26, 33, 0.35)';
const INK = '#12171d';
const LABEL = '#5b636d';

/** Earlier-in-this-layer, and the layer below. Both are context, at decreasing strength. */
const ALPHA_EARLIER = 0.45;
const ALPHA_BELOW = 0.2;

/**
 * Backing-store scale. The canvas is printed as well as displayed, and a 1x bitmap scaled
 * up to a print DPI is visibly soft where the outlines matter most.
 */
const SCALE = 2;

/**
 * Square size for a plan of this many cells across.
 *
 * Kept out of the drawing code because it is the one number worth pinning down: too small
 * and the printed grid is uncountable, too large and one step eats a page.
 */
export function cellSizeFor(cols: number, rows: number): number {
  const span = Math.max(1, cols, rows);
  const fit = Math.floor((MAX_CANVAS - GUTTER_LEFT - PAD * 2) / span);
  if (fit >= MIN_CELL) return Math.min(MAX_CELL, fit);
  // A build too wide for the minimum keeps the page cap and gives up square size, because
  // an oversized image is a broken layout while a small square is only a hard one to read.
  return Math.max(4, fit);
}

/** Spreadsheet-style column names, so a plan wider than 26 still has unique labels. */
export function columnLabel(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** The x/z rectangle the build ever occupies, so every step's plan is framed identically. */
export function footprint(cells: readonly PlanCell[]): Footprint {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const cell of cells) {
    if (cell.x < x0) x0 = cell.x;
    if (cell.x > x1) x1 = cell.x;
    if (cell.z < z0) z0 = cell.z;
    if (cell.z > z1) z1 = cell.z;
  }
  if (x1 < x0) return { x0: 0, z0: 0, x1: 0, z1: 0 };
  return { x0, z0, x1, z1 };
}

/**
 * For each step, what the *same layer* already holds from earlier steps.
 *
 * Accumulated in one pass and reset whenever the layer changes, rather than re-scanning the
 * step list per card: a layer that split into eight parts would otherwise re-walk its
 * predecessors eight times, and the result is the same array either way.
 */
export function earlierInLayer(steps: readonly BuildStep[]): PlanCell[][] {
  const out: PlanCell[][] = [];
  let layer = -1;
  let running: PlanCell[] = [];

  for (const step of steps) {
    if (step.layer !== layer) {
      layer = step.layer;
      running = [];
    }
    // Snapshot before adding: this step's own blocks are drawn as new, not as context.
    out.push(running);
    running = running.concat(step.blocks.map((b) => ({ x: b.x, z: b.z, paletteIndex: b.paletteIndex })));
  }
  return out;
}

export function drawLayerPlan(canvas: HTMLCanvasElement, plan: LayerPlan): void {
  const cols = plan.footprint.x1 - plan.footprint.x0 + 1;
  const rows = plan.footprint.z1 - plan.footprint.z0 + 1;
  const cell = cellSizeFor(cols, rows);

  const width = GUTTER_LEFT + cols * cell + PAD * 2;
  const height = GUTTER_TOP + rows * cell + PAD * 2;

  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  canvas.style.width = `${width}px`;
  // Height is left to the intrinsic ratio rather than pinned: an inline pixel height would
  // out-specify the stylesheet, and the print rules narrow this canvas to a column — with a
  // fixed height that scales the squares on one axis only.
  canvas.style.height = 'auto';

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const originX = GUTTER_LEFT + PAD;
  const originY = GUTTER_TOP + PAD;
  const gridW = cols * cell;
  const gridH = rows * cell;

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);

  // Painter's order, back to front: the layer below, then this layer's earlier steps, then
  // the new blocks — so a new block always covers whatever it sits on.
  if (plan.layer > 0) {
    ctx.globalAlpha = ALPHA_BELOW;
    for (const cell2 of layerCells(plan, plan.layer - 1)) {
      fillCell(ctx, plan, cell2, originX, originY, cell);
    }
  }

  ctx.globalAlpha = ALPHA_EARLIER;
  for (const cell2 of plan.earlier) fillCell(ctx, plan, cell2, originX, originY, cell);

  ctx.globalAlpha = 1;
  for (const cell2 of plan.placed) fillCell(ctx, plan, cell2, originX, originY, cell);

  // Rules go over the fills, not under: a run of twenty identical blocks is one solid slab
  // otherwise, and the reader cannot count it.
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 0; c <= cols; c++) {
    const x = Math.round(originX + c * cell) + 0.5;
    ctx.moveTo(x, originY);
    ctx.lineTo(x, originY + gridH);
  }
  for (let r = 0; r <= rows; r++) {
    const y = Math.round(originY + r * cell) + 0.5;
    ctx.moveTo(originX, y);
    ctx.lineTo(originX + gridW, y);
  }
  ctx.stroke();

  ctx.strokeStyle = EDGE;
  ctx.strokeRect(originX + 0.5, originY + 0.5, gridW - 1, gridH - 1);

  // The one mark that has to survive a photocopier: this step's blocks.
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  for (const cell2 of plan.placed) {
    const x = originX + (cell2.x - plan.footprint.x0) * cell;
    const y = originY + (cell2.z - plan.footprint.z0) * cell;
    ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
  }

  drawLabels(ctx, cols, rows, cell, originX, originY, plan.footprint);
}

function fillCell(
  ctx: CanvasRenderingContext2D,
  plan: LayerPlan,
  cell: PlanCell,
  originX: number,
  originY: number,
  size: number,
): void {
  const base = cell.paletteIndex * 3;
  const r = plan.paletteColors[base] ?? 136;
  const g = plan.paletteColors[base + 1] ?? 136;
  const b = plan.paletteColors[base + 2] ?? 136;
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  ctx.fillRect(
    originX + (cell.x - plan.footprint.x0) * size,
    originY + (cell.z - plan.footprint.z0) * size,
    size,
    size,
  );
}

function layerCells(plan: LayerPlan, y: number): PlanCell[] {
  const { size, voxels, footprint: box } = plan;
  const cells: PlanCell[] = [];
  const layerBase = y * size.x * size.z;
  for (let z = box.z0; z <= box.z1; z++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const paletteIndex = voxels[layerBase + z * size.x + x] ?? 0;
      if (paletteIndex !== 0) cells.push({ x, z, paletteIndex });
    }
  }
  return cells;
}

/**
 * Letters across x, numbers down z.
 *
 * Labels thin out rather than shrink when the squares get tight — an unreadable label every
 * cell is worse than a readable one every third, and the grid lines carry the counting.
 */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  cols: number,
  rows: number,
  cell: number,
  originX: number,
  originY: number,
  box: Footprint,
): void {
  const font = Math.max(9, Math.min(12, cell - 3));
  const every = cell >= 14 ? 1 : cell >= 10 ? 2 : 5;

  ctx.fillStyle = LABEL;
  ctx.font = `${font}px ui-monospace, "Cascadia Code", Consolas, monospace`;
  ctx.textBaseline = 'middle';

  ctx.textAlign = 'center';
  for (let c = 0; c < cols; c++) {
    if (c % every !== 0 && c !== cols - 1) continue;
    ctx.fillText(columnLabel(box.x0 + c), originX + c * cell + cell / 2, GUTTER_TOP / 2 + 2);
  }

  ctx.textAlign = 'right';
  for (let r = 0; r < rows; r++) {
    if (r % every !== 0 && r !== rows - 1) continue;
    ctx.fillText(String(box.z0 + r + 1), GUTTER_LEFT - 2, originY + r * cell + cell / 2);
  }
}
