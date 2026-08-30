/**
 * The parts of the studio frame that are the same wherever you are standing.
 *
 * The editor and the planner are two different jobs sharing one set of chrome: two docks that
 * remember whether they are open, a camera you can send somewhere, display toggles that
 * persist, and a keyboard sheet. None of that is about builds or about plans, and duplicating
 * it was the fastest way to end up with a planner whose panels collapse differently from the
 * editor's — the exact "two products in a trench coat" feeling this whole change set exists
 * to remove.
 *
 * What is *not* here is the keyboard map. The shared keys are few and the surface-specific
 * ones are most of them, so each page binds its own and lists them in its own sheet.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_DISPLAY,
  readDisplay,
  writeDisplay,
  type CameraPreset,
  type DisplayOptions,
  type ViewCommand,
} from './viewport.js';

const DOCK_KEY = 'craftmagic.docks';

export interface StudioChrome {
  docks: { left: boolean; right: boolean };
  toggleDock: (side: 'left' | 'right') => void;
  display: DisplayOptions;
  setDisplay: (next: DisplayOptions) => void;
  view: ViewCommand | null;
  sendView: (preset: CameraPreset) => void;
  shortcuts: boolean;
  setShortcuts: (open: boolean) => void;
}

function readDocks(): { left: boolean; right: boolean } {
  // Below the breakpoint the docks are overlays, so opening both on a first visit would bury
  // the build under two panels. A stored preference always wins — someone who opened them on
  // a narrow window meant it.
  const wide = typeof window === 'undefined' || window.innerWidth > 1000;
  const fallback = { left: wide, right: wide };
  try {
    const raw = localStorage.getItem(DOCK_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { left?: boolean; right?: boolean };
    return { left: parsed.left ?? fallback.left, right: parsed.right ?? fallback.right };
  } catch {
    return fallback;
  }
}

export function useStudioChrome(): StudioChrome {
  const [docks, setDocks] = useState({ left: true, right: true });
  const [display, setDisplayState] = useState<DisplayOptions>(DEFAULT_DISPLAY);
  const [view, setView] = useState<ViewCommand | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const nonce = useRef(0);

  // Read after mount rather than during the first render: `localStorage` is not available
  // while the page is being driven by a headless browser with storage disabled, and a throw
  // there would take the whole studio down instead of one preference.
  useEffect(() => {
    setDisplayState(readDisplay());
    setDocks(readDocks());
  }, []);

  const setDisplay = useCallback((next: DisplayOptions) => {
    setDisplayState(next);
    writeDisplay(next);
  }, []);

  const toggleDock = useCallback((side: 'left' | 'right') => {
    setDocks((prev) => {
      const next = { ...prev, [side]: !prev[side] };
      try {
        localStorage.setItem(DOCK_KEY, JSON.stringify(next));
      } catch {
        // Not remembering is survivable; refusing to collapse is not.
      }
      return next;
    });
  }, []);

  const sendView = useCallback((preset: CameraPreset) => {
    // A command with a nonce, not a value: "put the camera at the front" is an event, and
    // pressing Front twice in a row has to move the camera twice.
    nonce.current += 1;
    setView({ preset, nonce: nonce.current });
  }, []);

  return { docks, toggleDock, display, setDisplay, view, sendView, shortcuts, setShortcuts };
}
