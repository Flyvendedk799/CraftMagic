/**
 * Fetch a `lib:` build so the rest of the app can expand it by id.
 *
 * Shared by the editor and the guide, deliberately. They must agree on one rule — prefer the
 * program so the param sliders keep working, except for a hand-edited build where no program
 * describes what was saved — and two copies of that rule is exactly how the guide ends up
 * printing something other than what the editor shows. That failure has happened here once
 * already, in the shape of every generated build's booklet coming out as the sample cottage.
 */

import { useEffect, useState } from 'react';
import { isBuildId, isLibraryId, libraryRowId, registerLibraryBuild } from '../editor/builds.js';
import { getBuild } from './library.js';

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
        registerLibraryBuild(
          rowId,
          detail.program && !detail.detached
            ? { kind: 'program', name: detail.name, program: detail.program }
            : {
                kind: 'voxels',
                name: detail.name,
                grid: {
                  size: detail.grid.size,
                  palette: detail.grid.palette,
                  voxels: Uint16Array.from(detail.grid.voxels),
                },
              },
        );
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
