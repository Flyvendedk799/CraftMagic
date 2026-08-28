/**
 * What the layouter's keyboard does.
 *
 * The layouter is the more keyboard-driven of the two tools and was the one with nothing
 * advertising it: nine tool digits printed on their buttons, and then a whole second layer —
 * the storey brackets, the arrow-key nudge, copy and paste, fit — that existed and was
 * invisible. Half of what makes a drawing tool feel quick is knowing you never have to reach
 * for the pointer, and none of that was sayable from the panel.
 */

import type { ShortcutGroup } from '../editor/ShortcutHelp.js';
import { LAYOUT_TOOLS } from './toolset.js';

export const LAYOUTER_SHORTCUTS: readonly ShortcutGroup[] = [
  {
    title: 'Tools',
    rows: LAYOUT_TOOLS.map((tool) => ({ keys: tool.key, what: tool.label })),
  },
  {
    title: 'Drawing',
    rows: [
      { keys: 'Drag', what: 'Draw a room, wall, void or platform' },
      { keys: 'Click', what: 'Drop a door, window, stair or column' },
      { keys: 'Esc', what: 'Deselect, and clear the message under the plan' },
      { keys: 'Ctrl + Z', what: 'Undo — one entry per gesture, not per frame of a drag' },
      { keys: 'Ctrl + Shift + Z', what: 'Redo' },
    ],
  },
  {
    title: 'Selection',
    rows: [
      { keys: 'Shift + click', what: 'Add or remove one item from the selection' },
      { keys: 'Drag empty plan', what: 'Rubber-band everything the box encloses' },
      { keys: 'Ctrl + A', what: 'Select everything on this storey' },
      { keys: 'Arrows', what: 'Nudge the selection one block — all of it' },
      { keys: 'Ctrl + C', what: 'Copy the selection' },
      { keys: 'Ctrl + V', what: 'Paste onto the storey you are on' },
      { keys: 'Ctrl + D', what: 'Duplicate in place, offset by two blocks' },
      { keys: 'Delete', what: 'Remove the selection' },
    ],
  },
  {
    title: 'Storeys',
    rows: [
      { keys: '[ / ]', what: 'Down or up one storey' },
      { keys: 'Ctrl + C then [ then Ctrl + V', what: 'Take a room down a floor — the clipboard crosses storeys' },
    ],
  },
  {
    title: 'View',
    rows: [
      { keys: 'F', what: 'Frame the drawing' },
      { keys: 'V', what: 'Cycle the model: whole building, one storey, one room' },
      { keys: 'Scroll', what: 'Zoom about the pointer' },
      { keys: 'Middle / right drag', what: 'Pan' },
      { keys: '?', what: 'This list' },
      { keys: 'Esc', what: 'Close this list' },
    ],
  },
];

export const LAYOUTER_SHORTCUT_FOOT =
  'Shortcuts are ignored while you are typing, so a room name can contain a bracket.';
