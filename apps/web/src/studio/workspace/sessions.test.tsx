// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { createPlan } from '../../architecture/plan.js';
import { usePlanSession } from '../../architecture/usePlanSession.js';
import { createWorld } from '@craftmagic/core';
import { useWorldSession } from '../../world/useWorldSession.js';
import { resetStorage } from '../../world/storage.js';
import { journalSnapshot, resetJournal } from '../journal.js';
import { useStoredState } from './storage.js';
import type { WorldStore } from '../../world/api.js';
const wrapper = ({ children }: { children: ReactNode }) => (
  <StrictMode>{children}</StrictMode>
);
beforeEach(() => {
  localStorage.clear();
  resetJournal();
  vi.stubGlobal('indexedDB', fakeIndexedDB);
  resetStorage();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
let serial = 0;
const key = (kind: string) =>
  `/studio?mode=${kind}&${kind === 'arch' ? 'plan' : 'world'}=test-${++serial}`;
describe('document sessions', () => {
  it('records one plan commit and one undo under StrictMode', () => {
    const hook = renderHook(() => usePlanSession(() => createPlan(), keyRef), {
      wrapper,
    });
    const before = hook.result.current.plan;
    act(() => hook.result.current.commit({ ...before, name: 'Changed' }));
    expect(journalSnapshot().frames).toHaveLength(1);
    expect(hook.result.current.plan.name).toBe('Changed');
    act(() => {
      expect(hook.result.current.undo()).toBe(true);
    });
    expect(hook.result.current.plan.name).toBe(before.name);
    act(() => {
      expect(hook.result.current.redo()).toBe(true);
    });
    expect(hook.result.current.plan.name).toBe('Changed');
  });
  const keyRef = key('arch');
  it('retains two different floorplans and their undo histories independently', () => {
    const a = key('arch'),
      b = key('arch');
    let one = renderHook(() =>
      usePlanSession(() => createPlan({ name: 'A' }), a),
    );
    act(() => one.result.current.commit((p) => ({ ...p, name: 'Edited A' })));
    one.unmount();
    const two = renderHook(() =>
      usePlanSession(() => createPlan({ name: 'B' }), b),
    );
    act(() => two.result.current.commit((p) => ({ ...p, name: 'Edited B' })));
    two.unmount();
    one = renderHook(() => usePlanSession(() => createPlan(), a));
    expect(one.result.current.plan.name).toBe('Edited A');
    expect(one.result.current.dirty).toBe(true);
    act(() => one.result.current.undo());
    expect(one.result.current.plan.name).toBe('A');
  });
  it('marks a no-op plan commit as neither dirty nor undoable', () => {
    const hook = renderHook(() =>
      usePlanSession(() => createPlan(), key('arch')),
    );
    act(() => hook.result.current.commit((p) => p));
    expect(hook.result.current.dirty).toBe(false);
    expect(journalSnapshot().frames).toHaveLength(0);
  });
  it('does not announce a saved plan after localStorage refuses it', () => {
    const id = key('arch'),
      hook = renderHook(() => usePlanSession(() => createPlan(), id));
    act(() => hook.result.current.commit((p) => ({ ...p, name: 'Keep me' })));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });
    act(() => {
      expect(hook.result.current.save()).toBe(false);
    });
    expect(hook.result.current.dirty).toBe(true);
    expect(hook.result.current.saveError).toMatch(/could not save/i);
  });
  it('keeps repeated preference updates ordered and exposes write failures', () => {
    const hook = renderHook(
      () => useStoredState('test.preferences', (raw) => Number(raw ?? 0)),
      { wrapper },
    );
    act(() => {
      hook.result.current[1]((n) => n + 1);
      hook.result.current[1]((n) => n + 1);
    });
    expect(hook.result.current[0]).toBe(2);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw Error('Full');
    });
    act(() => hook.result.current[1](3));
    expect(hook.result.current[0]).toBe(3);
    expect(hook.result.current[2]).toMatch(/could not be saved/);
  });
  it('isolates world sessions and refuses to mark an unsuccessful save clean', async () => {
    const store: WorldStore = {
      list: async () => [],
      load: async () => null,
      remove: async () => false,
      save: async () => null,
    };
    const id = key('world'),
      hook = renderHook(() =>
        useWorldSession(
          () => createWorld({ size: { x: 32, z: 32 } }),
          store,
          id,
        ),
      );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => hook.result.current.rename('My map'));
    let saved = true;
    await act(async () => {
      saved = await hook.result.current.save();
    });
    expect(saved).toBe(false);
    expect(hook.result.current.dirty).toBe(true);
    expect(hook.result.current.saveError).toMatch(/did not accept/);
  });
});

import { requestWorkbenchSave } from '../workbench.js';
it('keyboard and palette save failures are surfaced without an unhandled rejection', async () => {
  const failed = vi.fn();
  window.addEventListener('studio:save-error', failed);
  const save = vi.fn(async () => {
    throw Error('Fixture save refused');
  });
  requestWorkbenchSave({
    save,
    canSave: true,
    saveLabel: 'Save',
    create: () => {},
  });
  await waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
  expect((failed.mock.calls[0]![0] as CustomEvent).detail.message).toBe(
    'Fixture save refused',
  );
  requestWorkbenchSave({
    save,
    canSave: false,
    saveLabel: 'Save',
    create: () => {},
  });
  expect(save).toHaveBeenCalledTimes(1);
  window.removeEventListener('studio:save-error', failed);
});
