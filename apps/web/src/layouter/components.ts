/**
 * The library, as a parts bin for the layouter.
 *
 * A saved build stops being an archived thing you reopen one at a time and becomes a
 * *component*: place it, place it again, turn one of them. The layouter already draws rooms
 * and drops furniture from a catalogue; this is the same idea with the catalogue coming from
 * the user's own work.
 *
 * Two shapes of the same data, because two different things need it:
 *
 *   * The **shelf** needs every saved build's name and size — a list, from `/api/builds`,
 *     which is small and arrives in one request.
 *   * The **compiler** needs the blocks of the builds a plan actually places — fetched one at
 *     a time from `/api/builds/:id`, because a grid is megabytes and a plan places three of
 *     forty.
 *
 * So the shelf is loaded eagerly and the blocks lazily, and a placement carries its own copy
 * of the name and footprint (see `PlaceItem`) so the canvas has something to draw in the gap.
 *
 * Fetches are deduped through an in-flight promise map and nothing is cancelled. The obvious
 * alternative — cancel on cleanup — deadlocks precisely on the path that matters most: marking
 * an id as loading re-renders, the re-render's effect cancels the request it just started, and
 * the next pass skips the id because it is already marked loading. A restored plan then sits
 * there with placements and no blocks, compiling to a building with holes where its saved
 * parts should be.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { encodePrefab, type Prefab } from '@craftmagic/core';
import { useAuth } from '../library/auth.js';
import { getBuild, listBuilds, type LibraryBuild } from '../library/library.js';
import type { LayoutPlan, PlaceItem } from './plan.js';

/** What the shelf shows: enough to pick a build without fetching its blocks. */
export interface ShelfEntry {
  id: string;
  name: string;
  w: number;
  h: number;
  d: number;
  blockCount: number;
  /** True when only its voxels describe it — worth saying, since it cannot be re-generated. */
  detached: boolean;
}

/** A build whose blocks have arrived, ready for the compiler. */
export interface LoadedComponent {
  id: string;
  name: string;
  size: { x: number; y: number; z: number };
  prefab: Prefab;
}

export type Catalogue = ReadonlyMap<string, LoadedComponent>;

export interface ComponentLibrary {
  /** Every saved build, for the shelf. Empty while signed out. */
  shelf: ShelfEntry[];
  status: 'loading' | 'ready' | 'error' | 'signedOut';
  /** Builds whose blocks are loaded, keyed by build id. */
  catalogue: Catalogue;
  /** Ids currently being fetched. */
  loading: ReadonlySet<string>;
  /** Ids whose fetch failed — deleted from the library, most likely. */
  failed: ReadonlySet<string>;
  /** Fetch a build's blocks, or hand back the fetch already in flight for it. */
  load: (id: string) => Promise<LoadedComponent | null>;
}

function entryOf(build: LibraryBuild): ShelfEntry {
  return {
    id: build.id,
    name: build.name,
    w: build.sizeX,
    h: build.sizeY,
    d: build.sizeZ,
    blockCount: build.blockCount,
    detached: build.detached,
  };
}

export function useComponentLibrary(plan: LayoutPlan): ComponentLibrary {
  const auth = useAuth();
  const [shelf, setShelf] = useState<ShelfEntry[]>([]);
  const [status, setStatus] = useState<ComponentLibrary['status']>('loading');
  const [catalogue, setCatalogue] = useState<Map<string, LoadedComponent>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());

  // Read by `load`, which must not change identity every time a build arrives — it is a
  // dependency of the effect below and of every caller's click handler.
  const known = useRef(catalogue);
  known.current = catalogue;
  const inFlight = useRef(new Map<string, Promise<LoadedComponent | null>>());

  useEffect(() => {
    if (auth.status === 'loading') return;
    if (auth.status === 'anonymous') {
      setStatus('signedOut');
      setShelf([]);
      return;
    }

    let cancelled = false;
    setStatus('loading');
    listBuilds()
      .then((builds) => {
        if (cancelled) return;
        setShelf(builds.map(entryOf));
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [auth.status]);

  const load = useCallback((id: string): Promise<LoadedComponent | null> => {
    const already = known.current.get(id);
    if (already) return Promise.resolve(already);

    const pending = inFlight.current.get(id);
    if (pending) return pending;

    setLoading((prev) => new Set(prev).add(id));

    const request = getBuild(id)
      .then((detail): LoadedComponent => {
        const component: LoadedComponent = {
          id,
          name: detail.name,
          size: detail.grid.size,
          // Encoded once, here. The compiler runs on every keystroke that changes the plan and
          // must not re-pack a saved building each time.
          prefab: encodePrefab({
            size: detail.grid.size,
            palette: detail.grid.palette,
            voxels: Uint16Array.from(detail.grid.voxels),
          }),
        };
        setCatalogue((prev) => new Map(prev).set(id, component));
        return component;
      })
      .catch(() => {
        setFailed((prev) => new Set(prev).add(id));
        return null;
      })
      .finally(() => {
        inFlight.current.delete(id);
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      });

    inFlight.current.set(id, request);
    return request;
  }, []);

  /**
   * Every build the plan places, as a stable key.
   *
   * Keyed on the distinct ids rather than on the plan, so moving a placed building does not
   * re-request its blocks — and there are a lot of moves in a drag.
   */
  const referenced = useMemo(() => {
    const ids = new Set<string>();
    for (const floor of plan.floors) {
      for (const item of floor.items) {
        if (item.kind === 'place' && item.buildId) ids.add(item.buildId);
      }
    }
    return [...ids].sort().join(',');
  }, [plan]);

  useEffect(() => {
    if (!referenced) return;
    for (const id of referenced.split(',')) void load(id);
  }, [referenced, load]);

  return { shelf, status, catalogue, loading, failed, load };
}

/** The footprint to draw for a placement: the library's if it has arrived, else the plan's. */
export function placeSize(
  item: PlaceItem,
  catalogue: Catalogue,
): { w: number; d: number; h: number; name: string; loaded: boolean } {
  const component = catalogue.get(item.buildId);
  if (!component) return { w: item.w, d: item.d, h: item.h, name: item.name, loaded: false };
  return {
    w: component.size.x,
    d: component.size.z,
    h: component.size.y,
    name: component.name,
    loaded: true,
  };
}
