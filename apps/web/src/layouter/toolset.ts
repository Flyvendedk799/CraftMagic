/**
 * The layouter's tools, and the keys that select them.
 *
 * Same arrangement as the voxel editor's `toolset.ts`: one list, read by the tool rail, by the
 * page's digit handler and by the shortcut sheet, so a new tool is a row here rather than
 * three edits that have to agree. The vocabulary is the difference — these are architectural
 * elements, not brush shapes, and each one is a thing that stays a thing after it is drawn.
 */

export type LayoutToolId =
  | 'select'
  | 'room'
  | 'wall'
  | 'door'
  | 'window'
  | 'stair'
  | 'opening'
  | 'platform'
  | 'column'
  | 'furnish'
  | 'place';

export interface LayoutToolSpec {
  id: LayoutToolId;
  label: string;
  /** What the pointer does — a rail of nine icons explains nothing on its own. */
  hint: string;
  /** Drag-to-draw tools show a live rectangle; click-to-place tools show a ghost. */
  gesture: 'drag' | 'click';
  /** The one-line readout under the plan. */
  verb: string;
  key: string;
}

export const LAYOUT_TOOLS: readonly LayoutToolSpec[] = [
  {
    id: 'select',
    label: 'Select',
    hint: 'Click to select, drag to move, drag a corner to resize. Shift-click or rubber-band the empty plan to pick several, then align them.',
    gesture: 'click',
    verb: 'select',
    key: '1',
  },
  {
    id: 'room',
    label: 'Room',
    hint: 'Drag out a room. Edges snap to neighbouring rooms so they share one wall.',
    gesture: 'drag',
    verb: 'draw a room',
    key: '2',
  },
  {
    id: 'wall',
    label: 'Wall',
    hint: 'Drag a partition. It straightens to whichever axis you dragged furthest along.',
    gesture: 'drag',
    verb: 'draw a wall',
    key: '3',
  },
  {
    id: 'door',
    label: 'Door',
    hint: 'Click near a wall. The doorway jumps into it and takes its facing.',
    gesture: 'click',
    verb: 'cut a doorway',
    key: '4',
  },
  {
    id: 'window',
    label: 'Window',
    hint: 'Click near a wall. Sill height and size are in the inspector.',
    gesture: 'click',
    verb: 'cut a window',
    key: '5',
  },
  {
    id: 'stair',
    label: 'Stair',
    hint: 'Click where the bottom step goes. It climbs one storey and cuts its own well.',
    gesture: 'click',
    verb: 'place a staircase',
    key: '6',
  },
  {
    id: 'opening',
    label: 'Void',
    hint: 'Drag a hole in this floor — an atrium, a light well, a mezzanine edge.',
    gesture: 'drag',
    verb: 'cut a floor void',
    key: '7',
  },
  {
    id: 'platform',
    label: 'Platform',
    hint: 'Drag a raised floor — a dais, a stage, a split level.',
    gesture: 'drag',
    verb: 'raise a platform',
    key: '8',
  },
  {
    id: 'column',
    label: 'Column',
    hint: 'Click to drop a structural post through the storey.',
    gesture: 'click',
    verb: 'place a column',
    key: '9',
  },
  {
    id: 'place',
    label: 'Place',
    hint: 'Drop a saved build from your library. Pick one in the Components panel, then click where it goes. R turns it.',
    gesture: 'click',
    verb: 'place a saved build',
    key: 'p',
  },
  {
    id: 'furnish',
    label: 'Furnish',
    hint: 'Click to place a piece from the catalogue. Which piece, and its facing, are in the inspector.',
    gesture: 'click',
    verb: 'place furniture',
    key: '0',
  },
];

export const LAYOUT_TOOL_BY_ID: Readonly<Record<LayoutToolId, LayoutToolSpec>> = Object.fromEntries(
  LAYOUT_TOOLS.map((tool) => [tool.id, tool]),
) as Record<LayoutToolId, LayoutToolSpec>;

export function layoutToolForKey(key: string): LayoutToolId | undefined {
  return LAYOUT_TOOLS.find((tool) => tool.key === key)?.id;
}
