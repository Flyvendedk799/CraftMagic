/**
 * Which build you are in, and the way to another one.
 *
 * This replaces a wall of buttons — four samples, every generated build, every mural, every
 * import, and an Import control — that sat above the tools and grew every time somebody
 * generated something. It was the first thing on screen and the least often used thing on the
 * screen: choosing a build is a once-a-session act, and it was taking more room than the tools
 * you use every second. Worse, the panel's height is finite, so each new generation pushed the
 * editing controls further under the fold.
 *
 * So it collapses to one row that answers the question the wall never did — *what am I editing
 * right now* — and opens the rest on demand, grouped by where the builds came from.
 *
 * Closing on outside-press rather than on blur: a menu that vanishes when focus moves cannot be
 * scrolled with the pointer, and this list is long by design once someone has been working.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface BuildOption {
  id: string;
  name: string;
  /** Shown as a group heading; options keep the order they are given within a group. */
  group: string;
  title?: string;
}

export interface BuildMenuProps {
  current: string;
  currentName: string;
  /** Dimensions of the open build, for the one line that always earns its place. */
  summary: string;
  options: readonly BuildOption[];
  onPick: (id: string) => void;
  /** Rendered inside the menu under its own heading — the file input cannot be a plain option. */
  importControl: React.ReactNode;
}

export function BuildMenu(props: BuildMenuProps) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    // Capture, so a press that lands on the 3D canvas — which stops propagation to run its own
    // gesture — still closes the menu instead of leaving it hanging over the build.
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = useCallback(
    (id: string) => {
      setOpen(false);
      props.onPick(id);
    },
    [props],
  );

  // Grouped in first-seen order rather than alphabetically: the caller lists samples first
  // because that is where a new session starts, and sorting would bury them under whatever the
  // user happens to have named their builds.
  const groups: { name: string; items: BuildOption[] }[] = [];
  for (const option of props.options) {
    const last = groups[groups.length - 1];
    if (last && last.name === option.group) last.items.push(option);
    else groups.push({ name: option.group, items: [option] });
  }

  return (
    <div className="buildmenu" ref={hostRef}>
      <button
        type="button"
        className="buildmenu__current"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((was) => !was)}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
          <path d="M8 1.8 14 5v6l-6 3.2L2 11V5z" />
          <path d="M2 5l6 3.2L14 5" />
          <path d="M8 8.2v6" />
        </svg>
        <span className="buildmenu__name">{props.currentName}</span>
        <span className="buildmenu__summary">{props.summary}</span>
        <span className="buildmenu__caret" aria-hidden="true" />
      </button>

      {open && (
        <div className="buildmenu__list" role="menu">
          {groups.map((group) => (
            <div className="buildmenu__group" key={group.name}>
              <p className="buildmenu__grouplabel">{group.name}</p>
              {group.items.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitem"
                  className="buildmenu__item"
                  aria-pressed={option.id === props.current}
                  title={option.title ?? option.name}
                  onClick={() => pick(option.id)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          ))}
          <div className="buildmenu__group">
            <p className="buildmenu__grouplabel">Open a file</p>
            {props.importControl}
          </div>
        </div>
      )}
    </div>
  );
}
