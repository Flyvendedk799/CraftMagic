/**
 * The 3D check: one region, materialised, in the renderer the rest of the app already uses.
 *
 * This is the reason the world document is a description rather than a grid. `EditorCanvas`
 * and `VoxelWorld` mesh every 16³ chunk of what they are handed and keep every mesh; at
 * 1024×160×1024 that is 40,960 chunks and 320 MB, and the tab dies. One region is 128×160×128
 * at the default — well inside what the renderer already does comfortably for a large build —
 * so the viewport that works stays exactly as it is, and what changes is how much of the world
 * it is asked to hold at once.
 *
 * Materialising is O(region cells) and runs on the main thread, so it is deliberately *not*
 * wired to the live stroke. Sculpting updates the map at sixty frames a second; the 3D view
 * catches up when the drag ends. Recomputing it mid-drag would turn a smooth brush into a
 * slideshow, which is a bad trade for a view you are not looking at while you sculpt.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  materializeRegion,
  paletteColors,
  paletteFlags,
  type Prefab,
  type WorldDoc,
} from '@craftmagic/core';
import { EditorCanvas } from '../editor/EditorCanvas.js';
import type { Catalogue } from '../library/components.js';

export interface WorldPreviewProps {
  doc: WorldDoc;
  /** Bumped by the session; the preview recomputes on it, but only once the drag has ended. */
  revision: number;
  region: { rx: number; rz: number };
  catalogue: Catalogue;
  /** False while a stroke is in flight, so a drag does not pay for a materialise per frame. */
  live: boolean;
}

export function WorldPreview({ doc, revision, region, catalogue, live }: WorldPreviewProps) {
  // The revision the preview was last built at. Holding it here rather than reading `revision`
  // directly is what lets the view lag a drag deliberately instead of accidentally.
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

  const built = useMemo(
    () => materializeRegion(doc, region.rx, region.rz, prefabs),
    [doc, settled, region.rx, region.rz, prefabs],
  );

  const colors = useMemo(() => paletteColors(built.grid.palette), [built.grid.palette]);
  const flags = useMemo(() => paletteFlags(built.grid.palette), [built.grid.palette]);

  return (
    <div
      className="world__preview"
      data-region={`${region.rx},${region.rz}`}
      data-blocks={built.stats.blocks}
      data-unresolved={built.stats.unresolved}
    >
      <EditorCanvas grid={built.grid} paletteColors={colors} paletteFlags={flags} />
      <div className="world__preview-bar">
        <span>
          Region {region.rx},{region.rz}
        </span>
        <span>{built.stats.blocks.toLocaleString()} blocks</span>
        {built.stats.unresolved > 0 && (
          <span className="world__warn-inline">
            {built.stats.unresolved} placement{built.stats.unresolved === 1 ? '' : 's'} still loading
          </span>
        )}
      </div>
    </div>
  );
}
