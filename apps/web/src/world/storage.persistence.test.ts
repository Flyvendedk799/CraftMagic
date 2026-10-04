import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createWorld } from '@craftmagic/core';
import {
  resetStorage,
  saveDraft,
  saveWorld,
  loadDraft,
  loadWorld,
  deleteWorld,
  listWorlds,
} from './storage.js';
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  resetStorage();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetStorage();
});
describe('world persistence commits', () => {
  it('round trips drafts and named maps without listing the recovery slot', async () => {
    const world = createWorld({ size: { x: 32, z: 32 } });
    world.name = 'Saved map';
    expect(await saveDraft(world)).toBe(true);
    expect((await loadDraft())?.name).toBe('Saved map');
    expect(await listWorlds()).toHaveLength(0);
    expect(await saveWorld(world)).toBe(true);
    expect((await loadWorld(world.id))?.id).toBe(world.id);
    expect(await listWorlds()).toHaveLength(1);
    expect(await deleteWorld(world.id)).toBe(true);
    expect(await loadWorld(world.id)).toBeNull();
  });
  it('returns false, not a fake success, when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    resetStorage();
    const world = createWorld({ size: { x: 32, z: 32 } });
    expect(await saveWorld(world)).toBe(false);
    expect(await saveDraft(world)).toBe(false);
    expect(await deleteWorld(world.id)).toBe(false);
  });
  it('does not call a blocked connection a successful save', async () => {
    vi.stubGlobal('indexedDB', {
      open() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    resetStorage();
    expect(await saveWorld(createWorld({ size: { x: 32, z: 32 } }))).toBe(
      false,
    );
  });
});
