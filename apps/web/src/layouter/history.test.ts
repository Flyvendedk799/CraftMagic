import { describe, expect, it } from 'vitest';
import { HISTORY_DEPTH, PlanHistory } from './history.js';
import { createPlan, type LayoutPlan } from './plan.js';

function named(name: string): LayoutPlan {
  return createPlan({ name });
}

describe('PlanHistory', () => {
  it('starts with nothing to undo or redo', () => {
    const history = new PlanHistory();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo(named('a'))).toBeNull();
  });

  it('goes back to the state a change replaced', () => {
    const history = new PlanHistory();
    const first = named('first');
    history.push(first);

    const restored = history.undo(named('second'));

    expect(restored?.name).toBe('first');
    expect(history.canRedo).toBe(true);
  });

  it('redoes what was undone', () => {
    const history = new PlanHistory();
    history.push(named('first'));
    const second = named('second');
    const back = history.undo(second)!;

    expect(history.redo(back)?.name).toBe('second');
    expect(history.canUndo).toBe(true);
  });

  it('drops the redo stack on a new change, the way every editor does', () => {
    const history = new PlanHistory();
    history.push(named('first'));
    history.undo(named('second'));
    expect(history.canRedo).toBe(true);

    history.push(named('third'));

    expect(history.canRedo).toBe(false);
  });

  it('snapshots rather than referencing, so a later mutation cannot rewrite the past', () => {
    const history = new PlanHistory();
    const plan = named('first');
    history.push(plan);

    plan.name = 'mutated';

    expect(history.undo(named('other'))?.name).toBe('first');
  });

  it('bounds the stack so a long session cannot grow without limit', () => {
    const history = new PlanHistory();
    for (let i = 0; i < HISTORY_DEPTH + 10; i++) history.push(named(`step ${i}`));

    expect(history.depth).toBe(HISTORY_DEPTH);
    // The oldest entries fell off the bottom, not the newest.
    expect(history.undo(named('now'))?.name).toBe(`step ${HISTORY_DEPTH + 9}`);
  });
});
