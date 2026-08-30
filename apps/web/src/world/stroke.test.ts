import { describe, expect, it } from 'vitest';
import { createWorld, raiseDisc, setStratum, stampDisc, type Terrain } from '@craftmagic/core';
import { TerrainStroke, applyTerrainDelta, interpolate } from './stroke.js';

function world() {
  return createWorld({ size: { x: 32, z: 32 }, seaLevel: 64, minY: -64, maxY: 200 });
}

describe('TerrainStroke', () => {
  it('keeps the value from a column’s first touch, not its last', () => {
    const doc = world();
    const stroke = new TerrainStroke();
    const index = 5 * 32 + 5;
    const original = doc.terrain.height[index]!;

    // Two dabs on the same column, as a drag that crosses its own path does constantly.
    stroke.note(doc.terrain, index);
    doc.terrain.height[index] = original + 10;
    stroke.note(doc.terrain, index);
    doc.terrain.height[index] = original + 20;

    const delta = stroke.finish(doc.terrain);
    expect(delta.beforeHeight[0]).toBe(original);
    expect(delta.afterHeight[0]).toBe(original + 20);
  });

  it('drops columns that came back to where they started', () => {
    const doc = world();
    const stroke = new TerrainStroke();
    const moved = 3;
    const settled = 9;

    stroke.note(doc.terrain, moved);
    doc.terrain.height[moved] = doc.terrain.height[moved]! + 4;
    stroke.note(doc.terrain, settled);
    // Touched and put straight back — a raise the user immediately lowered by the same amount.
    doc.terrain.height[settled] = doc.terrain.height[settled]!;

    expect(stroke.touched).toBe(2);
    expect(stroke.finish(doc.terrain).columns).toEqual(Uint32Array.from([moved]));
  });

  it('records a stratum change even when the height did not move', () => {
    const doc = world();
    const stroke = new TerrainStroke();
    stroke.note(doc.terrain, 7);
    setStratum(doc.terrain, doc.settings, 7, 2);

    const delta = stroke.finish(doc.terrain);
    expect(delta.columns.length).toBe(1);
    expect(delta.beforeStratum[0]).toBe(0);
    expect(delta.afterStratum[0]).toBe(2);
  });

  it('round-trips a real brush stroke through undo and redo', () => {
    const doc = world();
    const before = Int16Array.from(doc.terrain.height);

    // Noted through `stampDisc` with the same brush the write uses, which is exactly what the
    // map's stroke path does — noting a guessed range instead leaves the columns at the rim
    // unrecorded, and undo then restores a hill with its edges still raised.
    const brush = { radius: 3, strength: 5, falloff: 'flat' } as const;
    const stroke = new TerrainStroke();
    stampDisc(doc.terrain, doc.settings, 2, 2, brush, (column) => stroke.note(doc.terrain, column.index));
    raiseDisc(doc.terrain, doc.settings, 2, 2, brush);
    const delta = stroke.finish(doc.terrain);
    const after = Int16Array.from(doc.terrain.height);

    expect(after).not.toEqual(before);

    applyTerrainDelta(doc.terrain, delta, 'before');
    expect(doc.terrain.height).toEqual(before);

    applyTerrainDelta(doc.terrain, delta, 'after');
    expect(doc.terrain.height).toEqual(after);
  });

  it('survives a delta applied to a terrain that has since shrunk', () => {
    const doc = world();
    const stroke = new TerrainStroke();
    stroke.note(doc.terrain, 900);
    doc.terrain.height[900] = 90;
    const delta = stroke.finish(doc.terrain);

    const small: Terrain = { height: new Int16Array(16), strata: new Uint8Array(16) };
    // Out of range rather than out of bounds: the entry is skipped, not written past the end.
    expect(() => applyTerrainDelta(small, delta, 'before')).not.toThrow();
    expect(small.height.every((value) => value === 0)).toBe(true);
  });
});

describe('interpolate', () => {
  it('fills the gap a fast drag leaves between two samples', () => {
    const seen: string[] = [];
    interpolate(0, 0, 5, 0, (x, z) => seen.push(`${x},${z}`));
    expect(seen).toEqual(['0,0', '1,0', '2,0', '3,0', '4,0', '5,0']);
  });

  it('walks a diagonal without skipping either axis', () => {
    const seen: Array<[number, number]> = [];
    interpolate(0, 0, 4, 4, (x, z) => seen.push([x, z]));
    expect(seen[0]).toEqual([0, 0]);
    expect(seen[seen.length - 1]).toEqual([4, 4]);
    // Every step moves by at most one column on each axis, which is what makes the painted
    // line continuous rather than dotted.
    for (let i = 1; i < seen.length; i++) {
      expect(Math.abs(seen[i]![0] - seen[i - 1]![0])).toBeLessThanOrEqual(1);
      expect(Math.abs(seen[i]![1] - seen[i - 1]![1])).toBeLessThanOrEqual(1);
    }
  });

  it('emits a single column when the drag has not moved', () => {
    const seen: string[] = [];
    interpolate(7, 7, 7, 7, (x, z) => seen.push(`${x},${z}`));
    expect(seen).toEqual(['7,7']);
  });

  it('terminates on a NaN coordinate rather than spinning forever', () => {
    let count = 0;
    interpolate(0, 0, Number.NaN, 0, () => count++);
    // The guard is what matters: a frozen tab is a far worse bug than a dropped dab.
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(4096);
  });
});
