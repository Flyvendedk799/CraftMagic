/**
 * The tool registry: every editor tool as one object with three faces.
 *
 * This file replaces the three parallel switches that used to define a tool — a `case` in
 * `EditorPage.onCanvasClick`, another in `onStroke`, a third in `preview.ts` — with a single
 * `EditorTool` per id. The page becomes a dispatcher: it builds a `ToolCtx` from its state,
 * calls the tool, and applies whatever `ToolResult` comes back. A new tool is a new entry in
 * this map plus a row in `toolset.ts`, and nothing else.
 *
 * The tools' *logic* did not move: the pure functions in `tools/*.ts` are wrapped, not
 * rewritten, so every existing unit test still tests the thing that runs. `ToolResult` is
 * plain data — an op to apply, state to set, a sentence to show — because a tool that
 * reached into React state directly would be untestable and unreusable, and the whole point
 * of this file is that tools are neither.
 */

import { AIR_BLOCK, displayName, voxelIndex, type BlockRef, type EditOp, type VoxelGrid } from '@craftmagic/core';
import type { VoxelHit } from '../raycast.js';
import { boxLabel, cellPreview, clipCells, dedupe, isAir, type Preview } from '../previewShapes.js';
import { boxBounds, type BoxCorner } from './boxSelect.js';
import { brushCells, brushEdit, type BrushShape, type Cell } from './brush.js';
import { grabStructure } from './grab.js';
import { linePath, lineEdit } from './line.js';
import { erase } from './erase.js';
import { floodFill } from './fill.js';
import { pickBlock } from './pick.js';
import { placementCell } from './place.js';
import { familyOf, swapFamily, swapPaletteIndex } from './paletteSwap.js';
import { stampBounds, stampEdit, type Clip, type StampMode } from './clipboard.js';
import type { ToolId } from '../toolset.js';

/** Everything a tool may read. Built fresh per call by the page — it is a view, not state. */
export interface ToolCtx {
  grid: VoxelGrid;
  /** The active block ref. */
  block: BlockRef;
  brush: { radius: number; shape: BrushShape };
  /** First corner of a two-click gesture, if one is standing. */
  anchor: Cell | null;
  clip: Clip | null;
  stampMode: StampMode;
  familyMode: boolean;
  /** Palette slot for a ref, growing the palette; -1 when it is full. */
  resolveBlock: (ref: BlockRef) => number;
}

/**
 * What a tool decided. Plain data; the page applies it.
 *
 * `undefined` on a field means "leave that state alone" — `null` is an explicit clear.
 */
export interface ToolResult {
  op?: EditOp | null;
  anchor?: Cell | null;
  region?: { min: BoxCorner; max: BoxCorner } | null;
  /** Adopt a block as the active one. */
  pickBlock?: BlockRef;
  /** Replace the clipboard. */
  clip?: Clip;
  /** Switch to another tool — Grab hands you to Stamp the way Copy does. */
  switchTool?: ToolId;
  notice?: string | null;
}

export interface EditorTool {
  /** Refusal shown when the click landed on the bare ground plane; absent = ground is fine. */
  groundRefusal?: string;
  /** True for drawing tools whose ops symmetry mode may mirror. */
  mirrorable?: boolean;
  onClick(ctx: ToolCtx, hit: VoxelHit): ToolResult;
  /** A whole Shift-drag as one gesture. Absence tells the canvas to let the drag orbit. */
  onStroke?(ctx: ToolCtx, hits: VoxelHit[]): ToolResult;
  /** The outline of what the next click would do, or null for tools the hover cell explains. */
  preview?(ctx: ToolCtx, hover: VoxelHit): Preview | null;
}

const PALETTE_FULL = 'Palette is full — this build cannot hold another block type.';

/** Resolve the active block, or explain why not. */
function slot(ctx: ToolCtx): { index: number; refusal: ToolResult | null } {
  const index = ctx.resolveBlock(ctx.block);
  return { index, refusal: index < 0 ? { notice: PALETTE_FULL } : null };
}

const place: EditorTool = {
  mirrorable: true,
  onClick(ctx, hit) {
    const { index, refusal } = slot(ctx);
    if (refusal) return refusal;
    const cell = placementCell(ctx.grid, hit);
    if (!cell) return { notice: 'Nothing to place there — that face is already covered.' };
    const result = brushEdit(ctx.grid, [cell], index, { ...ctx.brush, onlyAir: true });
    return {
      op: result.op,
      notice:
        result.cells === 0
          ? 'Nothing to place there — every cell the brush covers is already filled.'
          : ctx.brush.radius === 0
            ? null
            : `Placed ${result.cells.toLocaleString()} blocks.`,
    };
  },
  onStroke(ctx, hits) {
    const { index, refusal } = slot(ctx);
    if (refusal) return refusal;
    const cells = hits
      .map((hit) => placementCell(ctx.grid, hit))
      .filter((cell): cell is Cell => cell !== null);
    const result = brushEdit(ctx.grid, cells, index, { ...ctx.brush, onlyAir: true });
    return {
      op: result.op,
      notice: result.op ? `Placed ${result.cells.toLocaleString()} blocks in one stroke.` : null,
    };
  },
  preview(ctx, hover) {
    const cell = placementCell(ctx.grid, hover);
    if (!cell) return null;
    // Only the cells that would really change: a brush hard against a wall should show the
    // half of itself that lands in the air, not a ball hanging inside the masonry.
    return cellPreview(brushCells(ctx.grid, cell, ctx.brush).filter((c) => isAir(ctx.grid, c)));
  },
};

const eraseTool: EditorTool = {
  groundRefusal: 'Nothing there to erase — that is bare ground.',
  mirrorable: true,
  onClick(ctx, hit) {
    if (ctx.brush.radius === 0) return { op: erase(ctx.grid, hit), notice: null };
    const result = brushEdit(ctx.grid, [hit], 0, { ...ctx.brush, onlySolid: true });
    return {
      op: result.op,
      notice: result.cells === 0 ? 'Nothing there to erase.' : `Erased ${result.cells.toLocaleString()} blocks.`,
    };
  },
  onStroke(ctx, hits) {
    const result = brushEdit(ctx.grid, hits, 0, { ...ctx.brush, onlySolid: true });
    return {
      op: result.op,
      notice: result.op ? `Erased ${result.cells.toLocaleString()} blocks in one stroke.` : null,
    };
  },
  preview(ctx, hover) {
    return cellPreview(brushCells(ctx.grid, hover, ctx.brush).filter((c) => !isAir(ctx.grid, c)));
  },
};

const fill: EditorTool = {
  groundRefusal: 'Nothing to fill there — a flood fill has to start from a block.',
  mirrorable: true,
  onClick(ctx, hit) {
    const { index, refusal } = slot(ctx);
    if (refusal) return refusal;
    const result = floodFill(ctx.grid, hit, index);
    return {
      op: result.op,
      notice: result.capped
        ? `Filled ${result.cells.toLocaleString()} blocks — stopped at the cap; click again to continue.`
        : `Filled ${result.cells.toLocaleString()} connected block${result.cells === 1 ? '' : 's'}.`,
    };
  },
};

const line: EditorTool = {
  mirrorable: true,
  onClick(ctx, hit) {
    if (!ctx.anchor) {
      return { anchor: { x: hit.x, y: hit.y, z: hit.z }, notice: 'Now click the other end.' };
    }
    const { index, refusal } = slot(ctx);
    if (refusal) return refusal;
    const result = lineEdit(ctx.grid, ctx.anchor, hit, index, ctx.brush);
    return {
      op: result.op,
      anchor: null,
      notice: `Drew a line of ${result.cells.toLocaleString()} blocks.`,
    };
  },
  preview(ctx, hover) {
    if (!ctx.anchor) return cellPreview(brushCells(ctx.grid, hover, ctx.brush));
    const path = linePath(ctx.anchor, hover);
    const cells =
      ctx.brush.radius > 0
        ? dedupe(path.flatMap((cell) => brushCells(ctx.grid, cell, ctx.brush)))
        : clipCells(ctx.grid, path);
    return cellPreview(cells);
  },
};

const select: EditorTool = {
  onClick(ctx, hit) {
    if (!ctx.anchor) {
      return {
        anchor: { x: hit.x, y: hit.y, z: hit.z },
        region: null,
        notice: 'Now click the opposite corner.',
      };
    }
    // The second corner selects and stops. It used to edit — which meant aiming the box
    // and committing to a verb were the same act, and a box you wanted to hollow after
    // filling had to be aimed a second time.
    const bounds = boxBounds(ctx.grid, ctx.anchor, hit);
    return { anchor: null, region: { min: bounds.min, max: bounds.max }, notice: null };
  },
  preview(ctx, hover) {
    if (!ctx.anchor) return null;
    const { min, max, cells } = boxBounds(ctx.grid, ctx.anchor, hover);
    return { kind: 'box', min, max, label: boxLabel(min, max, cells) };
  },
};

const stamp: EditorTool = {
  onClick(ctx, hit) {
    if (!ctx.clip) return { notice: 'Nothing copied yet — use the Box tool in Copy mode first.' };
    const cell = placementCell(ctx.grid, hit) ?? hit;
    const result = stampEdit(ctx.grid, ctx.clip, cell, ctx.resolveBlock, ctx.stampMode);
    return {
      op: result.op,
      notice: result.truncated
        ? 'Palette is full — part of the clipboard could not be stamped.'
        : `Stamped ${result.cells.toLocaleString()} blocks at ${cell.x}, ${cell.y}, ${cell.z}.`,
    };
  },
  preview(ctx, hover) {
    if (!ctx.clip) return null;
    const cell = placementCell(ctx.grid, hover) ?? hover;
    const { min, max } = stampBounds(ctx.clip, cell);
    return {
      kind: 'box',
      min,
      max,
      label: `${ctx.clip.size.x}×${ctx.clip.size.y}×${ctx.clip.size.z} · ${ctx.clip.blocks.toLocaleString()} blocks`,
    };
  },
};

const pick: EditorTool = {
  groundRefusal: 'Nothing to pick there — click a block to make it the active one.',
  onClick(ctx, hit) {
    const picked = pickBlock(ctx.grid, hit);
    if (!picked) return { notice: 'Nothing to pick there.' };
    return { pickBlock: picked, notice: `Picked ${displayName(picked)}.` };
  },
};

const swap: EditorTool = {
  groundRefusal: 'Nothing to swap there — click the block you want replaced everywhere.',
  onClick(ctx, hit) {
    const from = ctx.grid.voxels[voxelIndex(ctx.grid.size, hit.x, hit.y, hit.z)] ?? 0;

    if (ctx.familyMode) {
      // Deliberately not `slot()`: a family swap resolves its own replacements, and
      // reserving a slot for the chosen block would leave an unused palette entry
      // whenever its category has no counterpart in the source family.
      const source = familyOf(ctx.grid.palette[from] ?? AIR_BLOCK);
      const target = familyOf(ctx.block);
      if (!source || !target) {
        return { notice: 'Family swap needs two blocks the registry knows a family for.' };
      }
      const op = swapFamily(ctx.grid, source, target, ctx.resolveBlock);
      return {
        op,
        notice: op
          ? `Re-skinned ${source} → ${target}: ${op.indices.length.toLocaleString()} blocks.`
          : `Nothing in the ${source} family to re-skin.`,
      };
    }

    const { index, refusal } = slot(ctx);
    if (refusal) return refusal;
    const op = swapPaletteIndex(ctx.grid, from, index);
    return {
      op,
      notice: op
        ? `Swapped ${op.indices.length.toLocaleString()} blocks of ${displayName(ctx.grid.palette[from] ?? AIR_BLOCK)}.`
        : 'That block is already the chosen one.',
    };
  },
};

const grab: EditorTool = {
  groundRefusal: 'Nothing to grab there — click any block of the structure you want to lift.',
  onClick(ctx, hit) {
    const result = grabStructure(ctx.grid, hit);
    if (result.capped) {
      return {
        notice: `That structure is over ${result.cells.toLocaleString()} blocks — too much to grab. Use the Box tool for something that size.`,
      };
    }
    if (!result.clip) return { notice: 'Nothing to grab there.' };
    return {
      op: result.op,
      clip: result.clip,
      switchTool: 'stamp',
      notice: `Grabbed ${result.cells.toLocaleString()} blocks — click to stamp it down. Undo puts it back.`,
    };
  },
};

export const TOOL_IMPL: Readonly<Record<ToolId, EditorTool>> = {
  place,
  erase: eraseTool,
  fill,
  select,
  swap,
  line,
  stamp,
  pick,
  grab,
};
