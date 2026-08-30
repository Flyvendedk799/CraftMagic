/**
 * The tools, what a drag does with each, and the keys that select them.
 *
 * One list, read by the palette (labels, groups and hints), the page (the number-key handler)
 * and the shortcut sheet. It used to be two — a `TOOL_KEYS` map beside the page's key handler
 * and a `TOOLS` array inside the palette — with a comment admitting that both were wrong the
 * moment they disagreed.
 *
 * **Digits never move.** The first five have had their numbers since there were five tools,
 * and `group` reorders the palette without touching them: a shortcut that silently changes
 * under someone's fingers is worse than one that was never advertised. The badge is small and
 * dim for the same reason — it is a reminder, not a ranking.
 *
 * `drag` is the interesting field, and it exists because nine buttons that all look alike were
 * hiding the fact that they do three different kinds of thing.
 */

export type ToolId = 'place' | 'erase' | 'fill' | 'select' | 'swap' | 'line' | 'stamp' | 'pick' | 'grab';

/**
 * The three things a tool can be.
 *
 * Not decoration. `draw` puts blocks where you point, `select` chooses something and then
 * offers verbs for it, and `replace` rewrites blocks that already exist by identity rather
 * than by position. A flat row of nine made Swap look like a sibling of Place, which it is
 * not — one is a brush and the other is find-and-replace across the whole build.
 */
export type ToolGroup = 'draw' | 'select' | 'replace';

export const TOOL_GROUPS: readonly { id: ToolGroup; label: string; hint: string }[] = [
  { id: 'draw', label: 'Draw', hint: 'Put blocks where you point' },
  { id: 'select', label: 'Select', hint: 'Choose part of the build, then act on it' },
  { id: 'replace', label: 'Replace', hint: 'Rewrite blocks that are already there' },
];

/**
 * What a primary drag starting on the build means for this tool.
 *
 * - `stroke`   every cell the drag crosses, as one edit — painting.
 * - `endpoints` the cell it started on and the cell it ended on — a straight run.
 * - `region`   a box drawn or moved; the canvas owns this one.
 * - `none`     nothing; the drag belongs to the camera, as it always did.
 *
 * The default used to be `none` for everything, with painting hidden behind Shift. That is
 * backwards from every other tool anyone has used, and it is the first thing a new user tries.
 */
export type ToolDrag = 'stroke' | 'endpoints' | 'region' | 'none';

export interface ToolSpec {
  id: ToolId;
  label: string;
  group: ToolGroup;
  /** What a click does — the palette is not self-explanatory and a legend is cheaper than guessing. */
  hint: string;
  /** Erase and pick need no block; showing the picker for them would imply otherwise. */
  needsBlock: boolean;
  /** True for tools whose size the brush controls. */
  usesBrush: boolean;
  /** What a click does, in two or three words, for the one-line readout under the build. */
  verb: string;
  /** What a drag does, in the same voice. Null when the drag still belongs to the camera. */
  dragVerb: string | null;
  drag: ToolDrag;
  /** Number key that selects it. Shown on the button, because an unadvertised shortcut is none. */
  key: string;
}

export const TOOLS: readonly ToolSpec[] = [
  {
    id: 'place',
    group: 'draw',
    verb: 'place a block',
    dragVerb: 'paint',
    drag: 'stroke',
    label: 'Place',
    hint: 'Click a face to add a block against it, or drag to paint a run of them.',
    needsBlock: true,
    usesBrush: true,
    key: '1',
  },
  {
    id: 'erase',
    group: 'draw',
    verb: 'erase a block',
    dragVerb: 'erase a run',
    drag: 'stroke',
    label: 'Erase',
    hint: 'Click a block to remove it, or drag to clear a run.',
    needsBlock: false,
    usesBrush: true,
    key: '2',
  },
  {
    id: 'line',
    group: 'draw',
    verb: 'set a line end',
    dragVerb: 'draw a line',
    drag: 'endpoints',
    label: 'Line',
    hint: 'Drag from one end of a straight run to the other — beams, frames, rooflines. Two clicks work too.',
    needsBlock: true,
    usesBrush: true,
    key: '6',
  },
  {
    id: 'pick',
    group: 'draw',
    verb: 'pick that block',
    dragVerb: null,
    drag: 'none',
    label: 'Pick',
    hint: 'Click a block to make it the active one. Alt-click does this from any tool.',
    needsBlock: false,
    usesBrush: false,
    key: '8',
  },
  {
    id: 'select',
    group: 'select',
    verb: 'drag out a selection',
    dragVerb: 'draw a box',
    drag: 'region',
    label: 'Box',
    hint: 'Drag across the build to select a box. Drag inside one to move it. The box stays, so you can fill it, hollow it, rotate it or copy it — as many times as you like.',
    needsBlock: true,
    usesBrush: false,
    key: '4',
  },
  {
    id: 'grab',
    group: 'select',
    verb: 'select a structure',
    dragVerb: null,
    drag: 'none',
    label: 'Grab',
    hint: 'Click any block to select the whole connected structure — a tree, a statue, a chimney. Nothing moves until you drag it or press Cut.',
    needsBlock: false,
    usesBrush: false,
    key: '9',
  },
  {
    id: 'stamp',
    group: 'select',
    verb: 'stamp the clipboard',
    dragVerb: null,
    drag: 'none',
    label: 'Stamp',
    hint: 'Paste the clipboard. Copy something with the Box tool first.',
    needsBlock: false,
    usesBrush: false,
    key: '7',
  },
  {
    id: 'fill',
    group: 'replace',
    verb: 'flood fill',
    dragVerb: null,
    drag: 'none',
    label: 'Fill',
    hint: 'Click to repaint every connected block of the same kind.',
    needsBlock: true,
    usesBrush: false,
    key: '3',
  },
  {
    id: 'swap',
    group: 'replace',
    verb: 'swap that block everywhere',
    dragVerb: null,
    drag: 'none',
    label: 'Swap',
    hint: 'Click a block to replace every one like it in the whole build.',
    needsBlock: true,
    usesBrush: false,
    key: '5',
  },
];

export const TOOL_BY_ID: Readonly<Record<ToolId, ToolSpec>> = Object.fromEntries(
  TOOLS.map((tool) => [tool.id, tool]),
) as Record<ToolId, ToolSpec>;

/** The tools of one group, in palette order. */
export function toolsInGroup(group: ToolGroup): ToolSpec[] {
  return TOOLS.filter((tool) => tool.group === group);
}

/** The tool a digit selects, or undefined for any other key. */
export function toolForKey(key: string): ToolId | undefined {
  return TOOLS.find((tool) => tool.key === key)?.id;
}
