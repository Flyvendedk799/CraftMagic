import { useEffect, useState } from 'react';
import {
  confirmPending,
  journalCanRedo,
  journalCanUndo,
  registerLive,
  skipPending,
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
  /** False while the document is still loading — applying undo against a temporary stand-in would be reversed when it lands. */
  ready = true,
): void {
  useEffect(() => {
    if (!ready) return;
    return registerLive({ scope, docId, undo, redo });
  }, [scope, docId, undo, redo, ready]);

  useEffect(() => {
    if (!ready) return;
    const action = takePending(scope, docId);
    if (!action) return;
    const ok = action === 'undo' ? undo() : redo();
    if (ok) confirmPending(action);
    else skipPending(action);
  }, [scope, docId, undo, redo, ready]);
}

/** Whether the project stack, not the open page, can move. */
export function useJournalFlags(): { canUndo: boolean; canRedo: boolean } {
  const [, setTick] = useState(0);
  useEffect(() => subscribeJournal(() => setTick((n) => n + 1)), []);
  return { canUndo: journalCanUndo(), canRedo: journalCanRedo() };
}
