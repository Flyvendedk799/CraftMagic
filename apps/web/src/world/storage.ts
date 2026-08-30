/**
 * Where a world lives on this machine.
 *
 * Architecture mode keeps its plans in `localStorage` and that is the right call for a plan:
 * a few hundred rooms is a few kilobytes of JSON. A world is three orders of magnitude
 * bigger. One 1024² map is 3 MB of terrain before anything is carved or placed, and
 * `localStorage` is a ~5 MB budget *per origin* already shared with the Architecture plans,
 * the editor's autosaves and eleven section-collapse keys. Two worlds would exceed it.
 *
 * The failure mode is what settles it. `storage.ts` next door correctly returns `false`
 * rather than throwing when a write is refused — which means a world that has outgrown the
 * quota would autosave silently into nothing, and the user would find out at the end of a
 * session. IndexedDB has room, and it structured-clones `Int16Array` natively, so a 500 ms
 * autosave during a drag costs neither a base64 pass nor a `JSON.stringify` of 3 MB.
 *
 * Everything here resolves rather than throws. A browser in private mode, a blocked-storage
 * setting, or a corrupt record must degrade to "this session is not saved" — never to a
 * World tab that will not open.
 */

import { normalizeWorld, type WorldDoc } from '@craftmagic/core';

const DB_NAME = 'craftmagic.worlds';
const DB_VERSION = 1;
const STORE = 'worlds';
/** The single in-progress document, under a fixed key so it is found without a listing. */
const DRAFT_KEY = '__draft__';

export interface SavedWorld {
  id: string;
  name: string;
  sizeX: number;
  sizeZ: number;
  placements: number;
  updatedAt: string;
}

/**
 * A world as IndexedDB holds it.
 *
 * The typed arrays go in as themselves — that is the reason for choosing IndexedDB — so this
 * is `WorldDoc` plus the key and the summary fields a listing needs without deserialising
 * three megabytes of heightfield to read a name.
 */
interface WorldRecord extends SavedWorld {
  key: string;
  doc: WorldDoc;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/**
 * Open the database once and share it.
 *
 * `null` is a first-class result: no IndexedDB, a blocked origin, or a failed upgrade all
 * mean the same thing to every caller, which is that persistence is unavailable and the
 * session continues in memory.
 */
function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // A blocked upgrade means another tab holds an older version open. Resolving null keeps
    // this tab usable rather than hanging on a promise that may never settle.
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        let request: IDBRequest<T>;
        try {
          request = work(db.transaction(STORE, mode).objectStore(STORE));
        } catch {
          resolve(null);
          return;
        }
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => resolve(null);
      }),
  );
}

function recordOf(key: string, doc: WorldDoc): WorldRecord {
  return {
    key,
    id: doc.id,
    name: doc.name,
    sizeX: doc.settings.size.x,
    sizeZ: doc.settings.size.z,
    placements: doc.placements.length,
    updatedAt: doc.updatedAt,
    doc,
  };
}

/**
 * Read a stored document back through `normalizeWorld`.
 *
 * Structured clone returns the typed arrays intact, so this is not a decode — it is a
 * validation. A record written by an older version, or one a failed write left half-formed,
 * has to come back as a usable world or not at all, and normalising is how every other
 * persisted shape in this codebase draws that line.
 */
function docOf(record: unknown): WorldDoc | null {
  if (typeof record !== 'object' || record === null) return null;
  const doc = (record as { doc?: unknown }).doc;
  if (typeof doc !== 'object' || doc === null) return null;
  try {
    return normalizeWorld(doc);
  } catch {
    return null;
  }
}

export function loadDraft(): Promise<WorldDoc | null> {
  return run<WorldRecord>('readonly', (store) => store.get(DRAFT_KEY) as IDBRequest<WorldRecord>).then(docOf);
}

export function saveDraft(doc: WorldDoc): Promise<boolean> {
  return run('readwrite', (store) => store.put(recordOf(DRAFT_KEY, doc))).then(() => true, () => false);
}

export function listWorlds(): Promise<SavedWorld[]> {
  return run<WorldRecord[]>('readonly', (store) => store.getAll() as IDBRequest<WorldRecord[]>).then(
    (rows) =>
      (rows ?? [])
        .filter((row) => row && row.key !== DRAFT_KEY)
        .map(({ id, name, sizeX, sizeZ, placements, updatedAt }) => ({
          id, name, sizeX, sizeZ, placements, updatedAt,
        }))
        // Newest first: the list is a way back to what you were just doing, not an archive.
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    () => [],
  );
}

/** Save under the document's own id, so saving twice updates rather than accumulates. */
export function saveWorld(doc: WorldDoc): Promise<boolean> {
  return run('readwrite', (store) => store.put(recordOf(doc.id, doc))).then(() => true, () => false);
}

export function loadWorld(id: string): Promise<WorldDoc | null> {
  return run<WorldRecord>('readonly', (store) => store.get(id) as IDBRequest<WorldRecord>).then(docOf);
}

export function deleteWorld(id: string): Promise<boolean> {
  return run('readwrite', (store) => store.delete(id)).then(() => true, () => false);
}

/** Test seam: forget the cached connection so a fresh fake can be installed. */
export function resetStorage(): void {
  dbPromise = null;
}
