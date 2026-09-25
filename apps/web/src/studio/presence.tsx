/**
 * Where the studio is, and whether leaving would throw work away.
 *
 * The three pages report into this. The shell draws the breadcrumb from it and is the one
 * place that asks before a navigation, so Build, Architecture and World cannot each forget
 * to warn.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export interface StudioPresence {
  /** The open project — a world, even when you are inside one building. */
  project: string;
  /** The structure being edited, when zoomed in past the map. */
  structure: string | null;
  /**
   * Library row id for the open structure (`lib:` stripped), when it is one.
   *
   * The breadcrumb uses this to open that build's plan instead of an untitled Architecture
   * draft. Absent for samples, generated bridges, and the empty plot.
   */
  structureRowId: string | null;
  /** True when that library row already has a floorplan saved beside it. */
  hasPlan: boolean;
  /** True on the floorplan of that structure. */
  plan: boolean;
  dirty: boolean;
  /** What the leave prompt names: "this building", "the floorplan", "the map". */
  dirtyLabel: string;
}

const EMPTY: StudioPresence = {
  project: 'Map',
  structure: null,
  structureRowId: null,
  hasPlan: false,
  plan: false,
  dirty: false,
  dirtyLabel: 'your work',
};

interface PresenceApi {
  presence: StudioPresence;
  report: (patch: Partial<StudioPresence>) => void;
  /** False when the user cancelled. Studio-internal paths never prompt. */
  confirmLeave: (to?: string) => boolean;
}

const PresenceContext = createContext<PresenceApi | null>(null);

function isStudioPath(to: string | undefined): boolean {
  if (!to) return false;
  try {
    const url = new URL(to, window.location.href);
    return url.origin === window.location.origin && url.pathname === '/studio';
  } catch {
    return to.startsWith('/studio');
  }
}

export function PresenceProvider({ children }: { children: ReactNode }) {
  const [presence, setPresence] = useState<StudioPresence>(EMPTY);
  // Stable across presence updates — otherwise every report rebuilds `api`, re-runs the
  // reporting effect, and the page never settles.
  const report = useCallback((patch: Partial<StudioPresence>) => {
    setPresence((prev) => ({ ...prev, ...patch }));
  }, []);

  const confirmLeave = useCallback(
    (to?: string) => {
      if (!presence.dirty || isStudioPath(to)) return true;
      return window.confirm(
        `Leave without saving ${presence.dirtyLabel}? Unsaved changes will be lost.`,
      );
    },
    [presence.dirty, presence.dirtyLabel],
  );

  const api = useMemo<PresenceApi>(
    () => ({ presence, report, confirmLeave }),
    [presence, report, confirmLeave],
  );

  // Remember the studio URL while we are in it, so a cancelled Back can restore it.
  const studioHrefRef = useRef(window.location.href);
  useEffect(() => {
    if (window.location.pathname === '/studio') studioHrefRef.current = window.location.href;
  });

  useEffect(() => {
    if (!presence.dirty) return;
    const label = presence.dirtyLabel;
    const onBefore = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.('a');
      if (!anchor) return;
      if (anchor.target === '_blank') return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      // Staying inside the studio is a zoom, not a departure. The pages flush on the way out.
      if (url.pathname === '/studio') return;
      const ok = window.confirm(`Leave without saving ${label}? Unsaved changes will be lost.`);
      if (!ok) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // Browser back/forward bypasses the click capture. Prompt only when the new location
    // has left the studio — a Back that stays on `/studio` is a zoom.
    const onPopState = () => {
      if (window.location.pathname === '/studio') return;
      const ok = window.confirm(`Leave without saving ${label}? Unsaved changes will be lost.`);
      if (!ok) window.history.pushState(null, '', studioHrefRef.current);
    };
    window.addEventListener('beforeunload', onBefore);
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('beforeunload', onBefore);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState);
    };
  }, [presence.dirty, presence.dirtyLabel]);

  return <PresenceContext.Provider value={api}>{children}</PresenceContext.Provider>;
}

export function useStudioPresence(): StudioPresence {
  return useContext(PresenceContext)?.presence ?? EMPTY;
}

/** Ask before leaving the studio with unsaved work. Studio zooms always proceed. */
export function useConfirmLeave(): (to?: string) => boolean {
  const api = useContext(PresenceContext);
  return api?.confirmLeave ?? (() => true);
}

/** Report the page's place in the project. The last mounted page wins, which is the one on screen. */
export function useReportPresence(patch: Partial<StudioPresence>): void {
  const report = useContext(PresenceContext)?.report;
  const key = JSON.stringify(patch);
  useEffect(() => {
    report?.(patch);
    // `patch` is a fresh object every render; `key` is its value. `report` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, key]);
}
