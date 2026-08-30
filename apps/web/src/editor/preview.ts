/**
 * What the next click would do, worked out before it happens.
 *
 * Every destructive tool in this editor used to be a leap of faith: a box was two clicks
 * with nothing between them but a yellow marker on the first corner, and a brush wider than
 * one block was invisible until it had already landed. Undo covers the mistake, but undo is
 * not the same as never making it — and on a 200k-block build "undo, re-aim, try again"
 * costs a re-mesh each time.
 *
 * Each tool describes its own preview now — see `tools/registry.ts` — built from the same
 * `brushCells`, `linePath` and `boxBounds` its op is built from, so the outline cannot
 * disagree with what the click does. This module keeps the page-facing entry point and the
 * preview types (re-exported from `previewShapes.ts`), so existing callers and tests are
 * untouched by the registry refactor.
 */

import type { VoxelGrid } from '@craftmagic/core';
import type { BrushShape } from './tools/brush.js';
import type { Cell } from './tools/brush.js';
import type { Clip } from './tools/clipboard.js';
import { TOOL_IMPL } from './tools/registry.js';
import type { ToolId } from './toolset.js';
import type { VoxelHit } from './raycast.js';

export {
  PREVIEW_CELL_CAP,
  type Preview,
  type PreviewBox,
  type PreviewCells,
} from './previewShapes.js';
import type { Preview } from './previewShapes.js';

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

  const impl = TOOL_IMPL[tool as ToolId];
  if (!impl?.preview) return null;

  return impl.preview(
    {
      grid,
      anchor,
      clip,
      brush: { radius, shape },
      // Previews never write, so the rest of the context is inert filler: no preview may
      // resolve a palette slot, and the block/mode fields exist only for ops.
      block: '',
      stampMode: 'merge',
      familyMode: false,
      resolveBlock: () => -1,
    },
    hover,
  );
}
