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

import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizePlan, type LayoutPlan } from './plan.js';
import { WorkingCopies } from '../studio/workspace/retention.js';
import { planHistoryFor } from '../studio/retainHistory.js';
import { invalidateJournalDocument, recordChange } from '../studio/journal.js';
import {
  loadAutosave,
  saveAutosave,
  listSaved,
  savePlan,
  deleteSaved,
  type SavedPlan,
} from './storage.js';

/** Long enough that a drag writes once, short enough that a closed tab loses nothing real. */
const AUTOSAVE_DELAY = 500;
const workingPlans = new WorkingCopies<{ plan: LayoutPlan; dirty: boolean }>(
  16,
  16 * 1024 * 1024,
);

export function invalidateWorkingPlan(documentKey: string): void {
  workingPlans.invalidate(documentKey);
  invalidateJournalDocument('arch', documentKey);
}

export interface PlanSession {
  plan: LayoutPlan;
  historyId: string;
  recovered: boolean;
  /** Apply a change and record the state it replaced. Use for anything a user would undo. */
  commit: (next: LayoutPlan | ((plan: LayoutPlan) => LayoutPlan)) => void;
  /** Apply a change without touching history — the intermediate frames of a drag. */
  preview: (next: LayoutPlan | ((plan: LayoutPlan) => LayoutPlan)) => void;
  /** Record the current state before a gesture that will only `preview` from here on. */
  mark: () => void;
  /** Replace the plan wholesale — a template, an import, a saved plan. Clears history. */
  reset: (plan: LayoutPlan, saved?: boolean) => void;
  undo: () => boolean;
  redo: () => boolean;
  canUndo: boolean;
  canRedo: boolean;
  saved: SavedPlan[];
  save: () => boolean;
  saveError: string | null;
  remove: (id: string) => void;
  /** True once the plan differs from what was last written to a named save. */
  dirty: boolean;
}

export function usePlanSession(
  initial: () => LayoutPlan,
  documentKey = 'architecture',
): PlanSession {
  const recovered = useRef(workingPlans.get(documentKey));
  const cacheVersion = useRef(workingPlans.version(documentKey));
  // The autosave is read once, at mount. Re-reading it later would let another tab's plan
  // replace the one being edited here mid-sentence.
  const [plan, setPlan] = useState<LayoutPlan>(
    () =>
      recovered.current?.plan ??
      (documentKey === '/studio?mode=arch' || documentKey === 'architecture'
        ? loadAutosave()
        : null) ??
      normalizePlan(initial()),
  );
  // Tracked so the unmount flush below writes the plan as it stands, not as it was when the
  // effect was created. Assigned during render rather than in an effect: a cleanup that ran
  // before the effect updating it would write one edit behind.
  const planRef = useRef(plan);
  planRef.current = plan;

  const history = planHistoryFor(documentKey);

  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(0);
  const [saved, setSaved] = useState<SavedPlan[]>(() => listSaved());
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * The revision the plan was last saved at, or null if it never has been.
   *
   * This was a `JSON.stringify` of the whole document, compared against a fresh one on every
   * render. `preview()` gives the plan a new identity on every pointer-move frame of a drag,
   * so the memo re-ran and the entire plan was serialised sixty times a second — to light a
   * one-word "unsaved" label. The counter is the same answer for an integer compare, and it
   * only moves on a commit, which is the honest definition anyway: a drag in progress has not
   * changed anything until it is let go.
   */
  // The initial plan is either the blank starting point or a recovered local autosave. Both
  // are already kept on this device; opening Architecture should not show a false warning.
  const [savedRevision, setSavedRevision] = useState(
    recovered.current?.dirty ? -1 : 0,
  );

  const bump = useCallback(() => {
    const next = ++revisionRef.current;
    setRevision(next);
    return next;
  }, []);

  // Keep history mutations outside React state updaters: StrictMode may replay an updater.
  const assign = useCallback((next: LayoutPlan) => {
    planRef.current = next;
    setPlan(next);
  }, []);
  const commit = useCallback(
    (next: LayoutPlan | ((plan: LayoutPlan) => LayoutPlan)) => {
      const current = planRef.current;
      const resolved = typeof next === 'function' ? next(current) : next;
      if (resolved === current) return;
      history.push(current);
      recordChange('arch', documentKey, 'Edit floorplan');
      assign(resolved);
      bump();
    },
    [history, documentKey, assign, bump],
  );
  const preview = useCallback(
    (next: LayoutPlan | ((plan: LayoutPlan) => LayoutPlan)) => {
      assign(typeof next === 'function' ? next(planRef.current) : next);
    },
    [assign],
  );
  const mark = useCallback(() => {
    history.push(planRef.current);
    recordChange('arch', documentKey, 'Edit floorplan');
    bump();
  }, [history, documentKey, bump]);
  const reset = useCallback(
    (next: LayoutPlan, saved = false) => {
      history.clear();
      invalidateJournalDocument('arch', documentKey);
      assign(normalizePlan(next));
      const nextRevision = bump();
      if (saved) setSavedRevision(nextRevision);
    },
    [history, documentKey, assign, bump],
  );
  const undo = useCallback((): boolean => {
    const previous = history.undo(planRef.current);
    if (!previous) return false;
    assign(previous);
    bump();
    return true;
  }, [history, assign, bump]);
  const redo = useCallback((): boolean => {
    const next = history.redo(planRef.current);
    if (!next) return false;
    assign(next);
    bump();
    return true;
  }, [history, assign, bump]);

  const save = useCallback(() => {
    try {
      setSaved(savePlan(planRef.current));
      setSavedRevision(revisionRef.current);
      setSaveError(null);
      return true;
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : 'Could not save this floorplan.',
      );
      return false;
    }
  }, [plan, revision]);

  const remove = useCallback((id: string) => {
    try {
      setSaved(deleteSaved(id));
      setSaveError(null);
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : 'Could not remove the saved plan.',
      );
    }
  }, []);

  // Debounced autosave, written on the trailing edge so a drag costs one write.
  useEffect(() => {
    const timer = setTimeout(() => saveAutosave(plan), AUTOSAVE_DELAY);
    return () => clearTimeout(timer);
  }, [plan]);

  /**
   * And flush on the way out.
   *
   * The effect above used to carry a comment saying it did this — "cleared on unmount so a
   * page that is navigated away from mid-drag still gets its last state out" — but
   * `clearTimeout` is a cancel, not a flush. It threw the pending write away. The studio
   * mounts a mode through `MODE_PAGES[mode]`, so flipping the mode pill *unmounts* this
   * page: anything drawn in the last 500 ms before a switch was silently discarded.
   *
   * Its own effect with an empty dep list, not the debounce's cleanup, because that
   * cleanup runs on every keystroke and writing there would defeat the debounce entirely.
   * The ref is what makes it correct — a cleanup closing over `plan` would capture the
   * value from the render that mounted, which is the empty document.
   */
  const dirtyRef = useRef(false);
  dirtyRef.current = savedRevision !== revision;
  useEffect(
    () => () => {
      const value = planRef.current;
      workingPlans.setIfCurrent(
        documentKey,
        { plan: value, dirty: dirtyRef.current },
        JSON.stringify(value).length * 2,
        cacheVersion.current,
      );
      saveAutosave(value);
    },
    [],
  );

  const dirty = savedRevision !== revision;

  return {
    plan,
    historyId: documentKey,
    recovered: !!recovered.current,
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
    saveError,
    remove,
    dirty,
  };
}
