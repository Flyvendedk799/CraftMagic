import { describe, expect, it } from 'vitest';
import { confirmPending, recordChange, registerLive, requestRedo, requestUndo, resetJournal, takePending } from './journal.js';

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
});
