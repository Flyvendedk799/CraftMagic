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
import { WORLD_TOOLS, WORLD_TOOL_GROUPS } from './toolset.js';

const toolRows = (group: string) =>
  WORLD_TOOLS.filter((tool) => tool.group === group).map((tool) => ({
    keys: tool.key,
    what: tool.label,
  }));

export const WORLD_SHORTCUTS: readonly ShortcutGroup[] = [
  ...WORLD_TOOL_GROUPS.map((group) => ({ title: group.label, rows: toolRows(group.id) })),
  {
    title: 'The brush',
    rows: [
      { keys: '[  ]', what: 'Smaller / bigger brush' },
      { keys: 'Shift + [  ]', what: 'Weaker / stronger brush' },
      { keys: 'Ctrl + drag', what: 'Raise and Lower swap while Ctrl is held' },
      { keys: 'Alt + click', what: 'Flatten and Carve take the height there; Paint takes the ground' },
    ],
  },
  {
    title: 'Placed buildings',
    rows: [
      { keys: 'Click', what: 'Select (Select tool) — right-click selects from any tool' },
      { keys: 'Double-click', what: 'Open its blocks in Build' },
      { keys: 'Arrows', what: 'Nudge one block — Shift for eight' },
      { keys: 'Alt + drag', what: 'Move off the 4-block grid' },
      { keys: 'R  /  Shift + R', what: 'Turn right / left — the armed component too, before it drops' },
      { keys: 'Ctrl + D', what: 'Duplicate' },
      { keys: 'Delete', what: 'Remove' },
      { keys: 'Esc', what: 'Disarm Place, then clear the selection' },
    ],
  },
  {
    title: 'The view',
    rows: [
      { keys: 'Scroll', what: 'Zoom, keeping the column under the pointer under the pointer' },
      { keys: '+  /  −', what: 'Zoom in / out' },
      { keys: 'Space + drag', what: 'Pan the map, from any tool' },
      { keys: 'Shift + drag', what: 'Pan the map, from any tool' },
      { keys: 'Middle-drag', what: 'Pan the map' },
      { keys: 'F', what: 'Frame the selected building, or fit the whole map' },
    ],
  },
  {
    title: 'Editing',
    rows: [
      { keys: 'Ctrl + Z', what: 'Undo — one entry per stroke, not per frame of a drag' },
      { keys: 'Ctrl + Shift + Z', what: 'Redo' },
      { keys: 'Ctrl + Y', what: 'Redo' },
      { keys: 'Ctrl + S', what: 'Save the map' },
      { keys: '?', what: 'This sheet' },
    ],
  },
];
