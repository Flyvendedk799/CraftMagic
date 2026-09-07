/**
 * The part of a world the 3D check is looking at, materialised into an ordinary `VoxelGrid`.
 *
 * Extracted because two things now want it and they must be the same one. The 3D check renders
 * it, and the export bar hands it to the schematic writer, the program download and the library
 * save — and if those two materialised separately, a user could export something that does not
 * match what they are looking at, which is the sort of difference nobody would think to check
 * for.
 *
 * It takes an *area* rather than a region. A region is the unit a world is delivered in, which
 * is a fact about the block cap and not about what anyone wants to look at — the seam between
 * two regions is exactly where a hub's big builds fall, and a boundary you can only ever see
 * one side of is a boundary you cannot check. `materializeArea` builds the union in one pass,
 * so a building on a seam is drawn once and whole; the delivery run still walks the regions
 * one at a time and knows nothing about this.
 *
 * The lag is deliberate and is the reason this is a hook rather than a `useMemo` at each call
 * site. `revision` bumps on every pointer move — that is how an in-place terrain write reaches
 * React at all — and materialising is O(area cells), two million of them for a single region at
 * the default. So the map stays live during a drag while this holds still, and catches up when
 * the drag ends, which is when anybody looks at it.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  materializeArea,
  type MaterializedRegion,
  type Prefab,
  type Region,
  type RegionArea,
  type WorldDoc,
} from '@craftmagic/core';
import type { Catalogue } from '../library/components.js';

export interface RegionGridOptions {
  doc: WorldDoc;
  revision: number;
  /** The rectangle of regions on screen. A single region is the 1×1 case. */
  area: RegionArea;
  catalogue: Catalogue;
  /** False while a gesture is in flight, so a drag does not pay for a materialise per frame. */
  live: boolean;
  /** The y slab, when the world is taller than one build. Absent means the whole column. */
  slab?: Region;
}

export function useRegionGrid({
  doc,
  revision,
  area,
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
   * The catalogue as `materializeArea` wants it.
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
    () => materializeArea(doc, area, prefabs, slab),
    // The four corners rather than the object: the area is rebuilt by the page on every render
    // that touches the view, and comparing it by identity would materialise the same rectangle
    // again on every keystroke in the world's name field.
    // `settled` rather than `revision`: that is the whole point of the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, settled, area.rx0, area.rz0, area.rx1, area.rz1, prefabs, slab],
  );
}
