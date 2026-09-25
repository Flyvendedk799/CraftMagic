import { describe, expect, it } from 'vitest';
import {
  confirmPending,
  journalCanUndo,
  recordChange,
  registerLive,
  requestRedo,
  requestUndo,
  resetJournal,
  skipPending,
  takePending,
} from './journal.js';

describe('project journal', () => {
  it('undoes the latest edit even when it was made at another zoom level', () => {
    resetJournal();
    recordChange('build', 'lib:a');
    recordChange('world', 'open-world');
    const step = requestUndo();
    expect(step).toEqual({ kind: 'zoom', frame: { scope: 'world', docId: 'open-world' }, action: 'undo' });
    expect(takePending('world', 'open-world')).toBe('undo');
    confirmPending('undo');
    const next = requestUndo();
    expect(next).toEqual({ kind: 'zoom', frame: { scope: 'build', docId: 'lib:a' }, action: 'undo' });
  });

  it('applies in place when that document is the one open', () => {
    resetJournal();
    recordChange('arch', 'architecture');
    let undone = 0;
    const stop = registerLive({
      scope: 'arch',
      docId: 'architecture',
      undo: () => {
        undone++;
        return true;
      },
      redo: () => false,
    });
    expect(requestUndo()).toEqual({ kind: 'applied' });
    expect(undone).toBe(1);
    stop();
    expect(requestRedo()).toEqual({ kind: 'zoom', frame: { scope: 'arch', docId: 'architecture' }, action: 'redo' });
    resetJournal();
  });

  it('skips a stale frame whose document entry is gone', () => {
    resetJournal();
    recordChange('build', 'lib:a');
    recordChange('build', 'lib:a');
    const stop = registerLive({
      scope: 'build',
      docId: 'lib:a',
      undo: () => false,
      redo: () => false,
    });
    // First frame is stale — drop it and report empty once nothing remains that can apply.
    expect(requestUndo()).toEqual({ kind: 'empty' });
    expect(journalCanUndo()).toBe(false);
    stop();
    resetJournal();
  });

  it('skipPending drops a zoom frame the page could not apply', () => {
    resetJournal();
    recordChange('world', 'open-world');
    recordChange('build', 'lib:a');
    const step = requestUndo();
    expect(step.kind).toBe('zoom');
    expect(takePending('build', 'lib:a')).toBe('undo');
    skipPending('undo');
    expect(journalCanUndo()).toBe(true);
    expect(requestUndo()).toEqual({
      kind: 'zoom',
      frame: { scope: 'world', docId: 'open-world' },
      action: 'undo',
    });
    resetJournal();
  });
});
