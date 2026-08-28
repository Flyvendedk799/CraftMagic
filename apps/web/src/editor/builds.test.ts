import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildProgram, VoxelGrid } from '@craftmagic/core';

/**
 * How a generated build survives the hop from the editor to the guide.
 *
 * The bug these cover: the guide opens through `<a target="_blank">`, and in Chromium a
 * link-opened tab starts with an *empty* sessionStorage — verified, and unlike a same-tab
 * navigation or `window.open`, which both inherit one. Generated programs lived in
 * sessionStorage, so the guide tab could not resolve `gen:1`, and `GuidePage` quietly fell
 * back to the sample cottage. Every AI build printed as "Oak Cottage".
 *
 * A new tab is modelled as a fresh module instance over the *same* storage, which is exactly
 * what it is: `builds.ts` restores at import.
 */

function program(name: string): BuildProgram {
  return {
    version: 1,
    meta: { name },
    size: { x: 8, y: 8, z: 8 },
    palette: { wall_primary: 'minecraft:oak_planks' },
    components: [{ type: 'box', pos: [0, 0, 0], size: [4, 4, 4], fill: { type: 'solid', role: 'wall_primary' } }],
  };
}

/** A localStorage stand-in whose contents outlive a module reload, as the real one does. */
function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    snapshot: () => Object.fromEntries(data),
  };
}

/** Import `builds.ts` fresh, as a newly-opened tab would. */
async function openTab(store: ReturnType<typeof storage>) {
  vi.resetModules();
  vi.stubGlobal('localStorage', store);
  // Nothing may read sessionStorage any more — a link-opened tab's is empty, which is the
  // whole bug. Throwing here fails the test rather than silently losing the build again.
  vi.stubGlobal('sessionStorage', {
    getItem: () => { throw new Error('sessionStorage must not be used to carry generated builds'); },
    setItem: () => { throw new Error('sessionStorage must not be used to carry generated builds'); },
  });
  return import('./builds.js');
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('generated builds across tabs', () => {
  it('resolves in a tab that was opened by a link', async () => {
    const store = storage();

    const editor = await openTab(store);
    const id = editor.registerGeneratedBuild(program('Stone Keep'));
    expect(editor.isBuildId(id)).toBe(true);

    // The guide, in its own tab: a fresh module instance over the same disk.
    const guide = await openTab(store);
    expect(guide.isBuildId(id)).toBe(true);
    expect(guide.expandBuild(id).name).toBe('Stone Keep');
  });

  it('reports an unknown id as unknown rather than resolving to something else', async () => {
    // An empty store is what a link-opened tab used to get. The guide must be able to tell
    // that `gen:1` is unavailable — its old fallback to the cottage is what printed the
    // wrong build with no warning.
    const guide = await openTab(storage());
    expect(guide.isBuildId('gen:1')).toBe(false);
    expect(() => guide.expandBuild('gen:1')).toThrow(/unknown build/);
  });

  it('never re-mints an id that is still in a URL somewhere', async () => {
    const store = storage();
    const editor = await openTab(store);

    // Past the cap, so the oldest entries are evicted while the counter keeps climbing.
    const ids: string[] = [];
    for (let i = 0; i < 45; i++) ids.push(editor.registerGeneratedBuild(program(`Build ${i}`)));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe('gen:45');

    // The survivors are the newest, and each still holds its own build.
    const guide = await openTab(store);
    expect(guide.isBuildId('gen:45')).toBe(true);
    expect(guide.expandBuild('gen:45').name).toBe('Build 44');
    expect(guide.isBuildId('gen:1')).toBe(false);
  });

  it('merges what another tab generated before minting an id', async () => {
    const store = storage();

    const tabA = await openTab(store);
    tabA.registerGeneratedBuild(program('From A'));

    // B opened before A generated, so its in-memory map is empty — but the id it mints must
    // still not collide with A's.
    const tabB = await openTab(storage(store.snapshot()));
    const second = tabB.registerGeneratedBuild(program('From B'));
    expect(second).toBe('gen:2');
  });
});

/**
 * A generated build opens at the size it was asked for.
 *
 * The program describes the structure at whatever size the model designed it, and carries the
 * scale that brings it down to the size the user chose before generating. Two things have to
 * be true for the size control to be honest about that: it has to start on the build's real
 * size, and dragging it back to 100% has to actually take the fitting off.
 */
describe('a build fitted to a chosen size', () => {
  /** The same 8-block program, generated for someone who asked for a small build. */
  function fitted(name: string): BuildProgram {
    return { ...program(name), scale: { x: 50, y: 50, z: 50 } };
  }

  it('reports the scale it was fitted to, so the slider can open on it', async () => {
    const builds = await openTab(storage());
    const id = builds.registerGeneratedBuild(fitted('Fitted'));

    expect(builds.programScale(id)).toEqual({ x: 50, y: 50, z: 50 });
    // A build nobody resized has nothing to report, and the slider stays at 100.
    expect(builds.programScale(builds.registerGeneratedBuild(program('Plain')))).toBeNull();
  });

  it('builds at the fitted size when the caller has no opinion', async () => {
    const builds = await openTab(storage());
    const id = builds.registerGeneratedBuild(fitted('Fitted'));

    expect(builds.expandBuild(id).grid.size).toEqual({ x: 4, y: 4, z: 4 });
  });

  it('takes the fitting off when the size control is dragged back to 100%', async () => {
    // An explicit 100% is an instruction, not the absence of one. Reading it as "no opinion"
    // left the build shrunk while the slider claimed it was at full size.
    const builds = await openTab(storage());
    const id = builds.registerGeneratedBuild(fitted('Fitted'));

    const full = builds.expandBuild(id, { scale: { x: 100, y: 100, z: 100 } });
    expect(full.grid.size).toEqual({ x: 8, y: 8, z: 8 });
    expect(full.program?.scale).toBeUndefined();
  });

  it('follows the size control anywhere else the user drags it', async () => {
    const builds = await openTab(storage());
    const id = builds.registerGeneratedBuild(fitted('Fitted'));

    expect(builds.expandBuild(id, { scale: { x: 200, y: 200, z: 200 } }).grid.size).toEqual({
      x: 16,
      y: 16,
      z: 16,
    });
  });
});

/**
 * Pictures rebuilt as blocks.
 *
 * A mural is voxels and nothing else — no program describes a photograph — so it takes the
 * same path a hand-edited build does. What is specific to it is storage: a wall is tens of
 * thousands of voxels, which is why it is kept compressed rather than as JSON, and why only a
 * few are kept at all.
 */
describe('pictures built from blocks', () => {
  /** A tiny two-colour wall, in the shape `buildMural` produces. */
  function mural(): VoxelGrid {
    const size = { x: 4, y: 2, z: 1 };
    const voxels = new Uint16Array(size.x * size.y * size.z);
    for (let i = 0; i < voxels.length; i++) voxels[i] = (i % 2) + 1;
    return { size, palette: ['minecraft:air', 'minecraft:white_wool', 'minecraft:black_wool'], voxels };
  }

  it('opens as a build like any other, with no program behind it', async () => {
    const builds = await openTab(storage());
    const id = builds.registerMuralBuild('Poster', mural());

    expect(builds.isBuildId(id)).toBe(true);
    const loaded = builds.expandBuild(id);
    expect(loaded.name).toBe('Poster');
    expect(loaded.grid.size).toEqual({ x: 4, y: 2, z: 1 });
    expect(loaded.blockCount).toBe(8);
    // Nothing parametric describes a photograph, so there is nothing to resize or refine.
    expect(loaded.program).toBeNull();
    expect(loaded.params).toEqual([]);
  });

  it('survives a reload, blocks and all', async () => {
    const store = storage();
    const first = await openTab(store);
    const id = first.registerMuralBuild('Poster', mural());

    const reopened = await openTab(store);
    const loaded = reopened.expandBuild(id);
    expect(loaded.grid.palette).toContain('minecraft:white_wool');
    expect(Array.from(loaded.grid.voxels)).toEqual(Array.from(mural().voxels));
    expect(reopened.muralBuilds().map((entry) => entry.name)).toEqual(['Poster']);
  });

  it('keeps a picture out of the editor when there is nothing to build it from', async () => {
    const builds = await openTab(storage());
    expect(builds.isBuildId('img:99')).toBe(false);
  });

  it('keeps only the most recent few, oldest dropped first', async () => {
    const builds = await openTab(storage());
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => builds.registerMuralBuild(name, mural()));

    const kept = builds.muralBuilds().map((entry) => entry.name);
    expect(kept.length).toBeLessThanOrEqual(4);
    expect(kept).toContain('f');
    expect(kept).not.toContain('a');
    // Ids are never reused, so a link to a dropped picture fails to resolve rather than
    // quietly opening a different one.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stores a picture compressed, not as a wall of numbers', async () => {
    const store = storage();
    const builds = await openTab(store);

    // A 64x64 wall: 4,096 voxels, which as a JSON array would be tens of kilobytes.
    const size = { x: 64, y: 64, z: 1 };
    const voxels = new Uint16Array(size.x * size.y * size.z).fill(1);
    builds.registerMuralBuild('Big', { size, palette: ['minecraft:air', 'minecraft:stone'], voxels });

    const stored = store.snapshot()['craftmagic.murals'] ?? '';
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThan(4096);
  });
});
