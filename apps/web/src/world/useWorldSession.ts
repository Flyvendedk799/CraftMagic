import { WorkingCopies } from '../studio/workspace/retention.js';
/**
 * World mode's session: the document, its undo stack, and where it is kept.
 *
 * One thing here departs from every other session hook in this app, and it is deliberate.
 * `usePlanSession` treats the plan as immutable and replaces it on every change, which is the
 * right model for a few hundred rooms. A world's heightfield is a 3 MB `Int16Array`, and
 * copying it on every pointer move — sixty times a second, for the length of a drag — would
 * make the Leveler unusable on any map worth sculpting. So the terrain arrays are **mutated in
 * place**, and `revision` is what tells React something changed.
 *
 * That trade has a cost and it is worth naming: nothing can rely on identity to detect a
 * change, so every consumer keys off `revision`. In exchange, a drag allocates nothing, and
 * undo is still exact because `TerrainStroke` records the original value of each column rather
 * than relying on a snapshot to diff against.
 *
 * Everything else follows Architecture mode: live edits during a gesture, one history entry on
 * release, and a debounced autosave so a drag writes once instead of on every frame.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cloneWorld,
  createWorld,
  normalizeWorld,
  type Overlay,
  type WorldDoc,
  type WorldPlacement,
  type WorldSettings,
} from '@craftmagic/core';
import { WorldHistory, type WorldDelta } from './history.js';
import { worldHistoryFor } from '../studio/retainHistory.js';
import { invalidateJournalDocument, recordChange } from '../studio/journal.js';
import { TerrainStroke, applyTerrainDelta } from './stroke.js';
import { loadDraft, saveDraft, type SavedWorld } from './storage.js';
import { localStore, type WorldStore } from './api.js';

/** Long enough that a drag writes once, short enough that a closed tab loses nothing real. */
const AUTOSAVE_DELAY = 600;
// IndexedDB writes are asynchronous. Keep the most recent unmounted document in memory so a
// rapid World → Build → World trip cannot read the previous draft before the flush commits.
const workingWorlds = new WorkingCopies<{doc:WorldDoc;dirty:boolean}>(12,64*1024*1024);

export function invalidateWorkingWorld(documentKey: string): void { workingWorlds.invalidate(documentKey); invalidateJournalDocument('world',documentKey); }

export interface WorldSession {
  doc: WorldDoc;
  historyId: string;
  /** Bumped whenever the document changes, including in-place terrain writes. */
  revision: number;
  /** True until the stored draft has been read; the map should not paint over it meanwhile. */
  loading: boolean;

  /** Open a terrain gesture. Tools then write into `doc.terrain` directly. */
  beginStroke: () => TerrainStroke;
  /** Close it, recording one undo entry for the whole drag. */
  endStroke: (stroke: TerrainStroke) => void;
  /** Redraw without recording — a live drag frame. */
  touch: () => void;

  commitCarve: (before: Overlay, after: Overlay, keys: string[]) => void;
  commitPlacements: (next: WorldPlacement[]) => void;
  commitSettings: (mutate: (doc: WorldDoc) => WorldDoc) => void;
  rename: (name: string) => void;

  undo: () => boolean;
  redo: () => boolean;
  canUndo: boolean;
  canRedo: boolean;
  historyDepth: number;

  /**
   * The revision the local draft was last written at.
   *
   * Exposed because the autosave is debounced, so "has this been persisted yet" is a real
   * question with a real answer, and the alternative is every caller — the headless drivers
   * included — sleeping for a guessed interval and being wrong some of the time.
   */
  draftRevision: number;

  saved: SavedWorld[];
  save: () => Promise<boolean>;
  saving: boolean;
  saveError: string | null;
  open: (doc: WorldDoc) => void;
  remove: (id: string) => Promise<boolean>;
  dirty: boolean;
}

/**
 * `store` is where named saves go — this browser when signed out, the account when signed
 * in. The draft autosave is always local and deliberately so: it fires every 600 ms during
 * a sculpting session, and that is a write to IndexedDB, not a request.
 */
export function useWorldSession(
  initial?: () => WorldDoc,
  store: WorldStore = localStore,
  documentKey = 'open-world',
): WorldSession {
  const recovered = useRef(workingWorlds.get(documentKey));
  const cacheVersion = useRef(workingWorlds.version(documentKey));
  const docRef = useRef<WorldDoc | null>(null);
  if (docRef.current === null) docRef.current = recovered.current ? cloneWorld(recovered.current.doc) : normalizeWorld(initial ? initial() : createWorld());

  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<SavedWorld[]>([]);
  const [savedRevision, setSavedRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveInFlight = useRef<Promise<boolean> | null>(null);
  const revisionRef = useRef(0);
  const loadedRef = useRef(false);
  const [draftRevision, setDraftRevision] = useState(0);

  const historyRef = useRef<WorldHistory | null>(null);
  // One stack for the world on screen. Keyed constantly rather than by document id: the id
  // is minted again on every remount, before the draft is read back, and keying on it would
  // hand back an empty stack every time you returned to the map.
  const history = (historyRef.current ??= worldHistoryFor(documentKey));

  const bump = useCallback(() => {
    const next = ++revisionRef.current;
    setRevision(next);
    return next;
  }, []);

  /**
   * The draft is read once, at mount, and this effect must never gain a dependency.
   *
   * It briefly had `store`, so that listing and loading could share one effect, and the bug
   * that bought was subtle and intermittent: `store` changes identity exactly once, when auth
   * resolves from loading to signed-in-or-not, which lands a few hundred milliseconds into the
   * session. Re-running the effect then re-read the draft — the draft as it was *before*
   * anything done in those few hundred milliseconds, because the autosave is debounced — and
   * assigned it over the live document. Sculpt quickly enough after opening the page and your
   * first strokes vanished, then autosaved themselves away. Two runs in three of the world
   * driver caught it; a person would have called it flaky and moved on.
   */
  useEffect(() => {
    let live = true;
    void (recovered.current ? Promise.resolve(cloneWorld(recovered.current.doc)) : documentKey === 'open-world' || documentKey === '/studio?mode=world' ? loadDraft() : Promise.resolve(null)).then((draft) => {
      if (!live) return;
      if (draft) docRef.current = draft;
      loadedRef.current = true;
      setLoading(false);
      const loadedRevision = bump();
      // A fresh blank map has nothing to save yet. A recovered draft may differ from the
      // named account save, so it stays dirty until the user saves it explicitly.
      if (!draft || recovered.current && !recovered.current.dirty) setSavedRevision(loadedRevision);
    });
    return () => {
      live = false;
    };
  }, [bump]);

  // The saved list, on the other hand, *should* follow the store: signing in has to replace
  // this browser's worlds with the account's.
  useEffect(() => {
    let live = true;
    void store.list().then((rows) => {
      if (live) setSaved(rows);
    }).catch(() => { if (live) setSaveError('Could not load your saved worlds. Open Your work and retry loading.'); });
    return () => {
      live = false;
    };
  }, [store]);

  // Debounced draft autosave. `revision` is the trigger rather than the document, because the
  // document's identity deliberately does not change when terrain does.
  useEffect(() => {
    if (loading || revision === 0) return;
    const timer = setTimeout(() => {
      const doc = docRef.current;
      if (!doc) return;
      // Recorded only once the write resolves. Marking it saved when the write *starts*
      // would be a promise the page cannot keep — IndexedDB can refuse, and a private
      // window refuses everything.
      void saveDraft(doc).then((ok) => {
        if (ok) setDraftRevision(revision);
      });
    }, AUTOSAVE_DELAY);
    return () => clearTimeout(timer);
  }, [revision, loading]);

  /**
   * And flush on the way out, for the reason Architecture now does.
   *
   * `clearTimeout` cancels the pending write; it does not perform it. Switching modes
   * within the debounce window — the studio unmounts the page to do it — dropped the last
   * 600 ms of sculpting. Reading `docRef` at cleanup is right here where it would be wrong
   * in the editor: the document is mutated in place and the ref points at the live one, so
   * there is no stale-identity problem to avoid.
   */
  const dirtyRef = useRef(false);
  dirtyRef.current = revision !== savedRevision;
  useEffect(
    () => () => {
      const doc = docRef.current;
      if (doc && loadedRef.current) {
        const snapshot = cloneWorld(doc);
        workingWorlds.setIfCurrent(documentKey, {doc:snapshot,dirty:dirtyRef.current}, snapshot.terrain.height.byteLength + snapshot.terrain.strata.byteLength + JSON.stringify(snapshot.placements).length*2 + Object.values(snapshot.overlay).reduce((sum,chunk)=>sum+chunk.data.length*2 + JSON.stringify(chunk.palette).length*2,0), cacheVersion.current);
        void saveDraft(snapshot);
      }
    },
    [],
  );

  const stamp = useCallback(() => {
    const doc = docRef.current;
    if (doc) doc.updatedAt = new Date().toISOString();
  }, []);

  const beginStroke = useCallback(() => new TerrainStroke(), []);

  const note = useCallback(() => recordChange('world', documentKey, 'Edit world'), []);

  const endStroke = useCallback(
    (stroke: TerrainStroke) => {
      const doc = docRef.current;
      if (!doc) return;
      if (history.push(stroke.finish(doc.terrain))) note();
      stamp();
      bump();
    },
    [history, stamp, bump, note],
  );

  const commitCarve = useCallback(
    (before: Overlay, after: Overlay, keys: string[]) => {
      if (history.push({ kind: 'carve', before, after, keys })) note();
      stamp();
      bump();
    },
    [history, stamp, bump, note],
  );

  const commitPlacements = useCallback(
    (next: WorldPlacement[]) => {
      const doc = docRef.current;
      if (!doc) return;
      if (history.push({ kind: 'placements', before: doc.placements, after: next })) note();
      doc.placements = next;
      stamp();
      bump();
    },
    [history, stamp, bump, note],
  );

  /**
   * A change that rewrites the document — a resize, a new stratum, a different sea level.
   *
   * These carry snapshots rather than deltas, and the cost is real: a resize of a large world
   * is two 3 MB clones. They are also the edits a user most wants back, and they happen twice
   * a session rather than sixty times a second, which is the whole reason the cheap path
   * exists separately.
   */
  const commitSettings = useCallback(
    (mutate: (doc: WorldDoc) => WorldDoc) => {
      const doc = docRef.current;
      if (!doc) return;
      const before = cloneWorld(doc);
      const after = normalizeWorld(mutate(doc));
      docRef.current = after;
      if (history.push({
        kind: 'snapshot',
        before,
        after: cloneWorld(after),
        bytes: terrainBytes(before.settings) + terrainBytes(after.settings),
      })) note();
      stamp();
      bump();
    },
    [history, stamp, bump, note],
  );

  const rename = useCallback(
    (name: string) => {
      const doc = docRef.current;
      if (!doc) return;
      doc.name = name;
      stamp();
      bump();
    },
    [stamp, bump],
  );

  /**
   * Reverse or replay one entry.
   *
   * Shared by undo and redo because the only difference between them is which side of the
   * delta gets written — a distinction worth exactly one parameter, against two functions
   * that would drift apart the first time a fifth delta kind is added.
   */
  const applyDelta = useCallback((delta: WorldDelta, side: 'before' | 'after') => {
    const doc = docRef.current;
    if (!doc) return;
    switch (delta.kind) {
      case 'terrain':
        applyTerrainDelta(doc.terrain, delta, side);
        break;
      case 'carve': {
        const source = side === 'before' ? delta.before : delta.after;
        for (const key of delta.keys) {
          const chunk = source[key];
          // Absent on this side means the chunk did not exist then, so restoring it is a
          // delete. Assigning undefined instead would leave a hole the encoder would trip on.
          if (chunk) doc.overlay[key] = chunk;
          else delete doc.overlay[key];
        }
        break;
      }
      case 'placements':
        doc.placements = side === 'before' ? delta.before : delta.after;
        break;
      case 'snapshot': {
        const target = side === 'before' ? delta.before : delta.after;
        docRef.current = normalizeWorld(target);
        break;
      }
    }
  }, []);

  const undo = useCallback((): boolean => {
    const delta = history.undo();
    if (!delta) return false;
    applyDelta(delta, 'before');
    stamp();
    bump();
    return true;
  }, [history, applyDelta, stamp, bump]);

  const redo = useCallback((): boolean => {
    const delta = history.redo();
    if (!delta) return false;
    applyDelta(delta, 'after');
    stamp();
    bump();
    return true;
  }, [history, applyDelta, stamp, bump]);

  const save = useCallback((): Promise<boolean> => {
    const doc = docRef.current;
    if (!doc) return Promise.resolve(false);
    if (saveInFlight.current) return saveInFlight.current;
    const savingRevision = revisionRef.current;
    setSaving(true);
    setSaveError(null);
    const task = store.save(doc).then(async (id) => {
      if (!id) throw new Error('Storage did not accept this map.');
      // A first account save gets a server id. A later edit during the request must still
      // remain dirty, so only the revision actually sent is marked as saved.
      if (docRef.current === doc) {
        doc.id = id;
        setSavedRevision(savingRevision);
      }
      try { setSaved(await store.list()); } catch { /* The save succeeded; the list can refresh later. */ }
      return true;
    }).catch((error: unknown) => {
      setSaveError((error as Error).message);
      return false;
    }).finally(() => {
      saveInFlight.current = null;
      setSaving(false);
    });
    saveInFlight.current = task;
    return task;
  }, [store]);

  const open = useCallback(
    (doc: WorldDoc) => {
      const next = normalizeWorld(doc);
      const same = docRef.current?.id === next.id;
      docRef.current = next;
      // Opening a different map starts a fresh stack. Re-opening the one already on screen
      // — including the remount a mode switch causes — must not throw the sculpting away.
      if (!same) { history.clear(); invalidateJournalDocument('world',documentKey); }
      const openedRevision = bump();
      setSavedRevision(openedRevision);
      setSaveError(null);
    },
    [history, bump],
  );

  const remove = useCallback(async (id: string) => {
    try {
      const ok = await store.remove(id);
      if (!ok) return false;
      setSaved(await store.list());
      return true;
    } catch {
      return false;
    }
  }, [store]);

  return useMemo(
    () => ({
      doc: docRef.current!,
      revision,
      historyId: documentKey,
      loading,
      beginStroke,
      endStroke,
      touch: bump,
      commitCarve,
      commitPlacements,
      commitSettings,
      rename,
      undo,
      redo,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      historyDepth: history.depth,
      draftRevision,
      saved,
      save,
      saving,
      saveError,
      open,
      remove,
      dirty: revision !== savedRevision,
    }),
    [
      revision, loading, beginStroke, endStroke, bump, commitCarve, commitPlacements,
      commitSettings, rename, undo, redo, history, saved, save, open, remove, savedRevision,
      draftRevision, saving, saveError,
    ],
  );
}

/** Both terrain arrays, for the history's byte ceiling. Three bytes a column. */
function terrainBytes(settings: WorldSettings): number {
  return settings.size.x * settings.size.z * 3;
}
