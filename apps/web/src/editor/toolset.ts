/**
 * The tools, and the keys that select them.
 *
 * One list, read by the palette (labels and hints), the page (the number-key handler) and
 * the shortcut sheet. It used to be two — a `TOOL_KEYS` map beside the page's key handler
 * and a `TOOLS` array inside the palette — with a comment admitting that both were wrong
 * the moment they disagreed. Adding three tools was going to be the moment.
 *
 * Order is the order they appear in the palette, and the digits follow it. The first five
 * keep the numbers they have always had: the palette grew at the end rather than being
 * regrouped, because a shortcut that silently moves is worse than one that was never there.
 */

export type ToolId = 'place' | 'erase' | 'fill' | 'select' | 'swap' | 'line' | 'stamp' | 'pick';

export interface ToolSpec {
  id: ToolId;
  label: string;
  /** What a click does — the palette is not self-explanatory and a legend is cheaper than guessing. */
  hint: string;
  /** Erase and pick need no block; showing the picker for them would imply otherwise. */
  needsBlock: boolean;
  /** True for tools whose size the brush controls. */
  usesBrush: boolean;
  /** What a click does, in two or three words, for the one-line readout under the build. */
  verb: string;
  /** Number key that selects it. Shown on the button, because an unadvertised shortcut is none. */
  key: string;
}

export const TOOLS: readonly ToolSpec[] = [
  {
    id: 'place',
    verb: 'place a block',
    label: 'Place',
    hint: 'Click a face to add a block against it. Shift-drag to keep placing.',
    needsBlock: true,
    usesBrush: true,
    key: '1',
  },
  {
    id: 'erase',
    verb: 'erase a block',
    label: 'Erase',
    hint: 'Click a block to remove it. Shift-drag to keep erasing.',
    needsBlock: false,
    usesBrush: true,
    key: '2',
  },
  {
    id: 'fill',
    verb: 'flood fill',
    label: 'Fill',
    hint: 'Click to repaint every connected block of the same kind.',
    needsBlock: true,
    usesBrush: false,
    key: '3',
  },
  {
    id: 'select',
    verb: 'set a box corner',
    label: 'Box',
    hint: 'Click two opposite corners.',
    needsBlock: true,
    usesBrush: false,
    key: '4',
  },
  {
    id: 'swap',
    verb: 'swap that block everywhere',
    label: 'Swap',
    hint: 'Click a block to replace it everywhere in the build.',
    needsBlock: true,
    usesBrush: false,
    key: '5',
  },
  {
    id: 'line',
    verb: 'set a line end',
    label: 'Line',
    hint: 'Click both ends of a straight run — beams, frames, rooflines.',
    needsBlock: true,
    usesBrush: true,
    key: '6',
  },
  {
    id: 'stamp',
    verb: 'stamp the clipboard',
    label: 'Stamp',
    hint: 'Paste the clipboard. Copy something with the Box tool first.',
    needsBlock: false,
    usesBrush: false,
    key: '7',
  },
  {
    id: 'pick',
    verb: 'pick that block',
    label: 'Pick',
    hint: 'Click a block to make it the active one. Alt-click does this from any tool.',
    needsBlock: false,
    usesBrush: false,
    key: '8',
  },
];

export const TOOL_BY_ID: Readonly<Record<ToolId, ToolSpec>> = Object.fromEntries(
  TOOLS.map((tool) => [tool.id, tool]),
) as Record<ToolId, ToolSpec>;

/** The tool a digit selects, or undefined for any other key. */
export function toolForKey(key: string): ToolId | undefined {
  return TOOLS.find((tool) => tool.key === key)?.id;
}
