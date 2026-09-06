/**
 * What World mode's keyboard does.
 *
 * World shipped with nine keyed tools and no sheet at all — the shortcut dialog is shared, and
 * this was the mode that supplied it nothing. So the digits were printed on the buttons and
 * everything else about the pointer was undiscoverable: that the wheel zooms to the cursor,
 * that Shift pans from any tool, that Undo is bound here too.
 *
 * The terrain tools are grouped the way the panel groups them, because a flat list of nine is a
 * lookup table and three short lists are something a person can hold in their head — the same
 * argument the editor's sheet makes.
 */

import type { ShortcutGroup } from '../editor/ShortcutHelp.js';
import { WORLD_TOOLS } from './toolset.js';

const toolRows = (ids: readonly string[]) =>
  WORLD_TOOLS.filter((tool) => ids.includes(tool.id)).map((tool) => ({
    keys: tool.key,
    what: tool.label,
  }));

export const WORLD_SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: 'Shaping the ground',
    rows: toolRows(['raise', 'lower', 'level', 'smooth']),
  },
  {
    title: 'Painting and cutting',
    rows: toolRows(['paint', 'carve']),
  },
  {
    title: 'Placing and moving',
    rows: toolRows(['select', 'place', 'pan']),
  },
  {
    title: 'The pointer',
    rows: [
      { keys: 'Drag', what: 'Whatever the tool does — the brush paints along the whole stroke' },
      { keys: 'Shift + drag', what: 'Pan the map, from any tool' },
      { keys: 'Middle-drag', what: 'Pan the map' },
      { keys: 'Scroll', what: 'Zoom, keeping the column under the pointer under the pointer' },
    ],
  },
  {
    title: 'Editing',
    rows: [
      { keys: 'Ctrl + Z', what: 'Undo — one entry per stroke, not per frame of a drag' },
      { keys: 'Ctrl + Shift + Z', what: 'Redo' },
      { keys: 'Ctrl + Y', what: 'Redo' },
    ],
  },
];
