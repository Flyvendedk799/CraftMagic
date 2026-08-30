/**
 * Everything that takes the build somewhere else.
 *
 * Three destinations, three sections, in the order people reach for them: a file on disk, a
 * row in the library, a world in Minecraft. The schematic is written in the browser, so the
 * download is instant and costs the server nothing — `packages/core` is isomorphic
 * specifically to allow that. The button reports the file size after writing, since "did that
 * actually produce anything?" is the first question a 500-byte download raises.
 *
 * Saving sits beside the exports rather than beside the tools because it belongs with the
 * other "take this build somewhere" actions, and because it is the one of them that needs an
 * account — grouping it here makes that the only difference the user sees.
 */

import { useCallback, useState } from 'react';
import type { BuildProgram, VoxelGrid } from '@craftmagic/core';
import { SendToGame } from '../agent/SendToGame.js';
import { SaveToLibrary } from '../library/SaveToLibrary.js';
import { downloadProgram, downloadSchematic, formatBytes } from './download.js';
import { Section } from './Section.js';

export interface ExportBarProps {
  grid: VoxelGrid;
  /** Null for a build with no program behind it — a hand-edited one loaded from the library. */
  program: BuildProgram | null;
  name: string;
  /** True once the grid has been edited by hand, so no program describes it any more. */
  detached: boolean;
  /** Link to the printable guide, or null when this build cannot be reached by URL alone. */
  guideHref: string | null;
  /**
   * Why there is no program to download, when there is not.
   *
   * A hand-edited build and a composed plan are both program-less for different reasons, and
   * a tooltip that names the wrong one is worse than none — it tells the user their plan was
   * edited by hand.
   */
  programHint?: string;
  /** Non-air blocks. Zero on a fresh empty plot, where there is nothing to export yet. */
  blockCount: number;
}

export function ExportBar({
  grid,
  program,
  name,
  detached,
  guideHref,
  blockCount,
  programHint = 'This build was hand-edited, so no program describes it',
}: ExportBarProps) {
  const [written, setWritten] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // An empty plot can technically produce a `.schem` and a booklet; both would be empty. The
  // controls stay visible rather than disappearing, so the export path is discoverable before
  // there is anything to export — they just cannot promise a file that has nothing in it.
  const empty = blockCount === 0;

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
      <Section id="export" title="Export" summary={empty ? 'empty' : undefined} defaultOpen={false}>
        <div className="export__actions">
          <button
            type="button"
            className="export__primary"
            onClick={onDownload}
            disabled={empty}
            title={empty ? 'Nothing to export yet' : 'WorldEdit-compatible .schem'}
          >
            Download schematic
            <span className="export__meta">.schem · WorldEdit</span>
          </button>
          <button
            type="button"
            onClick={onDownloadProgram}
            disabled={!program || empty}
            title={
              empty
                ? 'Nothing to export yet'
                : program
                  ? 'The parametric program — a few KB, and re-expandable at any size'
                  : programHint
            }
          >
            Program JSON
            <span className="export__meta">
              {program ? 'a few KB, re-expandable' : 'no program describes this'}
            </span>
          </button>
          {guideHref && !empty && (
            <a className="export__link" href={guideHref} target="_blank" rel="noreferrer">
              Printable build guide →
            </a>
          )}
        </div>

        {empty && (
          <p className="export__note">Describe a build or place some blocks, then export it here.</p>
        )}

        {written && <p className="export__note">Saved {written}</p>}
        {failed && (
          <p className="export__note export__note--error" role="alert">
            {failed}
          </p>
        )}
      </Section>

      {/* Both write a build somewhere permanent — the library, or somebody's world. Neither
          is worth offering until there is a build: an empty save is clutter, and an empty
          send is a bot that flies out and places nothing. */}
      {!empty && (
        <>
          <Section id="save" title="Save" defaultOpen={false}>
            <SaveToLibrary name={name} grid={grid} program={program} detached={detached} />
          </Section>
          {/* Open by default: this is the headline feature and it used to sit below the fold,
              where nobody found it. */}
          <Section id="sendtogame" title="Send to game">
            <SendToGame name={name} grid={grid} program={program} />
          </Section>
        </>
      )}
    </div>
  );
}
