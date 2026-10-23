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

import type { BuildStep } from '@craftmagic/core';
import type { GridSize } from '../editor/mesher.js';

export interface PlanCell {
  x: number;
  z: number;
  paletteIndex: number;
  isOverhang?: boolean;
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
  hasOverhangs?: boolean;
  overhangCount?: number;
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
const GUTTER_BOTTOM = 16;
const PAD = 6;

const PAPER = '#f6f7f9';
const RULE = 'rgba(20, 26, 33, 0.14)';
const MAJOR_RULE = 'rgba(20, 26, 33, 0.38)';
const EDGE = 'rgba(20, 26, 33, 0.35)';
const INK = '#12171d';
const LABEL = '#5b636d';
const OVERHANG_COLOR = '#d97706';
const OVERHANG_HATCH = 'rgba(217, 119, 6, 0.4)';
const COMPASS_FONT = '8px ui-monospace, "Cascadia Code", Consolas, monospace';
const DIM_FONT = '9px ui-monospace, "Cascadia Code", Consolas, monospace';

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
 * Calculates the bounding box of a list of cells and returns the dimension text:
 * e.g. `${width} × ${depth} blocks`.
 */
export function placedDimensions(cells: readonly PlanCell[]): { width: number; depth: number; text: string } {
  if (cells.length === 0) {
    return { width: 0, depth: 0, text: '0 × 0 blocks' };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const cell of cells) {
    if (cell.x < minX) minX = cell.x;
    if (cell.x > maxX) maxX = cell.x;
    if (cell.z < minZ) minZ = cell.z;
    if (cell.z > maxZ) maxZ = cell.z;
  }
  const width = maxX - minX + 1;
  const depth = maxZ - minZ + 1;
  return { width, depth, text: `${width} × ${depth} blocks` };
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
    running = running.concat(
      step.blocks.map((b) => ({
        x: b.x,
        z: b.z,
        paletteIndex: b.paletteIndex,
        isOverhang: b.isOverhang,
      })),
    );
  }
  return out;
}

export function drawLayerPlan(canvas: HTMLCanvasElement, plan: LayerPlan): void {
  const cols = plan.footprint.x1 - plan.footprint.x0 + 1;
  const rows = plan.footprint.z1 - plan.footprint.z0 + 1;
  const cell = cellSizeFor(cols, rows);

  const width = GUTTER_LEFT + cols * cell + PAD * 2;
  const height = GUTTER_TOP + rows * cell + PAD * 2 + GUTTER_BOTTOM;

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

  // Overhang Indicators: for cells where cell.isOverhang === true, draw amber caution hatch pattern
  for (const cell2 of plan.placed) {
    if (!cell2.isOverhang) continue;
    const px = originX + (cell2.x - plan.footprint.x0) * cell;
    const py = originY + (cell2.z - plan.footprint.z0) * cell;

    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, cell, cell);
    ctx.clip();

    ctx.fillStyle = 'rgba(217, 119, 6, 0.22)';
    ctx.fillRect(px, py, cell, cell);

    ctx.strokeStyle = OVERHANG_HATCH;
    ctx.lineWidth = 1.5;
    const hatchStep = 4;
    for (let d = -cell; d <= cell * 2; d += hatchStep) {
      ctx.beginPath();
      ctx.moveTo(px + d, py);
      ctx.lineTo(px + d + cell, py + cell);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 1-block minor rules
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 0; c <= cols; c++) {
    const worldX = plan.footprint.x0 + c;
    if (worldX % 5 === 0) continue;
    const x = Math.round(originX + c * cell) + 0.5;
    ctx.moveTo(x, originY);
    ctx.lineTo(x, originY + gridH);
  }
  for (let r = 0; r <= rows; r++) {
    const worldZ = plan.footprint.z0 + r;
    if (worldZ % 5 === 0) continue;
    const y = Math.round(originY + r * cell) + 0.5;
    ctx.moveTo(originX, y);
    ctx.lineTo(originX + gridW, y);
  }
  ctx.stroke();

  // 5-block major rules: more prominent line every 5 blocks (x % 5 === 0, z % 5 === 0)
  ctx.strokeStyle = MAJOR_RULE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let c = 0; c <= cols; c++) {
    const worldX = plan.footprint.x0 + c;
    if (worldX % 5 === 0) {
      const x = Math.round(originX + c * cell) + 0.5;
      ctx.moveTo(x, originY);
      ctx.lineTo(x, originY + gridH);
    }
  }
  for (let r = 0; r <= rows; r++) {
    const worldZ = plan.footprint.z0 + r;
    if (worldZ % 5 === 0) {
      const y = Math.round(originY + r * cell) + 0.5;
      ctx.moveTo(originX, y);
      ctx.lineTo(originX + gridW, y);
    }
  }
  ctx.stroke();

  ctx.strokeStyle = EDGE;
  ctx.strokeRect(originX + 0.5, originY + 0.5, gridW - 1, gridH - 1);

  // Coordinate Origin Peg: marker at origin (0, 0) with subtle axis arrows (+X East, +Z South)
  drawOriginPeg(ctx, originX, originY, cell, plan.footprint, gridW, gridH);

  // The one mark that has to survive a photocopier: this step's blocks.
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  for (const cell2 of plan.placed) {
    const x = originX + (cell2.x - plan.footprint.x0) * cell;
    const y = originY + (cell2.z - plan.footprint.z0) * cell;
    if (cell2.isOverhang) {
      ctx.strokeStyle = OVERHANG_COLOR;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
      ctx.strokeStyle = INK;
    } else {
      ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
    }
  }

  drawLabels(ctx, cols, rows, cell, originX, originY, plan.footprint);
  drawCompass(ctx, originX, originY);

  // Overhang badge if step.hasOverhangs
  const hasOverhangs = plan.hasOverhangs ?? plan.placed.some((c) => c.isOverhang);
  if (hasOverhangs) {
    drawOverhangBadge(ctx, width, PAD);
  }

  // Spatial Extents: calculate bounding box of placed blocks and render dimension text: e.g. "${width} × ${depth} blocks"
  drawSpatialExtents(ctx, originX, originY + gridH + 3, gridW, plan.placed);
}

function drawOriginPeg(
  ctx: CanvasRenderingContext2D,
  originX: number,
  originY: number,
  cell: number,
  box: Footprint,
  gridW: number,
  gridH: number,
): void {
  const ox = originX + (0 - box.x0) * cell;
  const oy = originY + (0 - box.z0) * cell;

  // Only draw if (0, 0) is within or directly adjacent to the grid bounds
  if (ox < originX - 2 || ox > originX + gridW + 2 || oy < originY - 2 || oy > originY + gridH + 2) {
    return;
  }

  ctx.save();
  // Small circular origin peg
  ctx.fillStyle = '#b45309';
  ctx.beginPath();
  ctx.arc(ox, oy, 2.5, 0, Math.PI * 2);
  ctx.fill();

  // Subtle axis arrows: +X East, +Z South
  ctx.strokeStyle = '#b45309';
  ctx.fillStyle = '#b45309';
  ctx.lineWidth = 1;
  ctx.font = '7px ui-monospace, "Cascadia Code", Consolas, monospace';

  // If space allows to the right for +X arrow
  if (ox + 16 <= originX + gridW + 10) {
    ctx.beginPath();
    ctx.moveTo(ox + 3, oy);
    ctx.lineTo(ox + 12, oy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ox + 12, oy);
    ctx.lineTo(ox + 9, oy - 2);
    ctx.lineTo(ox + 9, oy + 2);
    ctx.closePath();
    ctx.fill();
  }

  // If space allows downward for +Z arrow
  if (oy + 16 <= originY + gridH + 10) {
    ctx.beginPath();
    ctx.moveTo(ox, oy + 3);
    ctx.lineTo(ox, oy + 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ox, oy + 12);
    ctx.lineTo(ox - 2, oy + 9);
    ctx.lineTo(ox + 2, oy + 9);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

function drawOverhangBadge(ctx: CanvasRenderingContext2D, width: number, top: number): void {
  ctx.save();
  const badgeW = 68;
  const badgeH = 14;
  const x = width - PAD - badgeW;
  const y = top + 2;

  ctx.fillStyle = 'rgba(217, 119, 6, 0.15)';
  ctx.fillRect(x, y, badgeW, badgeH);
  ctx.strokeStyle = '#d97706';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, badgeW, badgeH);

  ctx.fillStyle = '#b45309';
  ctx.font = '8px ui-monospace, "Cascadia Code", Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚠ OVERHANG', x + badgeW / 2, y + badgeH / 2);
  ctx.restore();
}

function drawSpatialExtents(
  ctx: CanvasRenderingContext2D,
  originX: number,
  y: number,
  gridW: number,
  placed: readonly PlanCell[],
): void {
  const dims = placedDimensions(placed);
  if (dims.width === 0) return;

  ctx.save();
  ctx.font = DIM_FONT;
  ctx.fillStyle = LABEL;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(dims.text, originX + gridW, y);
  ctx.restore();
}

/**
 * Which way is north, drawn in the corner the two rulers meet.
 *
 * A ruled grid answers "which square" and says nothing about which way to face, and a plan
 * you cannot orient is a plan you have to guess at — every reader would otherwise work it out
 * once, from the isometric, and hope they got it the right way round.
 *
 * North is up because the grid is drawn in world axes: rows run along +z, which is south in
 * Minecraft, so row 1 is the northernmost. Columns run along +x, which is east. That is a
 * fact about the game's coordinate system rather than a choice made here, which is exactly
 * why it is worth printing — nobody should have to recall it mid-build.
 *
 * Into the canvas rather than beside it in HTML: it belongs to the drawing, so it has to
 * survive the drawing being printed, saved or pasted somewhere else.
 */
function drawCompass(ctx: CanvasRenderingContext2D, originX: number, originY: number): void {
  // The corner where the two rulers meet, and the only free space on the drawing: 26 x 18
  // device-independent pixels. Arrow and letter go side by side rather than stacked, because
  // stacked they need 18px of height and the row-1 label is already using the bottom of it.
  const midY = (PAD + originY) / 2;
  const arrowX = PAD + 7;
  const letterX = PAD + 17;

  ctx.save();
  ctx.strokeStyle = LABEL;
  ctx.fillStyle = LABEL;
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(arrowX, midY + 4);
  ctx.lineTo(arrowX, midY - 1);
  ctx.stroke();

  // Solid head: at this size an outlined arrowhead closes up into a blob.
  ctx.beginPath();
  ctx.moveTo(arrowX, midY - 5);
  ctx.lineTo(arrowX - 2.6, midY - 1);
  ctx.lineTo(arrowX + 2.6, midY - 1);
  ctx.closePath();
  ctx.fill();

  ctx.font = COMPASS_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', letterX, midY);
  ctx.restore();
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
