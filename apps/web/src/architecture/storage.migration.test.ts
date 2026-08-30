/**
 * Carrying saved plans across the rename.
 *
 * A floorplan is an hour of work that exists nowhere else — not on the server, not in the URL,
 * only in this browser under a key whose name just changed. Renaming without carrying them
 * over does not throw and does not warn: the tool simply opens on an empty canvas, and every
 * plan anyone had is still sitting there under a name nothing reads.
 *
 * The migration runs at module load, so each case has to reset the module registry and set up
 * storage before importing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const AUTOSAVE = 'craftmagic.architecture.autosave';
const SAVED = 'craftmagic.architecture.plans';
const LEGACY_AUTOSAVE = 'craftmagic.layouter.autosave';
const LEGACY_SAVED = 'craftmagic.layouter.plans';
const FLAG = 'craftmagic.architecture.migrated';

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    store: map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

function install(storage: unknown) {
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
}

/** A plan shaped enough to survive `normalizePlan`. */
function plan(name: string) {
  return {
    version: 1,
    id: `p_${name}`,
    name,
    site: { x: 48, z: 48 },
    storeyHeight: 5,
    wallThickness: 1,
    foundation: 0,
    roof: 'gable',
    roofPitch: 'classic',
    roofOverhang: 1,
    kitId: 'oak',
    floors: [{ id: 'f1', name: 'Ground', items: [] }],
    updatedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe('the layouter → architecture key migration', () => {
  it('carries an autosaved plan over', async () => {
    const storage = fakeStorage({ [LEGACY_AUTOSAVE]: JSON.stringify(plan('Half-drawn cottage')) });
    install(storage);

    const { loadAutosave } = await import('./storage.js');
    expect(loadAutosave()?.name).toBe('Half-drawn cottage');
  });

  it('carries named saves over', async () => {
    const saved = [{ id: 'a', name: 'Keep', updatedAt: new Date().toISOString(), plan: plan('Keep') }];
    const storage = fakeStorage({ [LEGACY_SAVED]: JSON.stringify(saved) });
    install(storage);

    const { listSaved } = await import('./storage.js');
    expect(listSaved().map((entry) => entry.name)).toEqual(['Keep']);
  });

  it('leaves the legacy keys in place', async () => {
    // A tab still open on the previous deploy keeps writing to the old names. Deleting them
    // here would throw away whatever that tab saves next — and it is a one-way door.
    const storage = fakeStorage({ [LEGACY_AUTOSAVE]: JSON.stringify(plan('Still there')) });
    install(storage);

    await import('./storage.js');
    expect(storage.getItem(LEGACY_AUTOSAVE)).not.toBeNull();
  });

  it('never overwrites a plan made since the rename', async () => {
    // The dangerous direction: an older plan under the legacy key clobbering current work.
    const storage = fakeStorage({
      [LEGACY_AUTOSAVE]: JSON.stringify(plan('Old')),
      [AUTOSAVE]: JSON.stringify(plan('Current')),
    });
    install(storage);

    const { loadAutosave } = await import('./storage.js');
    expect(loadAutosave()?.name).toBe('Current');
  });

  it('runs once, so a later legacy write cannot come back and clobber', async () => {
    const storage = fakeStorage({ [LEGACY_AUTOSAVE]: JSON.stringify(plan('First')) });
    install(storage);

    await import('./storage.js');
    expect(storage.getItem(FLAG)).toBe('1');

    // Simulate the old tab saving again, then a fresh load of this module.
    storage.setItem(LEGACY_AUTOSAVE, JSON.stringify(plan('From the old tab')));
    storage.setItem(AUTOSAVE, JSON.stringify(plan('Mine')));
    vi.resetModules();

    const { loadAutosave } = await import('./storage.js');
    expect(loadAutosave()?.name).toBe('Mine');
  });

  it('does nothing, and throws nothing, when there is nothing to carry', async () => {
    install(fakeStorage());
    const { loadAutosave, listSaved } = await import('./storage.js');
    expect(loadAutosave()).toBeNull();
    expect(listSaved()).toEqual([]);
  });

  it('survives storage being blocked entirely', async () => {
    // Private mode, or an embedded context. A throw here would white-screen the whole mode
    // over a housekeeping task that nobody asked for.
    install({
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    });

    const { loadAutosave, listSaved } = await import('./storage.js');
    expect(loadAutosave()).toBeNull();
    expect(listSaved()).toEqual([]);
  });
});
