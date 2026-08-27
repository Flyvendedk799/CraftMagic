/**
 * What the voxel editor's keyboard does, as the sheet reads it.
 *
 * Split out of `ShortcutHelp` when the layouter grew a sheet of its own: the dialog is shared
 * and the content is not, and a list of what *this* tool's keys do belongs beside this tool.
 * The tool digits are derived from `toolset.ts` — those genuinely cannot drift — and
 * everything else is written by hand, because the description is the part with the value in
 * it and no handler can produce one.
 */

import type { ShortcutGroup } from './ShortcutHelp.js';
import { TOOLS } from './toolset.js';

export const EDITOR_SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: 'Tools',
    rows: TOOLS.map((tool) => ({ keys: tool.key, what: tool.label })),
  },
  {
    title: 'Editing',
    rows: [
      { keys: 'Alt + click', what: 'Pick the block under the pointer, from any tool' },
      { keys: 'Shift + drag', what: 'Keep placing or erasing along the drag, as one undo step' },
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
      { keys: 'Box tool → Copy', what: 'Copy the region between two corners' },
      { keys: 'R', what: 'Rotate the clipboard 90°, block states and all' },
      { keys: 'M', what: 'Mirror the clipboard' },
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
