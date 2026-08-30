/**
 * The studio's title bar.
 *
 * It exists to answer three questions that the old HUD left the user to work out from
 * context: *what am I looking at*, *what state is it in*, and *where else can I go*. All
 * three used to be scattered — the build's name was a row in a collapsed stats table, its
 * edited state was a line of small print beside the undo buttons, and the links to the
 * library, the mod and the deployment checks were at the bottom of a scrolling panel where
 * nobody ever scrolled.
 *
 * The badges are the load-bearing part. A build is one of four things — a sample, something
 * the model generated, something out of the library, or an empty plot — and it either still
 * matches its program or it does not. Both facts change what half the controls in the studio
 * will do, so both are stated where you cannot miss them rather than inferred from which
 * buttons happen to be disabled.
 *
 * The name is editable in place, which it was not before. It is not decoration: it is the
 * filename of the downloaded schematic, the title of the library row, and what the mod
 * announces in chat when the build lands in somebody's world. Until now the only way to
 * change it was to save the build, leave for the library page, rename it there and come back
 * — for a name you had already decided on before pressing anything.
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AccountPanel } from '../library/AccountPanel.js';

export type BuildSource = 'blank' | 'sample' | 'generated' | 'library';

export interface StudioBarProps {
  name: string;
  onRename: (name: string) => void;
  source: BuildSource;
  /** True once the grid has been hand-edited and no program describes it any more. */
  detached: boolean;
  edits: number;
  size: { x: number; y: number; z: number };
  blockCount: number;
  /** Whether each dock is showing, and how to flip it. */
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onShowShortcuts: () => void;
}

const SOURCE_LABEL: Record<BuildSource, string> = {
  blank: 'Empty plot',
  sample: 'Sample',
  generated: 'Generated',
  library: 'Library',
};

export function StudioBar({
  name,
  onRename,
  source,
  detached,
  edits,
  size,
  blockCount,
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  onShowShortcuts,
}: StudioBarProps) {
  return (
    <header className="topbar">
      <div className="topbar__group topbar__group--start">
        <button
          type="button"
          className="topbar__dock"
          aria-pressed={leftOpen}
          aria-label={leftOpen ? 'Hide the build panel' : 'Show the build panel'}
          title="Build panel"
          onClick={onToggleLeft}
        >
          <PanelIcon side="left" />
        </button>

        <Link className="brand" to="/">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">CraftMagic</span>
          <span className="brand__sub">Studio</span>
        </Link>
      </div>

      {/* The identity of the thing on screen. Centred, because it is the subject of every
          control on either side of it. */}
      <div className="topbar__identity">
        <BuildName name={name} onRename={onRename} />
        <span className={`badge badge--${source}`}>{SOURCE_LABEL[source]}</span>
        {detached && (
          <span className="badge badge--edited" title="Hand-edited — no program describes it now">
            Edited · {edits}
          </span>
        )}
        <span className="topbar__dims">
          {size.x}×{size.y}×{size.z}
          <span className="topbar__dot">·</span>
          {blockCount.toLocaleString()} blocks
        </span>
      </div>

      <div className="topbar__group topbar__group--end">
        <nav className="topbar__nav">
          <Link to="/library">Library</Link>
          <Link to="/mod">Mod</Link>
          <Link to="/status">Status</Link>
        </nav>

        <button
          type="button"
          className="topbar__icon"
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          onClick={onShowShortcuts}
        >
          ?
        </button>

        <AccountPanel variant="menu" invitation="An account keeps your builds and pairs a world." />

        <button
          type="button"
          className="topbar__dock"
          aria-pressed={rightOpen}
          aria-label={rightOpen ? 'Hide the tools panel' : 'Show the tools panel'}
          title="Tools panel"
          onClick={onToggleRight}
        >
          <PanelIcon side="right" />
        </button>
      </div>
    </header>
  );
}

/**
 * The build's name, edited in place.
 *
 * Uncontrolled while focused and re-synced from the prop when it is not: the name also changes
 * from *outside* this field — a new build, a generated one, one opened from the library — and
 * a controlled input would either fight those updates or overwrite what is being typed.
 *
 * Blur commits, Escape abandons. An empty name is refused rather than saved, because the
 * downstream uses of it (a filename, a library row, a line of chat in someone's game) all
 * degrade badly to the empty string.
 */
function BuildName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState(name);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    else setDraft(name);
  };

  return (
    <input
      ref={input}
      className="topbar__name"
      value={draft}
      title={`${name} — click to rename`}
      aria-label="Build name"
      maxLength={80}
      size={Math.max(8, Math.min(24, draft.length + 1))}
      onFocus={() => setEditing(true)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') input.current?.blur();
        else if (event.key === 'Escape') {
          setDraft(name);
          setEditing(false);
          input.current?.blur();
        }
      }}
    />
  );
}

/** A panel glyph that reads as "this side of the window", drawn rather than shipped as text. */
function PanelIcon({ side }: { side: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" />
      <rect
        x={side === 'left' ? 1.5 : 9.5}
        y="2.5"
        width="5"
        height="11"
        rx="2"
        fill="currentColor"
        opacity="0.75"
      />
    </svg>
  );
}
