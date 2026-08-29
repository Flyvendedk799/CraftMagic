/**
 * Fetch a `lib:` build so the rest of the app can expand it by id.
 *
 * Shared by the editor and the guide, deliberately. They must agree on one rule, and two
 * copies of that rule is exactly how the guide ends up printing something other than what
 * the editor shows. That failure has happened here once already, in the shape of every
 * generated build's booklet coming out as the sample cottage.
 *
 * The rule, since edits became a layer: **prefer the program, and carry the edits beside
 * it.** A build saved with hand edits comes back as its program plus its edit layer — the
 * session composites the layer over the expansion, so sliders, resize and refine all still
 * work on a build that was detailed by hand. Old rows have no layer; for those, when the
 * saved voxels are the same size as the program's own expansion, the layer is recovered by
 * diffing the two — the lazy migration — and only when even that fails (a resize-then-edit
 * save, or no program at all) does the build fall back to voxels-only, exactly as before.
 */

import { useEffect, useState } from 'react';
import { EditOverlay, expand, type VoxelGrid } from '@craftmagic/core';
import {
  isBuildId,
  isLibraryId,
  libraryRowId,
  registerLibraryBuild,
  rememberEdits,
} from '../editor/builds.js';
import { getBuild, type LibraryBuildDetail } from './library.js';

export interface LibraryFetch {
  /** True while the build named in the URL is still on its way. */
  loading: boolean;
  /** Why it could not be fetched, or null. */
  error: string | null;
}

export function useLibraryBuild(buildId: string | null): LibraryFetch {
  const [error, setError] = useState<string | null>(null);

  // A landed fetch must force a re-render: `registerLibraryBuild` writes into a module-level
  // map that React cannot observe, so without this the id would stay unresolved on screen
  // even though it now resolves. The counter's value is never read — bumping it is the point.
  const [, landed] = useState(0);

  // Goes false again once the fetch lands, because `isBuildId` starts returning true. That is
  // also what stops the effect from re-running into a loop.
  const needsFetch = buildId !== null && isLibraryId(buildId) && !isBuildId(buildId);

  useEffect(() => {
    if (!needsFetch || buildId === null) return;
    const rowId = libraryRowId(buildId);
    if (!rowId) return;

    let cancelled = false;
    setError(null);

    getBuild(rowId)
      .then((detail) => {
        if (cancelled) return;
        register(buildId, rowId, detail);
        landed((n) => n + 1);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      });

    return () => {
      cancelled = true;
    };
  }, [needsFetch, buildId]);

  return { loading: needsFetch && error === null, error };
}

/** The one rule — see the module header. */
function register(buildId: string, rowId: string, detail: LibraryBuildDetail): void {
  const savedGrid: VoxelGrid = {
    size: detail.grid.size,
    palette: detail.grid.palette,
    voxels: Uint16Array.from(detail.grid.voxels),
  };

  if (detail.program) {
    // A stored layer wins. Failing that, a clean build needs none, and an old detached
    // save gets the diff treatment.
    let layer = detail.edits ?? null;
    if (!layer && detail.detached) {
      try {
        const overlay = EditOverlay.fromDiff(expand(detail.program).grid, savedGrid);
        if (overlay === null) {
          // The save was made at a different size than the program expands to — the diff
          // cannot say which cells are edits. Voxels-only, exactly as before the layer.
          registerLibraryBuild(rowId, { kind: 'voxels', name: detail.name, grid: savedGrid });
          return;
        }
        if (overlay.size > 0) layer = overlay.toJSON();
      } catch {
        // The stored program no longer expands (a schema drift, a corrupt row). The voxels
        // are still the truth of what was saved.
        registerLibraryBuild(rowId, { kind: 'voxels', name: detail.name, grid: savedGrid });
        return;
      }
    }
    registerLibraryBuild(rowId, { kind: 'program', name: detail.name, program: detail.program });
    rememberEdits(buildId, layer);
    return;
  }

  registerLibraryBuild(rowId, { kind: 'voxels', name: detail.name, grid: savedGrid });
}
