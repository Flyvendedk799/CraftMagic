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
import { loadDraft, saveDraft, listWorlds, saveWorld, deleteWorld, type SavedWorld } from './storage.js';

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

  saved: SavedWorld[];
  save: () => void;
  open: (doc: WorldDoc) => void;
  remove: (id: string) => void;
  dirty: boolean;
}

export function useWorldSession(initial?: () => WorldDoc): WorldSession {
  const docRef = useRef<WorldDoc | null>(null);
  if (docRef.current === null) docRef.current = normalizeWorld(initial ? initial() : createWorld());

  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<SavedWorld[]>([]);
  const [savedRevision, setSavedRevision] = useState(0);

  const historyRef = useRef<WorldHistory | null>(null);
  const history = (historyRef.current ??= new WorldHistory());

  const bump = useCallback(() => setRevision((n) => n + 1), []);

  // The draft is read once, at mount. Re-reading it later would let another tab's world
  // replace the one being edited here mid-gesture.
  useEffect(() => {
    let live = true;
    void loadDraft().then((draft) => {
      if (!live) return;
      if (draft) docRef.current = draft;
      setLoading(false);
      bump();
    });
    void listWorlds().then((rows) => {
      if (live) setSaved(rows);
    });
    return () => {
      live = false;
    };
  }, [bump]);

  // Debounced draft autosave. `revision` is the trigger rather than the document, because the
  // document's identity deliberately does not change when terrain does.
  useEffect(() => {
    if (loading || revision === 0) return;
    const timer = setTimeout(() => {
      const doc = docRef.current;
      if (doc) void saveDraft(doc);
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
    void saveWorld(doc).then(() => {
      void listWorlds().then(setSaved);
      setSavedRevision(revision);
    });
  }, [revision]);

  const open = useCallback(
    (doc: WorldDoc) => {
      docRef.current = normalizeWorld(doc);
      history.clear();
      setSavedRevision(0);
      bump();
    },
    [history, bump],
  );

  const remove = useCallback((id: string) => {
    void deleteWorld(id).then(() => {
      void listWorlds().then(setSaved);
    });
  }, []);

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
      saved,
      save,
      open,
      remove,
      dirty: revision !== savedRevision,
    }),
    [
      revision, loading, beginStroke, endStroke, bump, commitCarve, commitPlacements,
      commitSettings, rename, undo, redo, history, saved, save, open, remove, savedRevision,
    ],
  );
}

/** Both terrain arrays, for the history's byte ceiling. Three bytes a column. */
function terrainBytes(settings: WorldSettings): number {
  return settings.size.x * settings.size.z * 3;
}
