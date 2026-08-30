/**
 * What the Box tool does once you have a box.
 *
 * The tool used to ask for the verb before the noun: choose Fill, or Hollow, or Clear, *then*
 * click two corners, and the moment the second corner landed the edit had already happened.
 * That ordering is backwards for the case it is most used in. Aiming a box around the right
 * blocks is the hard part and the part you want to see before committing to anything, and
 * having seen it, the natural next thought is "and now replace it — no, hollow it" — each of
 * which meant re-aiming the box from scratch, because the box did not survive its own edit.
 *
 * So the two corners now make a *selection* that stays, and the verbs act on it and leave it
 * alone. Fill it, look, hollow it, look, nudge it a block and fill it again. The box is only
 * gone when it is dismissed.
 *
 * Move is the one verb that is not a fill by another name: it takes the contents somewhere
 * else and carries the box with them, which is the difference between "a region I am editing"
 * and "a thing I am holding".
 */

import type { BoxCorner } from './tools/boxSelect.js';

export type RegionAction =
  | 'fill'
  | 'replace'
  | 'hollow'
  | 'clear'
  | 'copy'
  | 'cut'
  | 'rotate'
  | 'mirrorX'
  | 'mirrorZ';

const ACTIONS: readonly { id: RegionAction; label: string; title: string }[] = [
  { id: 'fill', label: 'Fill', title: 'Every cell in the box becomes the active block' },
  {
    id: 'replace',
    label: 'Replace',
    title: 'Only cells that already hold something — re-skin a wall without filling the room',
  },
  { id: 'hollow', label: 'Hollow', title: 'The six faces of the box, leaving the inside as it is' },
  { id: 'clear', label: 'Clear', title: 'Empty the box' },
  { id: 'copy', label: 'Copy', title: 'Take the contents to the clipboard and switch to Stamp' },
  { id: 'cut', label: 'Cut', title: 'Copy the contents to the clipboard and empty the box' },
  { id: 'rotate', label: '↻ 90°', title: 'Rotate the contents in place, about the box centre' },
  { id: 'mirrorX', label: '⇋ X', title: 'Flip the contents east–west, in place' },
  { id: 'mirrorZ', label: '⇅ Z', title: 'Flip the contents north–south, in place' },
];

/** Label, then the axis and sign it nudges along. */
const NUDGES: readonly { label: string; title: string; d: [number, number, number] }[] = [
  { label: '−X', title: 'Move one block west', d: [-1, 0, 0] },
  { label: '+X', title: 'Move one block east', d: [1, 0, 0] },
  { label: '−Y', title: 'Move one block down', d: [0, -1, 0] },
  { label: '+Y', title: 'Move one block up', d: [0, 1, 0] },
  { label: '−Z', title: 'Move one block north', d: [0, 0, -1] },
  { label: '+Z', title: 'Move one block south', d: [0, 0, 1] },
];

export interface RegionPanelProps {
  region: { min: BoxCorner; max: BoxCorner } | null;
  /** First corner taken, second not yet — shown so a half-finished box is never a mystery. */
  anchor: BoxCorner | null;
  onCancelAnchor: () => void;
  onAction: (action: RegionAction) => void;
  onNudge: (dx: number, dy: number, dz: number) => void;
  /** Grow or shrink the box itself by one on every axis. The contents do not move. */
  onResize: (by: number) => void;
  onDeselect: () => void;
  /** Non-air blocks inside the box, so "clear" and "copy" are not blind. */
  filled: number;
}

export function RegionPanel({
  region,
  anchor,
  onCancelAnchor,
  onAction,
  onNudge,
  onResize,
  onDeselect,
  filled,
}: RegionPanelProps) {
  if (!region) {
    return (
      <p className="tools__hint">
        {anchor ? (
          <>
            Corner at {anchor.x}, {anchor.y}, {anchor.z} — click the opposite one, or{' '}
            <button type="button" className="tools__inline" onClick={onCancelAnchor}>
              cancel
            </button>
          </>
        ) : (
          'Click two opposite corners. The box stays put afterwards, so you can act on it more than once.'
        )}
      </p>
    );
  }

  const { min, max } = region;
  const span = {
    x: max.x - min.x + 1,
    y: max.y - min.y + 1,
    z: max.z - min.z + 1,
  };

  return (
    <div className="region">
      <p className="region__what">
        {span.x}×{span.y}×{span.z} ·{' '}
        {(span.x * span.y * span.z).toLocaleString()} cells · {filled.toLocaleString()} filled
      </p>
      <p className="region__where">
        {min.x}, {min.y}, {min.z} → {max.x}, {max.y}, {max.z}
      </p>

      <div className="tools__row tools__row--modes">
        {ACTIONS.map((action) => (
          <button
            key={action.id}
            type="button"
            className="tools__mode"
            title={action.title}
            onClick={() => onAction(action.id)}
          >
            {action.label}
          </button>
        ))}
      </div>

      <div className="region__grid" role="group" aria-label="Move the contents">
        {NUDGES.map((nudge) => (
          <button
            key={nudge.label}
            type="button"
            className="region__nudge"
            title={nudge.title}
            onClick={() => onNudge(...nudge.d)}
          >
            {nudge.label}
          </button>
        ))}
      </div>

      <div className="region__grid">
        <button
          type="button"
          className="region__nudge region__nudge--wide"
          title="Grow the box by one block on every side. The blocks inside do not move."
          onClick={() => onResize(1)}
        >
          Grow
        </button>
        <button
          type="button"
          className="region__nudge region__nudge--wide"
          title="Shrink the box by one block on every side"
          onClick={() => onResize(-1)}
        >
          Shrink
        </button>
        <button
          type="button"
          className="region__nudge region__nudge--wide"
          title="Forget the box (Esc)"
          onClick={onDeselect}
        >
          Deselect
        </button>
      </div>
    </div>
  );
}
