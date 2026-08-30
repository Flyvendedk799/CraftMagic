/**
 * One glyph per tool.
 *
 * Drawn rather than fetched, and drawn as strokes on a 20-unit grid so they inherit
 * `currentColor` and stay legible when a selected tool flips to a mint background. Nine words
 * in a row read as a list of nine equally-weighted things; a shape read first and a word read
 * second is what lets someone find Erase without reading Place, Fill, Box and Swap on the way.
 *
 * The vocabulary is deliberately narrow: the same cube for the tools that put blocks down, the
 * same dashed outline for the ones that select, and arrows only where something is genuinely
 * being exchanged. An icon set where every glyph is inventive is a set nobody can scan.
 */

import type { ToolId } from './toolset.js';

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinejoin: 'round' as const,
};

/** The isometric cube the drawing tools share. */
const CUBE = 'M10 2.6 16.6 6.3v7.4L10 17.4 3.4 13.7V6.3z';

const PATHS: Readonly<Record<ToolId, JSX.Element>> = {
  place: (
    <>
      <path d={CUBE} />
      <path d="M3.4 6.3 10 10l6.6-3.7M10 10v7.4" />
    </>
  ),
  // The same cube, dashed and struck through: erase is place's negative, and the glyphs say so.
  erase: (
    <>
      <path d={CUBE} strokeDasharray="2.6 2.4" />
      <path d="M6.4 13.6 13.6 6.4" strokeLinecap="round" />
    </>
  ),
  line: (
    <>
      <path d="M5.6 14.4 14.4 5.6" strokeLinecap="round" />
      <circle cx="4.4" cy="15.6" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="15.6" cy="4.4" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),
  pick: (
    <>
      <path d="M13.2 3.4a2 2 0 0 1 2.8 2.8l-1.3 1.3-2.8-2.8z" strokeLinecap="round" />
      <path d="M11.9 4.7 5.2 11.4l-1.4 4.2 4.2-1.4 6.7-6.7" strokeLinecap="round" />
    </>
  ),
  select: (
    <>
      <rect x="3.2" y="3.2" width="13.6" height="13.6" rx="1" strokeDasharray="3 2.6" />
      <rect x="7.4" y="7.4" width="5.2" height="5.2" rx="0.6" />
    </>
  ),
  // Four cells holding together — a connected structure, which is what Grab takes.
  grab: (
    <>
      <rect x="8" y="2.8" width="4.4" height="4.4" />
      <rect x="8" y="7.2" width="4.4" height="4.4" />
      <rect x="3.6" y="11.6" width="4.4" height="4.4" />
      <rect x="12.4" y="11.6" width="4.4" height="4.4" />
    </>
  ),
  stamp: (
    <>
      <rect x="3" y="3" width="9.6" height="9.6" rx="1" strokeDasharray="3 2.4" />
      <rect x="7.4" y="7.4" width="9.6" height="9.6" rx="1" />
    </>
  ),
  fill: (
    <>
      <path d="M4.2 9.4 9.4 4.2l6 6-5.2 5.2a1.6 1.6 0 0 1-2.3 0l-3.7-3.7a1.6 1.6 0 0 1 0-2.3z" />
      <path d="M7.6 6 6 4.4" strokeLinecap="round" />
      <path
        d="M16.8 13.6c0 1-.8 1.8-1.7 1.8s-1.7-.8-1.7-1.8c0-.9 1.7-2.8 1.7-2.8s1.7 1.9 1.7 2.8z"
        fill="currentColor"
        stroke="none"
      />
    </>
  ),
  swap: (
    <>
      <path d="M3.4 6.6h9.2l-2.6-2.6" strokeLinecap="round" />
      <path d="M16.6 13.4H7.4l2.6 2.6" strokeLinecap="round" />
    </>
  ),
};

export function ToolIcon({ tool }: { tool: ToolId }) {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" {...STROKE}>
      {PATHS[tool]}
    </svg>
  );
}
