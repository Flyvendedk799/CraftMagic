/**
 * Export controls.
 *
 * The schematic is written in the browser, so the download is instant and costs the server
 * nothing — `packages/core` is isomorphic specifically to allow that. The button reports the
 * file size after writing, since "did that actually produce anything?" is the first question
 * a 500-byte download raises.
 *
 * Saving to the library sits here rather than beside the tools because it belongs with the
 * other "take this build somewhere" actions, and because it is the one of them that needs an
 * account — grouping it with the exports makes that the only difference the user sees.
 */

import { useCallback, useState } from 'react';
import type { BuildProgram, VoxelGrid } from '@craftmagic/core';
import { SendToGame } from '../agent/SendToGame.js';
import { SaveToLibrary } from '../library/SaveToLibrary.js';
import { downloadProgram, downloadSchematic, formatBytes } from './download.js';

export interface ExportBarProps {
  grid: VoxelGrid;
  /** Null for a build with no program behind it — a hand-edited one loaded from the library. */
  program: BuildProgram | null;
  name: string;
  /** True once the grid has been edited by hand, so no program describes it any more. */
  detached: boolean;
  /** Link to the printable guide, or null when this build cannot be reached by URL alone. */
  guideHref: string | null;
}

export function ExportBar({ grid, program, name, detached, guideHref }: ExportBarProps) {
  const [written, setWritten] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const run = useCallback((write: () => { filename: string; bytes: number }) => {
    setFailed(null);
    try {
      const result = write();
      setWritten(`${result.filename} · ${formatBytes(result.bytes)}`);
    } catch (err) {
      setWritten(null);
      setFailed((err as Error).message);
    }
  }, []);

  const onDownload = useCallback(() => run(() => downloadSchematic(grid, name)), [run, grid, name]);
  const onDownloadProgram = useCallback(() => {
    if (!program) return;
    run(() => downloadProgram(program, name));
  }, [run, program, name]);

  return (
    <div className="export">
      <p className="params__title">Export</p>

      <div className="export__actions">
        <button type="button" onClick={onDownload} title="WorldEdit-compatible .schem">
          Download schematic
        </button>
        <button
          type="button"
          onClick={onDownloadProgram}
          disabled={!program}
          title={
            program
              ? 'The parametric program — a few KB, and re-expandable at any size'
              : 'This build was hand-edited, so no program describes it'
          }
        >
          Program JSON
        </button>
        {guideHref && (
          <a className="export__link" href={guideHref} target="_blank" rel="noreferrer">
            Build guide →
          </a>
        )}
      </div>

      {written && <p className="export__note">Saved {written}</p>}
      {failed && (
        <p className="export__note export__note--error" role="alert">
          {failed}
        </p>
      )}

      <SaveToLibrary name={name} grid={grid} program={program} detached={detached} />

      <SendToGame name={name} grid={grid} program={program} />
    </div>
  );
}
