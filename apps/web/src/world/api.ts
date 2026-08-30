/**
 * Worlds over HTTP, and the seam that lets the page not care which store it is talking to.
 *
 * A world signed out is a world on this machine; a world signed in is one you can open from
 * another. Both are the same document and the same four verbs, so rather than teaching the
 * session about accounts, the two stores implement one `WorldStore` and the page hands over
 * whichever the auth state calls for. That also means the anonymous path is not a degraded
 * mode bolted on — it is the same code path with a different adapter.
 *
 * The wire shape is `worldToJSON(doc)` verbatim in and the same shape out, so a round trip is
 * `normalizeWorld(await res.json())` with nothing in between. The heightfield rides as base64
 * rather than a JSON number array for the reason the whole design exists: a 1M-column
 * `Int16Array` written out as numbers is megabytes of text, and the point of a description is
 * that it is small.
 */

import { normalizeWorld, worldToJSON, type WorldDoc } from '@craftmagic/core';
import * as local from './storage.js';
import type { SavedWorld } from './storage.js';

export type { SavedWorld } from './storage.js';

/** The four things a page needs from wherever worlds are kept. */
export interface WorldStore {
  list: () => Promise<SavedWorld[]>;
  /** Returns the id it was stored under — a first save on the server mints one. */
  save: (doc: WorldDoc) => Promise<string | null>;
  load: (id: string) => Promise<WorldDoc | null>;
  remove: (id: string) => Promise<boolean>;
}

class WorldApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'WorldApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new WorldApiError(body.message ?? body.error ?? `HTTP ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

interface WorldRowJSON {
  id: string;
  name: string;
  sizeX: number;
  sizeZ: number;
  placements: number;
  updatedAt: string;
}

export async function listWorlds(): Promise<SavedWorld[]> {
  const body = await request<{ worlds: WorldRowJSON[] }>('/api/worlds');
  return body.worlds.map(({ id, name, sizeX, sizeZ, placements, updatedAt }) => ({
    id, name, sizeX, sizeZ, placements, updatedAt: String(updatedAt),
  }));
}

export async function getWorld(id: string): Promise<WorldDoc> {
  return normalizeWorld(await request<unknown>(`/api/worlds/${encodeURIComponent(id)}`));
}

/**
 * Create the row.
 *
 * The id comes back from the server rather than going up with the document: a world drafted
 * offline already has a local id, and reusing it would let a client choose primary keys in a
 * table it shares with every other account.
 */
export async function createWorld(doc: WorldDoc): Promise<string> {
  const body = await request<{ id: string }>('/api/worlds', json('POST', worldToJSON(doc)));
  return body.id;
}

/** Save over an existing row. A world is edited, not written once — see the route's own note. */
export async function updateWorld(id: string, doc: WorldDoc): Promise<void> {
  await request(`/api/worlds/${encodeURIComponent(id)}`, json('PATCH', worldToJSON(doc)));
}

export async function deleteWorld(id: string): Promise<void> {
  await request(`/api/worlds/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Worlds in this browser. What an anonymous visitor gets, and where every draft lives. */
export const localStore: WorldStore = {
  list: () => local.listWorlds(),
  save: (doc) => local.saveWorld(doc).then((ok) => (ok ? doc.id : null)),
  load: (id) => local.loadWorld(id),
  remove: (id) => local.deleteWorld(id),
};

/**
 * Worlds on the account.
 *
 * `save` creates or updates depending on whether the server already knows the id, and it finds
 * that out by asking rather than by tracking a flag: a world opened from the server, edited,
 * and saved must land on the row it came from, while one drafted locally and then signed into
 * has never existed server-side and needs creating. A 404 is the honest signal for the
 * difference, and it is also what a world deleted from another tab looks like — in which case
 * re-creating it is the right answer rather than an error.
 */
export const remoteStore: WorldStore = {
  list: listWorlds,
  async save(doc) {
    try {
      await updateWorld(doc.id, doc);
      return doc.id;
    } catch (error) {
      if (error instanceof WorldApiError && error.status === 404) return createWorld(doc);
      throw error;
    }
  },
  load: (id) => getWorld(id).catch(() => null),
  remove: (id) => deleteWorld(id).then(() => true, () => false),
};
