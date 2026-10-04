/**
 * Where the studio is, and whether leaving would throw work away.
 *
 * The three pages report into this. The shell draws the breadcrumb from it and is the one
 * place that asks before a navigation, so Build, Architecture and World cannot each forget
 * to warn.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { StudioMode } from './mode.js';

export interface StudioPresence {
  /** Which mounted editor reported these values; prevents a mode switch showing the old document. */
  mode: StudioMode | null;
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
  mode: null,
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

function leavePrompt(label: string): string {
  return `Leave Studio with changes to ${label}? Save a named copy if you need to return to this exact version.`;
}

export function PresenceProvider({ children }: { children: ReactNode }) {
  const [presence, setPresence] = useState<StudioPresence>(EMPTY);
  const current = useRef<StudioPresence>(EMPTY);
  const report = useCallback((patch: Partial<StudioPresence>) => {
    current.current = { ...current.current, ...patch };
    setPresence(current.current);
  }, []);
  const confirmLeave = useCallback((to?: string) => {
    const value = current.current;
    return (
      !value.dirty ||
      isStudioPath(to) ||
      window.confirm(leavePrompt(value.dirtyLabel))
    );
  }, []);
  const api = useMemo<PresenceApi>(
    () => ({ presence, report, confirmLeave }),
    [presence, report, confirmLeave],
  );
  const lastStudio = useRef({
    href: window.location.href,
    state: window.history.state,
  });
  useLayoutEffect(() => {
    if (window.location.pathname === '/studio')
      lastStudio.current = {
        href: window.location.href,
        state: window.history.state,
      };
  });
  useEffect(() => {
    if (!presence.dirty) return;
    const before = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [presence.dirty]);
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (
        !current.current.dirty ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as HTMLElement | null)?.closest?.('a');
      if (!anchor || anchor.target === '_blank') return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin || url.pathname === '/studio')
        return;
      if (!window.confirm(leavePrompt(current.current.dirtyLabel))) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const pop = (event: PopStateEvent) => {
      if (!current.current.dirty || window.location.pathname === '/studio')
        return;
      if (window.confirm(leavePrompt(current.current.dirtyLabel))) return;
      // Run before the router's bubble listener. A cancelled traversal must not unmount
      // the editor before the browser returns to its original history entry.
      event.stopImmediatePropagation();
      const from = window.history.state?.idx,
        to = lastStudio.current.state?.idx;
      if (Number.isInteger(from) && Number.isInteger(to) && from !== to)
        window.history.go(to - from);
      else {
        window.history.pushState(
          lastStudio.current.state,
          '',
          lastStudio.current.href,
        );
        window.dispatchEvent(
          new PopStateEvent('popstate', { state: lastStudio.current.state }),
        );
      }
    };
    document.addEventListener('click', click, true);
    window.addEventListener('popstate', pop, true);
    return () => {
      document.removeEventListener('click', click, true);
      window.removeEventListener('popstate', pop, true);
    };
  }, []);
  return (
    <PresenceContext.Provider value={api}>{children}</PresenceContext.Provider>
  );
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
  useLayoutEffect(() => {
    report?.(patch);
    // `patch` is a fresh object every render; `key` is its value. `report` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, key]);
}
