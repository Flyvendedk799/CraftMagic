import { describe, expect, it } from 'vitest';
import { WorldHistory, type CarveDelta, type PlacementDelta, type TerrainDelta } from './history.js';

function terrain(columns: number[]): TerrainDelta {
  return {
    kind: 'terrain',
    columns: Uint32Array.from(columns),
    beforeHeight: Int16Array.from(columns.map(() => 60)),
    afterHeight: Int16Array.from(columns.map(() => 70)),
    beforeStratum: Uint8Array.from(columns.map(() => 0)),
    afterStratum: Uint8Array.from(columns.map(() => 0)),
  };
}

function carve(keys: string[]): CarveDelta {
  const after = Object.fromEntries(keys.map((key) => [key, { palette: ['', 'minecraft:air'], data: 'AA' }]));
  return { kind: 'carve', before: {}, after, keys };
}

const placements: PlacementDelta = { kind: 'placements', before: [], after: [] };

describe('WorldHistory', () => {
  it('walks back and forth over the same entries', () => {
    const history = new WorldHistory();
    const first = terrain([1]);
    const second = terrain([2]);
    history.push(first);
    history.push(second);

    expect(history.canRedo).toBe(false);
    expect(history.undo()).toBe(second);
    expect(history.undo()).toBe(first);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBe(first);
    expect(history.redo()).toBe(second);
    expect(history.redo()).toBeNull();
  });

  it('discards the redo tail when a new edit lands on it', () => {
    const history = new WorldHistory();
    history.push(terrain([1]));
    history.push(terrain([2]));
    history.undo();

    const fresh = terrain([3]);
    history.push(fresh);
    expect(history.canRedo).toBe(false);
    expect(history.depth).toBe(2);
    expect(history.undo()).toBe(fresh);
  });

  it('drops a stroke that touched nothing', () => {
    const history = new WorldHistory();
    // A brush dragged entirely off the map. Storing it would cost the user an undo press for
    // something they never saw happen.
    history.push(terrain([]));
    history.push(carve([]));
    expect(history.depth).toBe(0);
    expect(history.canUndo).toBe(false);
  });

  it('keeps a placement edit even when both sides are empty', () => {
    const history = new WorldHistory();
    // Unlike a stroke, an empty placement list is a real state — it is what removing the last
    // building leaves behind, and it has to be undoable back to the one before.
    history.push(placements);
    expect(history.depth).toBe(1);
  });

  it('evicts the oldest entries past the depth ceiling', () => {
    const history = new WorldHistory({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) history.push(terrain([i]));
    expect(history.depth).toBe(3);

    // The cursor moved down with the eviction, so undo still walks the entries that survived
    // rather than running off the bottom of a stack that is shorter than it thinks.
    expect(history.undo()).not.toBeNull();
    expect(history.undo()).not.toBeNull();
    expect(history.undo()).not.toBeNull();
    expect(history.undo()).toBeNull();
  });

  it('evicts on bytes as well as on depth', () => {
    // One big flatten is worth far more memory than a hundred small dabs; a depth limit alone
    // cannot bound a stack whose entries may each be the whole map.
    const wide = terrain(Array.from({ length: 4_000 }, (_, i) => i));
    const history = new WorldHistory({ maxBytes: wide.columns.byteLength * 2 });
    history.push(wide);
    history.push(terrain(Array.from({ length: 4_000 }, (_, i) => i)));
    history.push(terrain(Array.from({ length: 4_000 }, (_, i) => i)));

    expect(history.depth).toBeLessThan(3);
    expect(history.bytes).toBeLessThanOrEqual(wide.columns.byteLength * 2 * 5);
  });

  it('counts a carve by its encoded blobs', () => {
    const history = new WorldHistory();
    history.push(carve(['0,0,0', '0,1,0']));
    expect(history.bytes).toBeGreaterThan(0);
    expect(history.depth).toBe(1);
  });

  it('forgets everything on clear', () => {
    const history = new WorldHistory();
    history.push(terrain([1]));
    history.push(terrain([2]));
    history.clear();
    expect(history.depth).toBe(0);
    expect(history.bytes).toBe(0);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});
