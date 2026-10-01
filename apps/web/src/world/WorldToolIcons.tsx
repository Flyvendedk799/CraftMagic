/**
 * One glyph per World tool, in the same hand as Build's `ToolIcons`.
 *
 * World's palette was nine words in a grid while Build's was icons over words, so the two modes
 * that share a header read as two different products — and nine words is a list you read, not a
 * set of shapes you find. Same 20-unit grid, same 1.5 stroke, same `currentColor`, so a selected
 * tool flipping to the accent background stays legible here exactly as it does there.
 *
 * The shape tools share one vocabulary — a ground line, and what happens to it — so Raise and
 * Lower read as a pair and Flatten as their middle, without anyone having to read the labels.
 */

import type { WorldTool } from './toolset.js';

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const PATHS: Readonly<Record<WorldTool, JSX.Element>> = {
  raise: (
    <>
      <path d="M2.5 16.5h15" />
      <path d="M3.5 16.5c2-4.6 4.2-6.6 6.5-6.6s4.5 2 6.5 6.6" />
      <path d="M10 7.2V2.8M8 4.8l2-2 2 2" />
    </>
  ),
  lower: (
    <>
      <path d="M2.5 9.5h2.2M15.3 9.5h2.2" />
      <path d="M4.7 9.5c1.6 4.4 3.4 6.4 5.3 6.4s3.7-2 5.3-6.4" />
      <path d="M10 2.8v4.4M8 5.2l2 2 2-2" />
    </>
  ),
  level: (
    <>
      <path d="M2.5 13h15" />
      <path d="M2.5 16.5h15" strokeDasharray="1.6 2" />
      <path d="M6 3.5v6M4.4 7.9 6 9.5l1.6-1.6M14 3.5v6M12.4 7.9 14 9.5l1.6-1.6" />
    </>
  ),
  smooth: (
    <>
      <path d="M2.5 9c2.5-4 5-4 7.5 0s5 4 7.5 0" strokeDasharray="1.8 1.8" />
      <path d="M2.5 14.5c2.5-1.6 5-1.6 7.5 0s5 1.6 7.5 0" />
    </>
  ),
  paint: (
    <>
      <path d="M9.4 12.4 16 5.8a1.5 1.5 0 0 0-2.1-2.1L7.3 10.3" />
      <path d="M3.4 16.6c.3-1.9.9-3.9 2.9-4.1a2 2 0 0 1 2.2 2.2c-.2 2-2.6 2-5.1 1.9z" />
    </>
  ),
  carve: (
    <>
      <path d="M2.5 6h15M2.5 16.5h15" />
      <path d="M5.5 16.5v-4a4.5 4.5 0 0 1 9 0v4" strokeDasharray="2 1.8" />
    </>
  ),
  select: <path d="M5 3l9.5 6.6-4.3 1 2.5 4.6-1.9 1-2.4-4.6L5 14.7z" />,
  place: (
    <>
      <path d="M3.2 8.2 10 3l6.8 5.2" />
      <path d="M4.6 7.4v9.1h10.8V7.4" />
      <path d="M8.2 16.5v-4.2h3.6v4.2" />
    </>
  ),
  pan: (
    <>
      <path d="M10 2.6v14.8M2.6 10h14.8" />
      <path d="M8.1 4.5 10 2.6l1.9 1.9M8.1 15.5l1.9 1.9 1.9-1.9M4.5 8.1 2.6 10l1.9 1.9M15.5 8.1l1.9 1.9-1.9 1.9" />
    </>
  ),
};

export function WorldToolIcon({ tool }: { tool: WorldTool }) {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" {...STROKE}>
      {PATHS[tool]}
    </svg>
  );
}

/** The small glyphs the stage bar and the selection toolbar use. */
export type ActionGlyph = 'undo' | 'redo' | 'rotate' | 'copy' | 'open' | 'trash' | 'plus' | 'minus' | 'fit';

const GLYPHS: Readonly<Record<ActionGlyph, JSX.Element>> = {
  undo: <path d="M7.5 5.5 4 9l3.5 3.5M4.5 9h7.5a4 4 0 0 1 0 8H9" />,
  redo: <path d="M12.5 5.5 16 9l-3.5 3.5M15.5 9H8a4 4 0 0 0 0 8h3" />,
  rotate: <path d="M15.6 9.5a5.8 5.8 0 1 1-1.9-4.3M15.8 2.8v3.6h-3.6" />,
  copy: (
    <>
      <rect x="7" y="7" width="9.5" height="9.5" rx="1.2" />
      <path d="M13 7V4.7c0-.7-.5-1.2-1.2-1.2H4.7c-.7 0-1.2.5-1.2 1.2v7.1c0 .7.5 1.2 1.2 1.2H7" />
    </>
  ),
  open: <path d="M11.5 3.5h5v5M16.5 3.5 9.5 10.5M14.5 12v3.3c0 .7-.5 1.2-1.2 1.2H4.7c-.7 0-1.2-.5-1.2-1.2V6.7c0-.7.5-1.2 1.2-1.2H8" />,
  trash: <path d="M3.5 5.5h13M8 5.5V3.8h4v1.7M5.2 5.5l.8 11h8l.8-11M8.4 8.5v5M11.6 8.5v5" />,
  plus: <path d="M10 4v12M4 10h12" />,
  minus: <path d="M4 10h12" />,
  fit: <path d="M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4" />,
};

export function ActionIcon({ glyph, size = 14 }: { glyph: ActionGlyph; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" {...STROKE}>
      {GLYPHS[glyph]}
    </svg>
  );
}
