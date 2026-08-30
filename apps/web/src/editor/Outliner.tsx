/**
 * The component outliner: the program's parts as a list you can act on.
 *
 * This is the panel that makes a build feel *authored* rather than carved: every row is a
 * component the program drew — "Roof", "South windows", "Frame (north-west)" — named by the
 * same design system the printed guide uses, so the words on screen and the words on paper
 * agree. Clicking a row points the camera at the part; the eye toggles it out of the
 * expansion entirely (a re-expand without the component, not a render trick, so exports and
 * block counts follow); Solo isolates one part the way Architecture mode isolates one room.
 *
 * Hiding is deliberately non-destructive view state: the program is never modified, so
 * nothing here can corrupt a build — the worst a bug can do is show the wrong subset.
 */

import type { BuildPart } from '@craftmagic/core';

export interface OutlinePart extends BuildPart {
  label: string;
}

export interface OutlinerProps {
  /** Labeled parts of the *full* program — hidden ones included, or they could never come back. */
  parts: OutlinePart[] | null;
  hidden: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSolo: (path: string) => void;
  onShowAll: () => void;
  /** Point the camera at a part. */
  onFocus: (part: BuildPart) => void;
  /** Outline a part while the pointer rests on its row; null clears. */
  onHighlight: (part: BuildPart | null) => void;
}

export function Outliner({ parts, hidden, onToggle, onSolo, onShowAll, onFocus, onHighlight }: OutlinerProps) {
  if (!parts) return <p className="outliner__empty">Reading the program…</p>;
  if (parts.length === 0) return <p className="outliner__empty">Nothing built yet.</p>;

  return (
    <div className="outliner" onPointerLeave={() => onHighlight(null)}>
      {hidden.size > 0 && (
        <p className="outliner__note">
          {hidden.size} hidden — exports follow what you see.{' '}
          <button type="button" className="tools__inline" onClick={onShowAll}>
            show all
          </button>
        </p>
      )}
      <ul className="outliner__list">
        {parts.map((part) => {
          const off = hidden.has(part.path);
          return (
            <li key={part.path} className="outliner__row" data-hidden={off}>
              <button
                type="button"
                className="outliner__eye"
                aria-pressed={!off}
                title={off ? 'Show this part' : 'Hide this part'}
                onClick={() => onToggle(part.path)}
              >
                {off ? '◌' : '●'}
              </button>
              <button
                type="button"
                className="outliner__name"
                title={`${part.blocks.toLocaleString()} blocks — click to look at it`}
                onPointerEnter={() => onHighlight(part)}
                onClick={() => onFocus(part)}
              >
                {part.label}
              </button>
              <span className="outliner__blocks">{part.blocks.toLocaleString()}</span>
              <button
                type="button"
                className="outliner__solo"
                title="Show only this part"
                onClick={() => onSolo(part.path)}
              >
                solo
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
