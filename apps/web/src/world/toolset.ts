/**
 * World mode's tools, as data.
 *
 * The editor learned this lesson the hard way: its tools began as three parallel `switch`
 * statements over a mode string — one for the click, one for the drag, one for the preview —
 * and adding a tool meant remembering all three. `editor/tools/registry.ts` made each tool one
 * object instead. This is the same table for terrain, kept deliberately small: a world tool is
 * a brush over columns, so what varies between them is the label, the cursor, and which
 * controls make sense, not the plumbing.
 *
 * Which is also why the *behaviour* lives in `WorldMap`'s stroke path rather than here. Every
 * one of these tools is `stampDisc` with a different callback, and core already owns those
 * callbacks. A registry of one-line indirections would be ceremony.
 */

import type { WorldPlacement } from '@craftmagic/core';

export type WorldTool =
  | 'select'
  | 'pan'
  | 'raise'
  | 'lower'
  | 'level'
  | 'smooth'
  | 'paint'
  | 'carve'
  | 'place';

export interface WorldToolSpec {
  id: WorldTool;
  label: string;
  /** Single-key shortcut, matching the editor's and Architecture's number-row convention. */
  key: string;
  hint: string;
  /** Whether the brush controls apply — the panel hides what a tool cannot use. */
  brush: boolean;
  /** Whether the tool needs a target height (the Leveler's plane, the Carve's ceiling). */
  target: boolean;
  /** Whether the tool needs a ground material. */
  stratum: boolean;
}

/**
 * The two named in the brief are `raise`/`lower` (the Leveler) and `paint` (the Terrainer).
 *
 * `smooth` is here rather than deferred because raise and lower alone produce spiky garbage
 * that reads as a broken tool — smoothing is what makes a hill look like a hill. `level` is
 * what makes a buildable pad, which every placement wants. Neither is a nicety.
 */
export const WORLD_TOOLS: readonly WorldToolSpec[] = [
  { id: 'select', label: 'Select', key: '1', hint: 'Pick and drag a placed build', brush: false, target: false, stratum: false },
  { id: 'raise', label: 'Raise', key: '2', hint: 'Leveler — pull ground up into hills', brush: true, target: false, stratum: false },
  { id: 'lower', label: 'Lower', key: '3', hint: 'Leveler — push ground down into valleys', brush: true, target: false, stratum: false },
  { id: 'level', label: 'Flatten', key: '4', hint: 'Level towards a height — a buildable pad', brush: true, target: true, stratum: false },
  { id: 'smooth', label: 'Smooth', key: '5', hint: 'Average towards the neighbourhood', brush: true, target: false, stratum: false },
  { id: 'paint', label: 'Terrainer', key: '6', hint: 'Paint ground material along a drag', brush: true, target: false, stratum: true },
  { id: 'carve', label: 'Carve', key: '7', hint: 'Cut caves, tunnels and overhangs', brush: true, target: true, stratum: false },
  { id: 'place', label: 'Place', key: '8', hint: 'Drop the selected component', brush: false, target: false, stratum: false },
  { id: 'pan', label: 'Pan', key: '9', hint: 'Drag the map (or hold Shift with any tool)', brush: false, target: false, stratum: false },
];

export function toolSpec(id: WorldTool): WorldToolSpec {
  return WORLD_TOOLS.find((tool) => tool.id === id) ?? WORLD_TOOLS[0]!;
}

/**
 * A placement's footprint on the map, with its rotation applied.
 *
 * A quarter turn swaps width and depth, and `x`/`z` are documented as the min corner of the
 * *turned* footprint — so the map must ask for the turned size rather than drawing the saved
 * one. Getting this wrong is invisible until somebody rotates a long building and the box
 * stops matching the blocks.
 */
export function placementFootprint(placement: WorldPlacement): { x: number; z: number; w: number; d: number } {
  const turned = placement.turns === 1 || placement.turns === 3;
  return {
    x: placement.x,
    z: placement.z,
    w: turned ? placement.d : placement.w,
    d: turned ? placement.w : placement.d,
  };
}
