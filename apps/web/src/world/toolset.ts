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

export type WorldToolGroup = 'shape' | 'surface' | 'arrange';

export interface WorldToolSpec {
  id: WorldTool;
  label: string;
  /** Single-key shortcut, matching the editor's and Architecture's number-row convention. */
  key: string;
  /** Which family the panel files it under, the way Build groups Draw / Select / Replace. */
  group: WorldToolGroup;
  hint: string;
  /**
   * What the modifier keys do with this tool, in one line, or null when they do nothing.
   *
   * Said under the hint rather than only on the shortcut sheet: Ctrl-to-invert and
   * Alt-to-sample are the gestures that save a trip to the panel on every stroke, and a
   * gesture nobody has been told about is one nobody uses.
   */
  modifiers: string | null;
  /** Whether the brush controls apply — the panel hides what a tool cannot use. */
  brush: boolean;
  /** Whether the tool needs a target height (the Leveler's plane, the Carve's ceiling). */
  target: boolean;
  /** Whether the tool needs a ground material. */
  stratum: boolean;
}

export const WORLD_TOOL_GROUPS: readonly { id: WorldToolGroup; label: string }[] = [
  { id: 'shape', label: 'Shape the ground' },
  { id: 'surface', label: 'Surface' },
  { id: 'arrange', label: 'Arrange' },
];

/**
 * The two named in the brief are `raise`/`lower` (the Leveler) and `paint` (the Terrainer).
 *
 * `smooth` is here rather than deferred because raise and lower alone produce spiky garbage
 * that reads as a broken tool — smoothing is what makes a hill look like a hill. `level` is
 * what makes a buildable pad, which every placement wants. Neither is a nicety.
 *
 * The digits stay where they were when the panel was a flat list. The groups reorder what you
 * see, not where your fingers already are — the same call Build's palette made.
 */
export const WORLD_TOOLS: readonly WorldToolSpec[] = [
  { id: 'raise', label: 'Raise', key: '2', group: 'shape', hint: 'Pull ground up into hills — drag over the same spot to build it higher', modifiers: 'Hold Ctrl to lower instead', brush: true, target: false, stratum: false },
  { id: 'lower', label: 'Lower', key: '3', group: 'shape', hint: 'Push ground down into valleys and basins', modifiers: 'Hold Ctrl to raise instead', brush: true, target: false, stratum: false },
  { id: 'level', label: 'Flatten', key: '4', group: 'shape', hint: 'Level towards a height — a buildable pad', modifiers: 'Alt-click the map to take its height as the target', brush: true, target: true, stratum: false },
  { id: 'smooth', label: 'Smooth', key: '5', group: 'shape', hint: 'Average towards the neighbourhood — softens spikes and cliffs', modifiers: null, brush: true, target: false, stratum: false },
  { id: 'paint', label: 'Paint', key: '6', group: 'surface', hint: 'The Terrainer — paint ground material along a drag', modifiers: 'Alt-click the map to pick up the ground under it', brush: true, target: false, stratum: true },
  { id: 'carve', label: 'Carve', key: '7', group: 'surface', hint: 'Cut caves, tunnels and overhangs down from the ceiling height', modifiers: 'Alt-click the map to set the ceiling from its height', brush: true, target: true, stratum: false },
  { id: 'select', label: 'Select', key: '1', group: 'arrange', hint: 'Click a placed build to select it, drag to move it', modifiers: 'Hold Alt while dragging to leave the 4-block grid', brush: false, target: false, stratum: false },
  { id: 'place', label: 'Place', key: '8', group: 'arrange', hint: 'Click the map to drop the armed component', modifiers: 'R turns it before you drop it · Esc disarms', brush: false, target: false, stratum: false },
  { id: 'pan', label: 'Pan', key: '9', group: 'arrange', hint: 'Drag the map around', modifiers: 'Hold Space (or Shift) to pan from any tool', brush: false, target: false, stratum: false },
];

/** Whether the tool paints with the brush ring — every terrain tool, none of the arranging ones. */
export function isBrushTool(tool: WorldTool): boolean {
  return toolSpec(tool).brush;
}

export function toolSpec(id: WorldTool): WorldToolSpec {
  return WORLD_TOOLS.find((tool) => tool.id === id) ?? WORLD_TOOLS[0]!;
}

/**
 * Where a component dropped at a column lands: centred on it, kept on the map.
 *
 * Centred rather than cornered, because you aim a building at where you want it to stand, not
 * at where its north-west corner should go. Shared by the drop and by the ghost the map draws
 * before it, so the outline under the pointer is exactly where the building will be.
 */
export function dropCorner(
  cx: number,
  cz: number,
  footprint: { w: number; d: number },
  size: { x: number; z: number },
): { x: number; z: number } {
  return {
    x: Math.max(0, Math.min(size.x - 1, Math.round(cx - footprint.w / 2))),
    z: Math.max(0, Math.min(size.z - 1, Math.round(cz - footprint.d / 2))),
  };
}

/**
 * Turn a placement a quarter about its own middle.
 *
 * `x`/`z` are the min corner of the *turned* footprint, so turning a long building by writing
 * only `turns` swings it round its north-west corner — it visibly jumps sideways. Moving the
 * corner by half the difference keeps the middle where it was, which is what a person rotating
 * a building on a map means.
 */
export function turnedAboutCentre(placement: WorldPlacement, by: 1 | -1): Pick<WorldPlacement, 'x' | 'z' | 'turns'> {
  const before = placementFootprint(placement);
  const turns = (((placement.turns + by) % 4) + 4) % 4 as WorldPlacement['turns'];
  const after = placementFootprint({ ...placement, turns });
  return {
    turns,
    x: Math.max(0, placement.x + Math.round((before.w - after.w) / 2)),
    z: Math.max(0, placement.z + Math.round((before.d - after.d) / 2)),
  };
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
