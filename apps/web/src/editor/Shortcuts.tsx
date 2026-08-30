/**
 * The keyboard reference.
 *
 * The studio had shortcuts before it had any way to find out that it did: the tool digits
 * were printed on the buttons, Ctrl+Z was a `title` attribute, and the layer and camera keys
 * added here would have been invisible entirely. An unadvertised shortcut is not a feature,
 * it is a thing that happens to power users by accident.
 *
 * The maps live here, one per surface, rather than in the pages that bind them: keeping them
 * side by side is what makes it obvious when the editor and the planner disagree about what a
 * key does. If a page binds a key that is not in its map here, that is the bug.
 */

import { useEffect } from 'react';

export interface KeyGroup {
  title: string;
  keys: readonly [string, string][];
}

export interface ShortcutsProps {
  groups: readonly KeyGroup[];
  onClose: () => void;
}

/** The editor: tools, undo, the layer band, the camera. */
export const EDITOR_KEYS: readonly KeyGroup[] = [
  {
    title: 'Tools',
    keys: [
      ['1', 'Place'],
      ['2', 'Erase'],
      ['3', 'Fill'],
      ['4', 'Box'],
      ['5', 'Swap'],
      ['Esc', 'Cancel a box in progress'],
    ],
  },
  {
    title: 'Edit',
    keys: [
      ['Ctrl Z', 'Undo'],
      ['Ctrl ⇧ Z', 'Redo'],
      ['Ctrl Y', 'Redo'],
    ],
  },
  {
    title: 'Layers',
    keys: [
      ['[', 'One course down'],
      [']', 'One course up'],
      ['\\', 'Show every layer'],
    ],
  },
  {
    title: 'View',
    keys: [
      ['F', 'Frame the build'],
      ['G', 'Ground grid on or off'],
      ['?', 'This list'],
    ],
  },
];

/** The planner: moving, turning and duplicating whatever is selected. */
export const PLAN_KEYS: readonly KeyGroup[] = [
  {
    title: 'Selection',
    keys: [
      ['Click', 'Select a building'],
      ['Drag', 'Move it on the ground'],
      ['Esc', 'Select nothing'],
    ],
  },
  {
    title: 'Move',
    keys: [
      ['←→↑↓', 'Nudge one block'],
      ['⇧ ←→↑↓', 'Nudge five'],
      ['PgUp', 'Raise'],
      ['PgDn', 'Lower'],
    ],
  },
  {
    title: 'Arrange',
    keys: [
      ['R', 'Turn a quarter'],
      ['Ctrl D', 'Duplicate'],
      ['Del', 'Remove'],
    ],
  },
  {
    title: 'View',
    keys: [
      ['F', 'Frame the plot'],
      ['G', 'Ground grid on or off'],
      ['\\', 'Show every layer'],
      ['?', 'This list'],
    ],
  },
];

export function Shortcuts({ groups, onClose }: ShortcutsProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    // The backdrop closes it, which is the gesture everyone tries first.
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={onClose}>
      <div className="sheet__body" onClick={(event) => event.stopPropagation()}>
        <div className="sheet__head">
          <h2 className="sheet__title">Keyboard</h2>
          <button type="button" className="sheet__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="sheet__grid">
          {groups.map((group) => (
            <section key={group.title}>
              <h3 className="sheet__group">{group.title}</h3>
              <dl className="sheet__keys">
                {group.keys.map(([key, meaning]) => (
                  <div key={key} className="sheet__row">
                    <dt>
                      {key.split(' ').map((part) => (
                        <kbd key={part}>{part}</kbd>
                      ))}
                    </dt>
                    <dd>{meaning}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <p className="sheet__foot">
          Shortcuts stay out of the way while you are typing — the prompt box, the search field
          and the coordinate boxes all keep every key to themselves.
        </p>
      </div>
    </div>
  );
}
