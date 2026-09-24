import { useEffect, useState } from 'react';
import {
  confirmPending,
  journalCanRedo,
  journalCanUndo,
  registerLive,
  subscribeJournal,
  takePending,
  type ZoomScope,
} from './journal.js';

/** The open page's place in the project undo stack. */
export function useZoomUndo(
  scope: ZoomScope,
  docId: string,
  undo: () => boolean,
  redo: () => boolean,
): void {
  useEffect(() => registerLive({ scope, docId, undo, redo }), [scope, docId, undo, redo]);

  useEffect(() => {
    const action = takePending(scope, docId);
    if (!action) return;
    const ok = action === 'undo' ? undo() : redo();
    if (ok) confirmPending(action);
  }, [scope, docId, undo, redo]);
}

/** Whether the project stack, not the open page, can move. */
export function useJournalFlags(): { canUndo: boolean; canRedo: boolean } {
  const [, setTick] = useState(0);
  useEffect(() => subscribeJournal(() => setTick((n) => n + 1)), []);
  return { canUndo: journalCanUndo(), canRedo: journalCanRedo() };
}
