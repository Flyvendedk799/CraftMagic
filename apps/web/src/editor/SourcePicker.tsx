/**
 * Where the build on screen came from.
 *
 * This replaced a single wrapping row of look-alike buttons in which "Empty", "Cottage" and
 * a generated build called "Fishing hut on stilts" were the same shape, the same weight and
 * the same size — so the one thing that mattered, *which of these did I make*, was the one
 * thing you could not see. Grouping them by origin costs a heading each and makes the
 * distinction structural rather than typographic.
 *
 * The samples carry a one-line description because their names do not survive being read
 * cold: "Field" told nobody it was a 200k-block stress test, and people clicked it on a
 * laptop expecting a meadow.
 *
 * The saved builds are listed here too, which is the part that was actually missing. Opening
 * one had always been possible — `?build=lib:<id>` is the editor's own URL convention — but
 * the only way to reach that URL was to leave the studio for the library page and come back.
 * A studio that cannot see your own work without navigating away from it is not a studio.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../library/auth.js';
import { listBuilds, type LibraryBuild } from '../library/library.js';
import { libraryBuildId } from './builds.js';

export interface SourceEntry {
  id: string;
  name: string;
}

export interface SourcePickerProps {
  current: string;
  samples: readonly string[];
  generated: readonly SourceEntry[];
  onPick: (id: string) => void;
}

const SAMPLE_LABELS: Record<string, { label: string; hint: string }> = {
  blank: { label: 'Empty plot', hint: 'Start from nothing' },
  cottage: { label: 'Cottage', hint: 'Walls, roof, windows' },
  tower: { label: 'Tower', hint: 'Round, parametric height' },
  pavilion: { label: 'Pavilion', hint: 'Open frame and dome' },
  field: { label: 'Stress test', hint: 'A few hundred thousand blocks' },
};

/** Enough to be useful in a sidebar; the library page is where you go to browse properly. */
const MAX_LIBRARY_ROWS = 8;

export function SourcePicker({ current, samples, generated, onPick }: SourcePickerProps) {
  const library = useLibrary();

  return (
    <div className="source">
      <p className="source__group">Start from</p>
      <div className="source__grid">
        {samples.map((id) => {
          const meta = SAMPLE_LABELS[id] ?? { label: id, hint: '' };
          return (
            <button
              key={id}
              type="button"
              className="source__card"
              aria-pressed={current === id}
              onClick={() => onPick(id)}
            >
              <span className="source__name">{meta.label}</span>
              {meta.hint && <span className="source__hint">{meta.hint}</span>}
            </button>
          );
        })}
      </div>

      {generated.length > 0 && (
        <>
          <p className="source__group">
            Generated this session
            <span className="source__count">{generated.length}</span>
          </p>
          <div className="source__grid source__grid--list">
            {generated.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="source__card source__card--generated"
                aria-pressed={current === entry.id}
                title={entry.name}
                onClick={() => onPick(entry.id)}
              >
                <span className="source__name">✦ {entry.name}</span>
              </button>
            ))}
          </div>
          <p className="source__note">
            Kept for this browser tab only — <Link to="/library">save one</Link> to keep it.
          </p>
        </>
      )}

      {library.kind === 'signedOut' && generated.length === 0 && (
        <p className="source__note">
          Anything you generate appears here. Sign in and your saved builds will too.
        </p>
      )}

      {library.kind === 'empty' && (
        <p className="source__note">Nothing saved yet — the Save panel keeps a build for good.</p>
      )}

      {library.kind === 'failed' && (
        <p className="source__note source__note--error">Could not load your library.</p>
      )}

      {library.kind === 'ready' && (
        <>
          <p className="source__group">
            Your library
            <span className="source__count">{library.builds.length}</span>
          </p>
          <div className="source__grid source__grid--list">
            {library.builds.slice(0, MAX_LIBRARY_ROWS).map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="source__card source__card--saved"
                aria-pressed={current === libraryBuildId(entry.id)}
                title={`${entry.name} — ${entry.blockCount.toLocaleString()} blocks`}
                onClick={() => onPick(libraryBuildId(entry.id))}
              >
                <span className="source__name">{entry.name}</span>
                <span className="source__hint">
                  {entry.sizeX}×{entry.sizeY}×{entry.sizeZ} · {entry.blockCount.toLocaleString()}
                  {/* Worth saying here: a detached build opens with its param sliders gone,
                      and finding that out after clicking is a small mystery every time. */}
                  {entry.detached && ' · edited'}
                </span>
              </button>
            ))}
          </div>
          {library.builds.length > MAX_LIBRARY_ROWS && (
            <p className="source__note">
              <Link to="/library">All {library.builds.length} builds →</Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}

type LibraryState =
  | { kind: 'signedOut' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'failed' }
  | { kind: 'ready'; builds: LibraryBuild[] };

/**
 * The signed-in account's saved builds.
 *
 * Fetched once per sign-in rather than polled: the list only changes when this same tab saves
 * something, and a sidebar that re-fetches on a timer would spend the session issuing requests
 * for a list nobody is looking at. It is deliberately not refreshed after a save either —
 * the save panel already confirms in place, and a list that reshuffles under the cursor
 * mid-edit is worse than one that is a build out of date until the next reload.
 */
function useLibrary(): LibraryState {
  const auth = useAuth();
  const [state, setState] = useState<LibraryState>({ kind: 'signedOut' });
  const signedIn = auth.status === 'signedIn';

  useEffect(() => {
    if (!signedIn) {
      setState({ kind: 'signedOut' });
      return;
    }

    let cancelled = false;
    setState({ kind: 'loading' });

    listBuilds()
      .then((builds) => {
        if (cancelled) return;
        setState(builds.length === 0 ? { kind: 'empty' } : { kind: 'ready', builds });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'failed' });
      });

    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  return state;
}
