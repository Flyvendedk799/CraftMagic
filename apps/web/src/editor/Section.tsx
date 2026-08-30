/**
 * A collapsible block in a studio dock.
 *
 * A dock is one column of these, and the header is the part that has to earn its keep: it is
 * always visible, so it carries the one number worth seeing while the body is shut — the edit
 * count, the size, how many generated builds there are. Collapsing a section should cost you
 * the controls, never the answer.
 *
 * Open state is remembered per section in localStorage, because the useful arrangement is
 * personal and stable: someone building by hand keeps the tools open and everything else shut,
 * and having to re-collapse six panels on every reload would make the feature a nuisance
 * rather than a fix.
 *
 * `defaultOpen` decides only the first visit.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';

export interface SectionProps {
  id: string;
  title: string;
  /** Shown on the header when collapsed — the one number worth seeing without opening it. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

const STORAGE_PREFIX = 'craftmagic.section.';

function readOpen(id: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + id);
    return stored === null ? fallback : stored === '1';
  } catch {
    // Storage blocked (private mode, embedded); the section still works for this page view.
    return fallback;
  }
}

export function Section({ id, title, summary, defaultOpen = true, children }: SectionProps) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));

  // Re-read when the id changes, so two sections sharing this component do not inherit each
  // other's state.
  useEffect(() => {
    setOpen(readOpen(id, defaultOpen));
  }, [id, defaultOpen]);

  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      try {
        localStorage.setItem(STORAGE_PREFIX + id, next ? '1' : '0');
      } catch {
        // Not remembering is survivable; refusing to collapse is not.
      }
      return next;
    });
  }, [id]);

  return (
    <div className={`section ${open ? 'section--open' : ''}`}>
      <button type="button" className="section__head" onClick={toggle} aria-expanded={open}>
        <span className="section__chevron" aria-hidden="true" />
        <span className="section__title">{title}</span>
        {summary !== undefined && <span className="section__summary">{summary}</span>}
      </button>
      {/* Unmounted rather than hidden: the block picker and the agent panel both poll or hold
          canvases, and a collapsed section should cost nothing to keep closed. */}
      {open && <div className="section__body">{children}</div>}
    </div>
  );
}
