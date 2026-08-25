/**
 * The keyboard sheet.
 *
 * Every shortcut in this editor was already discoverable in exactly one way: hovering the
 * one control that happens to mention it. That is fine for the five tool digits, which are
 * printed on the buttons, and useless for the ones with no button at all — Alt-click to
 * pick, Shift-drag to paint, the bracket keys on the layer cut. Those are the shortcuts
 * worth having and the ones nobody would ever find.
 *
 * The list is written out here rather than derived from the handlers. Deriving it would
 * guarantee the keys match and still leave the descriptions to be written by hand, and the
 * descriptions are the part that has to be right — "R" is not a useful thing to know about
 * the clipboard.
 */

import { useEffect, useRef } from 'react';
import { TOOLS } from './toolset.js';

export interface ShortcutHelpProps {
  onClose: () => void;
}

interface Shortcut {
  keys: string;
  what: string;
}

const EDITING: readonly Shortcut[] = [
  { keys: 'Alt + click', what: 'Pick the block under the pointer, from any tool' },
  { keys: 'Shift + drag', what: 'Keep placing or erasing along the drag, as one undo step' },
  { keys: 'Esc', what: 'Cancel the corner in progress' },
  { keys: 'Ctrl + Z', what: 'Undo' },
  { keys: 'Ctrl + Shift + Z', what: 'Redo' },
];

const BRUSH: readonly Shortcut[] = [
  { keys: '− / +', what: 'Smaller or larger brush' },
  { keys: 'B', what: 'Switch the brush between round and square' },
];

const CLIPBOARD: readonly Shortcut[] = [
  { keys: 'Box tool → Copy', what: 'Copy the region between two corners' },
  { keys: 'R', what: 'Rotate the clipboard 90°, block states and all' },
  { keys: 'M', what: 'Mirror the clipboard' },
];

const VIEW: readonly Shortcut[] = [
  { keys: '[ / ]', what: 'Lower or raise the layer cut' },
  { keys: '\\', what: 'Show every layer again' },
  { keys: 'I', what: 'Isolate the cut layer — show that slice alone' },
  { keys: 'F', what: 'Frame the whole build' },
  { keys: 'Drag / scroll', what: 'Orbit and zoom' },
  { keys: '?', what: 'This list' },
];

export function ShortcutHelp({ onClose }: ShortcutHelpProps) {
  const close = useRef(onClose);
  close.current = onClose;

  /**
   * Escape closes it from anywhere, including from inside the prompt box — the sheet covers
   * the screen, so there is nothing else a keypress could sensibly be meant for.
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
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      {/* A backdrop button rather than a click handler on the panel's parent: clicking
          outside a dialog to dismiss it has to be reachable by keyboard too. */}
      <button type="button" className="sheet__scrim" aria-label="Close shortcuts" onClick={onClose} />
      <div className="sheet__panel">
        <div className="sheet__head">
          <h2 className="sheet__title">Keyboard</h2>
          <button type="button" className="sheet__close" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="sheet__cols">
          <Group title="Tools">
            {TOOLS.map((tool) => (
              <Row key={tool.id} keys={tool.key} what={tool.label} />
            ))}
          </Group>
          <Group title="Editing">
            {EDITING.map((entry) => (
              <Row key={entry.keys} {...entry} />
            ))}
          </Group>
          <Group title="Brush">
            {BRUSH.map((entry) => (
              <Row key={entry.keys} {...entry} />
            ))}
          </Group>
          <Group title="Clipboard">
            {CLIPBOARD.map((entry) => (
              <Row key={entry.keys} {...entry} />
            ))}
          </Group>
          <Group title="View">
            {VIEW.map((entry) => (
              <Row key={entry.keys} {...entry} />
            ))}
          </Group>
        </div>

        <p className="sheet__foot">
          Shortcuts are ignored while you are typing, so the prompt box keeps its own keys.
        </p>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="sheet__group">
      <h3 className="sheet__group-title">{title}</h3>
      <dl className="sheet__list">{children}</dl>
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
