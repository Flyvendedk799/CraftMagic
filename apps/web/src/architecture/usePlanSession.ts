/**
 * Architecture mode's session: the plan on screen, its history, and where it is kept.
 *
 * The split that matters here is `commit` versus `preview`. A pointer drag produces a new plan
 * on every mouse move, and pushing each of those onto the undo stack would make one dragged
 * wall cost forty undos to take back. So a drag calls `preview` — which updates the plan and
 * nothing else — and the release calls `commit`, which is the only thing that records history.
 * The level editor engine this is ported from draws the same line by calling `saveHistory()`
 * once when a gesture *starts*; committing on release is the same rule from the other end, and
 * it has the advantage that a gesture the user abandons never leaves an entry behind.
 *
 * Autosave is debounced rather than immediate for the same reason: a drag would otherwise
 * serialize the whole document into localStorage on every frame.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizePlan, type LayoutPlan } from './plan.js';
import { PlanHistory } from './history.js';
import { loadAutosave, saveAutosave, listSaved, savePlan, deleteSaved, type SavedPlan } from './storage.js';

/** Long enough that a drag writes once, short enough that a closed tab loses nothing real. */
const AUTOSAVE_DELAY = 500;

export interface PlanSession {
  plan: LayoutPlan;
  /** Apply a change and record the state it replaced. Use for anything a user would undo. */
  commit: (next: LayoutPlan | ((plan: LayoutPlan) => LayoutPlan)) => void;
  /** Apply a change without touching history — the intermediate frames of a drag. */
  preview: (next: LayoutPlan | ((plan: LayoutPlan) => LayoutPlan)) => void;
  /** Record the current state before a gesture that will only `preview` from here on. */
  mark: () => void;
  /** Replace the plan wholesale — a template, an import, a saved plan. Clears history. */
  reset: (plan: LayoutPlan) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  saved: SavedPlan[];
  save: () => void;
  remove: (id: string) => void;
  /** True once the plan differs from what was last written to a named save. */
  dirty: boolean;
}

export function usePlanSession(initial: () => LayoutPlan): PlanSession {
  // The autosave is read once, at mount. Re-reading it later would let another tab's plan
  // replace the one being edited here mid-sentence.
  const [plan, setPlan] = useState<LayoutPlan>(() => loadAutosave() ?? normalizePlan(initial()));
  const historyRef = useRef<PlanHistory | null>(null);
  const history = (historyRef.current ??= new PlanHistory());

  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState<SavedPlan[]>(() => listSaved());
  const [savedRevision, setSavedRevision] = useState<string | null>(null);

  const bump = useCallback(() => setRevision((n) => n + 1), []);

  const commit = useCallback(
    (next: LayoutPlan | ((plan: LayoutPlan) => LayoutPlan)) => {
      setPlan((current) => {
        const resolved = typeof next === 'function' ? next(current) : next;
        if (resolved === current) return current;
        history.push(current);
        return resolved;
      });
      bump();
    },
    [history, bump],
  );

  const preview = useCallback((next: LayoutPlan | ((plan: LayoutPlan) => LayoutPlan)) => {
    setPlan((current) => (typeof next === 'function' ? next(current) : next));
  }, []);

  const mark = useCallback(() => {
    setPlan((current) => {
      history.push(current);
      return current;
    });
    bump();
  }, [history, bump]);

  const reset = useCallback(
    (next: LayoutPlan) => {
      history.clear();
      setPlan(normalizePlan(next));
      bump();
    },
    [history, bump],
  );

  const undo = useCallback(() => {
    setPlan((current) => history.undo(current) ?? current);
    bump();
  }, [history, bump]);

  const redo = useCallback(() => {
    setPlan((current) => history.redo(current) ?? current);
    bump();
  }, [history, bump]);

  const save = useCallback(() => {
    setSaved(savePlan(plan));
    setSavedRevision(fingerprint(plan));
  }, [plan]);

  const remove = useCallback((id: string) => {
    setSaved(deleteSaved(id));
  }, []);

  // Debounced autosave. Written on the trailing edge so a drag costs one write, and cleared on
  // unmount so a page that is navigated away from mid-drag still gets its last state out.
  useEffect(() => {
    const timer = setTimeout(() => saveAutosave(plan), AUTOSAVE_DELAY);
    return () => clearTimeout(timer);
  }, [plan]);

  const dirty = useMemo(() => savedRevision !== fingerprint(plan), [savedRevision, plan]);

  return {
    plan,
    commit,
    preview,
    mark,
    reset,
    undo,
    redo,
    // `revision` is what makes these re-read after an undo: the history object is mutable and
    // React has no way to know its stacks changed.
    canUndo: revision >= 0 && history.canUndo,
    canRedo: revision >= 0 && history.canRedo,
    saved,
    save,
    remove,
    dirty,
  };
}

/** Cheap identity for "has this changed since it was saved". */
function fingerprint(plan: LayoutPlan): string {
  return JSON.stringify({ ...plan, updatedAt: '' });
}
