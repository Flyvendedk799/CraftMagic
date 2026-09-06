/**
 * The 3D check: one region, materialised, in the renderer the rest of the app already uses.
 *
 * This is the reason the world document is a description rather than a grid, and it stays the
 * reason after the renderer learned to stream. `VoxelWorld` now keeps a camera-driven working
 * set and evicts what is behind you, so meshes are no longer the ceiling — but it is still
 * handed a flat `VoxelGrid` and keeps it by reference for editing, raycasting and cutaways, and
 * at 1024×160×1024 that is a single contiguous 320 MB allocation. A region is 128×160×128 at
 * the default, which is an ordinary large build, so the viewport that works stays exactly as it
 * is and what changes is how much of the world it is asked to hold at once.
 *
 * Materialising is O(region cells) and runs on the main thread, so it is deliberately *not*
 * wired to the live stroke. Sculpting updates the map at sixty frames a second; the 3D view
 * catches up when the drag ends. Recomputing it mid-drag would turn a smooth brush into a
 * slideshow, which is a bad trade for a view you are not looking at while you sculpt.
 */

import { useMemo } from 'react';
import { paletteColors, paletteFlags, type MaterializedRegion } from '@craftmagic/core';
import { EditorCanvas } from '../editor/EditorCanvas.js';

export interface WorldPreviewProps {
  /**
   * The region, already materialised.
   *
   * Handed in rather than computed here, because the export bar needs the same grid and two
   * materialisations could differ — letting somebody download a region that is not the one
   * they are looking at.
   */
  built: MaterializedRegion;
  region: { rx: number; rz: number };
}

export function WorldPreview({ built, region }: WorldPreviewProps) {
  const colors = useMemo(() => paletteColors(built.grid.palette), [built.grid.palette]);
  const flags = useMemo(() => paletteFlags(built.grid.palette), [built.grid.palette]);

  return (
    <div
      className="world__preview"
      data-region={`${region.rx},${region.rz}`}
      data-blocks={built.stats.blocks}
      data-unresolved={built.stats.unresolved}
      /* Placements whose box reaches into this region — the honest answer to "did that
         component actually land here", which a block count cannot give without a baseline. */
      data-placed={built.stats.placements}
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
