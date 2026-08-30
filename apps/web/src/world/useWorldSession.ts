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
import { TerrainStroke, applyTerrainDelta } from './stroke.js';
import { loadDraft, saveDraft, type SavedWorld } from './storage.js';
import { localStore, type WorldStore } from './api.js';

/** Long enough that a drag writes once, short enough that a closed tab loses nothing real. */
const AUTOSAVE_DELAY = 600;

export interface WorldSession {
  doc: WorldDoc;
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

  undo: () => void;
  redo: () => void;
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
  save: () => void;
  open: (doc: WorldDoc) => void;
  remove: (id: string) => void;
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
): WorldSession {
  const docRef = useRef<WorldDoc | null>(null);
  if (docRef.current === null) docRef.current = normalizeWorld(initial ? initial() : createWorld());

  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<SavedWorld[]>([]);
  const [savedRevision, setSavedRevision] = useState(0);
  const [draftRevision, setDraftRevision] = useState(0);

  const historyRef = useRef<WorldHistory | null>(null);
  const history = (historyRef.current ??= new WorldHistory());

  const bump = useCallback(() => setRevision((n) => n + 1), []);

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
    void loadDraft().then((draft) => {
      if (!live) return;
      if (draft) docRef.current = draft;
      setLoading(false);
      bump();
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
    });
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

  const stamp = useCallback(() => {
    const doc = docRef.current;
    if (doc) doc.updatedAt = new Date().toISOString();
  }, []);

  const beginStroke = useCallback(() => new TerrainStroke(), []);

  const endStroke = useCallback(
    (stroke: TerrainStroke) => {
      const doc = docRef.current;
      if (!doc) return;
      history.push(stroke.finish(doc.terrain));
      stamp();
      bump();
    },
    [history, stamp, bump],
  );

  const commitCarve = useCallback(
    (before: Overlay, after: Overlay, keys: string[]) => {
      history.push({ kind: 'carve', before, after, keys });
      stamp();
      bump();
    },
    [history, stamp, bump],
  );

  const commitPlacements = useCallback(
    (next: WorldPlacement[]) => {
      const doc = docRef.current;
      if (!doc) return;
      history.push({ kind: 'placements', before: doc.placements, after: next });
      doc.placements = next;
      stamp();
      bump();
    },
    [history, stamp, bump],
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
      history.push({
        kind: 'snapshot',
        before,
        after: cloneWorld(after),
        bytes: terrainBytes(before.settings) + terrainBytes(after.settings),
      });
      stamp();
      bump();
    },
    [history, stamp, bump],
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

  const undo = useCallback(() => {
    const delta = history.undo();
    if (!delta) return;
    applyDelta(delta, 'before');
    stamp();
    bump();
  }, [history, applyDelta, stamp, bump]);

  const redo = useCallback(() => {
    const delta = history.redo();
    if (!delta) return;
    applyDelta(delta, 'after');
    stamp();
    bump();
  }, [history, applyDelta, stamp, bump]);

  const save = useCallback(() => {
    const doc = docRef.current;
    if (!doc) return;
    void store.save(doc).then((id) => {
      // The server mints its own id on a first save, and the open document has to adopt it
      // or the next save creates a second row instead of landing on the first.
      if (id && docRef.current) docRef.current.id = id;
      void store.list().then(setSaved);
      setSavedRevision(revision);
      bump();
    });
  }, [revision, store, bump]);

  const open = useCallback(
    (doc: WorldDoc) => {
      docRef.current = normalizeWorld(doc);
      history.clear();
      setSavedRevision(0);
      bump();
    },
    [history, bump],
  );

  const remove = useCallback(
    (id: string) => {
      void store.remove(id).then(() => {
        void store.list().then(setSaved);
      });
    },
    [store],
  );

  return useMemo(
    () => ({
      doc: docRef.current!,
      revision,
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
      open,
      remove,
      dirty: revision !== savedRevision,
    }),
    [
      revision, loading, beginStroke, endStroke, bump, commitCarve, commitPlacements,
      commitSettings, rename, undo, redo, history, saved, save, open, remove, savedRevision,
      draftRevision,
    ],
  );
}

/** Both terrain arrays, for the history's byte ceiling. Three bytes a column. */
function terrainBytes(settings: WorldSettings): number {
  return settings.size.x * settings.size.z * 3;
}
