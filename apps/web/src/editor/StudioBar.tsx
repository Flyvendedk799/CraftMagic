/**
 * The studio's title bar, shared by the editor and the planner.
 *
 * It exists to answer three questions that the old HUD left the user to work out from
 * context: *what am I looking at*, *what state is it in*, and *where else can I go*. All
 * three used to be scattered — the build's name was a row in a collapsed stats table, its
 * edited state was a line of small print beside the undo buttons, and the links to the
 * library, the mod and the deployment checks were at the bottom of a scrolling panel where
 * nobody ever scrolled.
 *
 * The middle is a slot rather than fixed markup, because the two surfaces are looking at
 * different things — one build, or a plot with several on it — while the frame around them
 * is identical. Making the planner its own bar would have been the quickest way to make it
 * feel like a different product bolted on beside this one.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { AccountPanel } from '../library/AccountPanel.js';

export type BuildSource = 'blank' | 'sample' | 'generated' | 'library';

export interface StudioBarProps {
  /** What is on screen: a build's name and badges, or a plan's. */
  identity: ReactNode;
  /** Whether each dock is showing, and how to flip it. */
  leftOpen: boolean;
  rightOpen: boolean;
  leftLabel: string;
  rightLabel: string;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onShowShortcuts: () => void;
}

export function StudioBar({
  identity,
  leftOpen,
  rightOpen,
  leftLabel,
  rightLabel,
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
          aria-label={`${leftOpen ? 'Hide' : 'Show'} the ${leftLabel.toLowerCase()} panel`}
          title={`${leftLabel} panel`}
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
      <div className="topbar__identity">{identity}</div>

      <div className="topbar__group topbar__group--end">
        <nav className="topbar__nav">
          {/* `end` on the editor link only: without it "/" matches every route and the
              editor tab stays lit while you are standing in the planner. */}
          <NavLink to="/" end>
            Editor
          </NavLink>
          <NavLink to="/plan">Planner</NavLink>
          <NavLink to="/library">Library</NavLink>
          <NavLink to="/mod">Mod</NavLink>
          <NavLink to="/status">Status</NavLink>
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
          aria-label={`${rightOpen ? 'Hide' : 'Show'} the ${rightLabel.toLowerCase()} panel`}
          title={`${rightLabel} panel`}
          onClick={onToggleRight}
        >
          <PanelIcon side="right" />
        </button>
      </div>
    </header>
  );
}

const SOURCE_LABEL: Record<BuildSource, string> = {
  blank: 'Empty plot',
  sample: 'Sample',
  generated: 'Generated',
  library: 'Library',
};

/** The editor's identity: a renameable title, what kind of build it is, and how big. */
export function BuildIdentity({
  name,
  onRename,
  source,
  detached,
  edits,
  size,
  blockCount,
}: {
  name: string;
  onRename: (name: string) => void;
  source: BuildSource;
  detached: boolean;
  edits: number;
  size: { x: number; y: number; z: number };
  blockCount: number;
}) {
  return (
    <>
      <StudioName name={name} onRename={onRename} />
      <span className={`badge badge--${source}`}>{SOURCE_LABEL[source]}</span>
      {detached && (
        <span className="badge badge--edited" title="Hand-edited — no program describes it now">
          Edited · {edits}
        </span>
      )}
      <Dimensions size={size} blockCount={blockCount} />
    </>
  );
}

export function Dimensions({
  size,
  blockCount,
}: {
  size: { x: number; y: number; z: number };
  blockCount: number;
}) {
  return (
    <span className="topbar__dims">
      {size.x}×{size.y}×{size.z}
      <span className="topbar__dot">·</span>
      {blockCount.toLocaleString()} blocks
    </span>
  );
}

/**
 * A name, edited in place.
 *
 * Uncontrolled while focused and re-synced from the prop when it is not: the name also changes
 * from *outside* this field — a new build, a generated one, one opened from the library — and
 * a controlled input would either fight those updates or overwrite what is being typed.
 *
 * Blur commits, Escape abandons. An empty name is refused rather than saved, because the
 * downstream uses of it (a filename, a library row, a line of chat in someone's game) all
 * degrade badly to the empty string.
 */
export function StudioName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
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
      aria-label="Name"
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
