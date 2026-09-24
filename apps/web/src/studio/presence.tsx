/**
 * Where the studio is, and whether leaving would throw work away.
 *
 * The three pages report into this. The shell draws the breadcrumb from it and is the one
 * place that asks before a navigation, so Build, Architecture and World cannot each forget
 * to warn.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface StudioPresence {
  /** The open project — a world, even when you are inside one building. */
  project: string;
  /** The structure being edited, when zoomed in past the map. */
  structure: string | null;
  /** True on the floorplan of that structure. */
  plan: boolean;
  dirty: boolean;
  /** What the leave prompt names: "this building", "the floorplan", "the map". */
  dirtyLabel: string;
}

const EMPTY: StudioPresence = {
  project: 'Map',
  structure: null,
  plan: false,
  dirty: false,
  dirtyLabel: 'your work',
};

interface PresenceApi {
  presence: StudioPresence;
  report: (patch: Partial<StudioPresence>) => void;
}

const PresenceContext = createContext<PresenceApi | null>(null);

export function PresenceProvider({ children }: { children: ReactNode }) {
  const [presence, setPresence] = useState<StudioPresence>(EMPTY);
  const api = useMemo<PresenceApi>(
    () => ({
      presence,
      report: (patch) => setPresence((prev) => ({ ...prev, ...patch })),
    }),
    [presence],
  );

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
    window.addEventListener('beforeunload', onBefore);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBefore);
      document.removeEventListener('click', onClick, true);
    };
  }, [presence.dirty, presence.dirtyLabel]);

  return <PresenceContext.Provider value={api}>{children}</PresenceContext.Provider>;
}

export function useStudioPresence(): StudioPresence {
  return useContext(PresenceContext)?.presence ?? EMPTY;
}

/** Report the page's place in the project. The last mounted page wins, which is the one on screen. */
export function useReportPresence(patch: Partial<StudioPresence>): void {
  const api = useContext(PresenceContext);
  const key = JSON.stringify(patch);
  useEffect(() => {
    api?.report(patch);
    // `patch` is a fresh object every render; `key` is its value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);
}
