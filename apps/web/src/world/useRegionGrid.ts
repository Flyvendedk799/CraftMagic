/**
 * One region of a world, materialised into an ordinary `VoxelGrid`.
 *
 * Extracted because two things now want it and they must be the same one. The 3D check renders
 * it, and the export bar hands it to the schematic writer, the program download and the library
 * save — and if those two materialised separately, a user could export a region that does not
 * match the one they are looking at, which is the sort of difference nobody would think to
 * check for.
 *
 * The lag is deliberate and is the reason this is a hook rather than a `useMemo` at each call
 * site. `revision` bumps on every pointer move — that is how an in-place terrain write reaches
 * React at all — and materialising is O(region cells), two million of them at the default. So
 * the map stays live during a drag while this holds still, and catches up when the drag ends,
 * which is when anybody looks at it.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  materializeRegion,
  type MaterializedRegion,
  type Prefab,
  type Region,
  type WorldDoc,
} from '@craftmagic/core';
import type { Catalogue } from '../library/components.js';

export interface RegionGridOptions {
  doc: WorldDoc;
  revision: number;
  region: { rx: number; rz: number };
  catalogue: Catalogue;
  /** False while a gesture is in flight, so a drag does not pay for a materialise per frame. */
  live: boolean;
  /** The y slab, when the world is taller than one build. Absent means the whole column. */
  slab?: Region;
}

export function useRegionGrid({
  doc,
  revision,
  region,
  catalogue,
  live,
  slab,
}: RegionGridOptions): MaterializedRegion {
  // The revision this was last built at. Holding it here rather than reading `revision`
  // directly is what lets the result lag a drag deliberately instead of accidentally.
  const [settled, setSettled] = useState(revision);

  useEffect(() => {
    if (live) setSettled(revision);
  }, [live, revision]);

  /**
   * The catalogue as `materializeRegion` wants it.
   *
   * `LoadedComponent` already holds the encoded prefab — `useComponents` packs it once on
   * arrival precisely so that neither the compiler nor this has to re-pack a saved building on
   * every recompute — so this is a re-key, not a conversion.
   */
  const prefabs = useMemo(() => {
    const map = new Map<string, Prefab>();
    for (const [id, component] of catalogue) map.set(id, component.prefab);
    return map;
  }, [catalogue]);

  return useMemo(
    () => materializeRegion(doc, region.rx, region.rz, prefabs, slab),
    // `settled` rather than `revision`: that is the whole point of the hook.
    [doc, settled, region.rx, region.rz, prefabs, slab],
  );
}
