/**
 * What the voxel editor's keyboard does, as the sheet reads it.
 *
 * Split out of `ShortcutHelp` when Architecture mode grew a sheet of its own: the dialog is shared
 * and the content is not, and a list of what *this* tool's keys do belongs beside this tool.
 * The tool digits are derived from `toolset.ts` — those genuinely cannot drift — and
 * everything else is written by hand, because the description is the part with the value in
 * it and no handler can produce one.
 */

import type { ShortcutGroup } from './ShortcutHelp.js';
import { TOOL_GROUPS, toolsInGroup } from './toolset.js';

export const EDITOR_SHORTCUTS: readonly ShortcutGroup[] = [
  // Grouped the way the palette is, and by the same argument: a flat list of nine digits is
  // a lookup table, while three short lists are something a person can hold in their head.
  ...TOOL_GROUPS.map((group) => ({
    title: group.label,
    rows: toolsInGroup(group.id).map((tool) => ({ keys: tool.key, what: tool.label })),
  })),
  {
    title: 'The pointer',
    rows: [
      { keys: 'Drag on the build', what: 'Whatever the tool does — paint, erase, a line, a box, one block carried' },
      { keys: 'Click', what: 'The same thing, once' },
      { keys: 'Drag on the sky', what: 'Orbit' },
      { keys: 'Right-drag', what: 'Orbit from anywhere, including over the build' },
      { keys: 'Middle-drag', what: 'Pan' },
      { keys: 'Scroll', what: 'Zoom' },
    ],
  },
  {
    title: 'Editing',
    rows: [
      { keys: 'Grab tool, drag a block', what: 'Move that one block on its own, wherever you drop it' },
      { keys: 'Grab tool, click a block', what: 'Select the whole connected structure instead' },
      { keys: 'Alt + click', what: 'Pick the block under the pointer, from any tool' },
      { keys: 'Shift + drag', what: 'Paint even where the press missed the build — onto the ground plane' },
      { keys: 'Esc', what: 'Cancel the corner in progress' },
      { keys: 'Ctrl + Z', what: 'Undo' },
      { keys: 'Ctrl + Shift + Z', what: 'Redo' },
    ],
  },
  {
    title: 'Brush',
    rows: [
      { keys: '− / +', what: 'Smaller or larger brush' },
      { keys: 'B', what: 'Switch the brush between round and square' },
    ],
  },
  {
    title: 'Clipboard',
    rows: [
      { keys: 'Box tool, two corners', what: 'Select a region — it stays until you dismiss it' },
      { keys: 'Esc', what: 'Dismiss the region, or the corner in progress' },
      { keys: 'Region → Copy', what: 'Copy the region to the clipboard' },
      { keys: 'R', what: 'Rotate the clipboard 90°, block states and all' },
      { keys: 'M / Shift+M', what: 'Mirror the clipboard east–west / north–south' },
    ],
  },
  {
    title: 'View',
    rows: [
      { keys: '[ / ]', what: 'Lower or raise the layer cut' },
      { keys: '\\', what: 'Show every layer again' },
      { keys: 'I', what: 'Isolate the cut layer — show that slice alone' },
      { keys: 'F', what: 'Frame the whole build' },
      { keys: 'Drag / scroll', what: 'Orbit and zoom' },
      { keys: '?', what: 'This list' },
    ],
  },
];

export const EDITOR_SHORTCUT_FOOT =
  'Shortcuts are ignored while you are typing, so the prompt box keeps its own keys.';
