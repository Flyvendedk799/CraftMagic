import { describe, expect, it } from 'vitest';
import { History } from './history.js';

/** An entry that costs whatever it says it costs, so the ceilings can be aimed at precisely. */
const sized = (bytes: number, label = '') => ({ bytes, label });
const cost = (entry: { bytes: number }) => entry.bytes;

describe('History', () => {
  it('walks back and forth over the same entries', () => {
    const history = new History(cost);
    const a = sized(1, 'a');
    const b = sized(1, 'b');
    history.push(a);
    history.push(b);

    expect(history.canRedo).toBe(false);
    expect(history.undo()).toBe(b);
    expect(history.undo()).toBe(a);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBe(a);
    expect(history.redo()).toBe(b);
    expect(history.redo()).toBeNull();
  });

  it('discards the redo tail when a new entry lands on it', () => {
    const history = new History(cost);
    history.push(sized(1, 'a'));
    history.push(sized(1, 'b'));
    history.undo();

    const fresh = sized(1, 'c');
    history.push(fresh);
    expect(history.canRedo).toBe(false);
    expect(history.depth).toBe(2);
    expect(history.undo()).toBe(fresh);
  });

  it('reclaims the bytes of a discarded redo tail', () => {
    // The truncation has to subtract what it drops, or the byte ceiling drifts upward every
    // time somebody undoes and then edits again — which is most of how anyone works.
    const history = new History(cost);
    history.push(sized(100));
    history.push(sized(100));
    expect(history.bytes).toBe(200);
    history.undo();
    history.push(sized(10));
    expect(history.bytes).toBe(110);
  });

  it('evicts the oldest entries past the depth ceiling', () => {
    const history = new History(cost, { maxEntries: 3 });
    for (let i = 0; i < 5; i++) history.push(sized(1, `e${i}`));
    expect(history.depth).toBe(3);

    // The cursor moved down with the eviction, so undo walks the entries that survived rather
    // than running off the bottom of a stack that is shorter than it thinks.
    expect(history.undo()).not.toBeNull();
    expect(history.undo()).not.toBeNull();
    expect(history.undo()).not.toBeNull();
    expect(history.undo()).toBeNull();
  });

  it('evicts on bytes as well as on depth', () => {
    // A depth limit alone cannot bound a stack whose entries may each be a whole map.
    const history = new History(cost, { maxBytes: 250 });
    history.push(sized(100));
    history.push(sized(100));
    history.push(sized(100));
    expect(history.depth).toBe(2);
    expect(history.bytes).toBe(200);
  });

  it('keeps an entry that is bigger than the whole byte ceiling', () => {
    // The divergence this file exists to end. The editor guarded eviction with `length > 1` and
    // wrote down why: an entry larger than the ceiling would otherwise evict itself the moment
    // it was pushed, leaving a change on screen that cannot be undone. The world's copy had no
    // such guard, and its resize snapshots are the largest entries in the product — so the one
    // stack that could not afford the bug was the one that had it.
    const history = new History(cost, { maxBytes: 10 });
    const huge = sized(5_000, 'a resize of a large world');
    history.push(huge);

    expect(history.depth).toBe(1);
    expect(history.canUndo).toBe(true);
    expect(history.undo()).toBe(huge);
  });

  it('still evicts down to one when every entry is oversized', () => {
    const history = new History(cost, { maxBytes: 10 });
    history.push(sized(5_000, 'first'));
    const second = sized(5_000, 'second');
    history.push(second);
    expect(history.depth).toBe(1);
    expect(history.undo()).toBe(second);
  });

  it('forgets everything on clear', () => {
    const history = new History(cost);
    history.push(sized(1));
    history.push(sized(1));
    history.clear();
    expect(history.depth).toBe(0);
    expect(history.bytes).toBe(0);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it('treats a zero limit as one rather than as no history at all', () => {
    // A ceiling of zero would make every push evict itself, which is a stack that silently
    // does nothing — worse than a small one.
    const history = new History(cost, { maxEntries: 0, maxBytes: 0 });
    const only = sized(1);
    history.push(only);
    expect(history.undo()).toBe(only);
  });
});
