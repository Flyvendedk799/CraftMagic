/**
 * The keyboard sheet.
 *
 * Every shortcut in this product was discoverable in exactly one way: hovering the one
 * control that happens to mention it. That is fine for the tool digits, which are printed on
 * the buttons, and useless for the ones with no button at all — Alt-click to pick, Shift-drag
 * to paint, the bracket keys on the layer cut. Those are the shortcuts worth having and the
 * ones nobody would ever find.
 *
 * The dialog is here; the lists are not. There are two keyboard-heavy tools in this product
 * and they share nothing but the dialog — the layouter has no brush and the editor has no
 * storeys. One sheet with a `tool` flag would be a switch statement wearing a component, and
 * two sheets would be two dialogs to keep in step. So each tool brings its own list, from
 * `editor/shortcuts.ts` and `layouter/shortcuts.ts`.
 *
 * Those lists are written out by hand rather than derived from the key handlers. Deriving
 * them would guarantee the keys match and still leave the descriptions to be written, and the
 * descriptions are the part that has to be right — "R" is not a useful thing to know about
 * the clipboard.
 */

import { useEffect, useRef, type ReactNode } from 'react';

export interface Shortcut {
  keys: string;
  what: string;
}

export interface ShortcutGroup {
  title: string;
  rows: readonly Shortcut[];
}

export interface ShortcutHelpProps {
  groups: readonly ShortcutGroup[];
  /** The line under the columns. Each tool has something different to say there. */
  foot?: string;
  onClose: () => void;
}

export function ShortcutHelp({ groups, foot, onClose }: ShortcutHelpProps) {
  const close = useRef(onClose);
  close.current = onClose;

  /**
   * Escape closes it from anywhere, including from inside a text field — the sheet covers the
   * screen, so there is nothing else a keypress could sensibly be meant for.
   *
   * Bound once, through a ref, and that is not a micro-optimisation: the page has its own
   * window listener that runs first and sets state. React flushes that update in a microtask
   * *between* the two listeners, so an effect that re-subscribed on every render would tear
   * this listener down mid-dispatch — and a listener added during a dispatch does not receive
   * the event that is already in flight. The sheet swallowed the first Escape after every
   * edit and closed on the second.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      {/* A backdrop button rather than a click handler on the panel's parent: clicking
          outside a dialog to dismiss it has to be reachable by keyboard too. */}
      <button type="button" className="shortcuts__scrim" aria-label="Close shortcuts" onClick={onClose} />
      <div className="shortcuts__panel">
        <div className="shortcuts__head">
          <h2 className="shortcuts__title">Keyboard</h2>
          <button type="button" className="shortcuts__close" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="shortcuts__cols">
          {groups.map((group) => (
            <Group key={group.title} title={group.title}>
              {group.rows.map((entry) => (
                <Row key={entry.keys} {...entry} />
              ))}
            </Group>
          ))}
        </div>

        {foot && <p className="shortcuts__foot">{foot}</p>}
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="shortcuts__group">
      <h3 className="shortcuts__group-title">{title}</h3>
      <dl className="shortcuts__list">{children}</dl>
    </section>
  );
}

function Row({ keys, what }: Shortcut) {
  return (
    <>
      <dt>
        <kbd>{keys}</kbd>
      </dt>
      <dd>{what}</dd>
    </>
  );
}
