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
import type { BuildProgram, EditLayer, VoxelGrid } from '@craftmagic/core';
import { SendToGame } from '../agent/SendToGame.js';
import { SaveToLibrary } from '../library/SaveToLibrary.js';
import type { BuildKind } from '../library/library.js';
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
  /** Non-air blocks. Zero on a fresh empty plot, where there is nothing to export yet. */
  blockCount: number;
  /** The hand-edit layer for the library save, fetched at click time. Optional: pages with no session pass nothing. */
  getEdits?: () => EditLayer | null;
  /** Architecture mode's drawing, saved beside the compiled build so it can be reopened as a plan. */
  plan?: unknown;
  /** Which tier made this build. Passed straight through to the save. */
  kind?: BuildKind;
}

export function ExportBar({ grid, program, name, detached, guideHref, blockCount, getEdits, plan, kind }: ExportBarProps) {
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
      <Section id="export" title="Export" defaultOpen={false}>

      <div className="export__actions">
        <button
          type="button"
          onClick={onDownload}
          disabled={empty}
          title={empty ? 'Nothing to export yet' : 'WorldEdit-compatible .schem'}
        >
          Download schematic
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
                : 'This build was hand-edited, so no program describes it'
          }
        >
          Program JSON
        </button>
        {guideHref && !empty && (
          <a className="export__link" href={guideHref} target="_blank" rel="noreferrer">
            Build guide →
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
            <SaveToLibrary name={name} grid={grid} program={program} detached={detached} getEdits={getEdits} plan={plan} kind={kind} />
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
