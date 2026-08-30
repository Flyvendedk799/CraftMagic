/**
 * The parts bin: every build you have saved, ready to place.
 *
 * This is what turns the library from an archive into a set of components. A saved build was
 * previously something you reopened one at a time; here it is a thing you drop into a layout,
 * as many times as you like, alongside the rooms you drew.
 *
 * Picking one *arms* the Place tool rather than dropping anything. A floorplan has a canvas
 * and a cursor, so where a building goes is a question the click answers — and dropping a
 * twenty-block barn at the origin the moment you clicked its name in a list would be a
 * surprise you then have to undo.
 *
 * The generated builds a session is holding on to are deliberately absent. A plan stores a
 * build's *id* and fetches its blocks, so a reference to something that only exists in this
 * browser tab would come back broken on the next reload. Saving it first is one click, and it
 * is the click that makes the reference durable.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BuildKind } from '../library/library.js';
import type { ShelfEntry } from '../library/components.js';

export interface ComponentsPanelProps {
  shelf: readonly ShelfEntry[];
  status: 'loading' | 'ready' | 'error' | 'signedOut';
  /** Which build the Place tool will drop. */
  chosen: string | null;
  onChoose: (entry: ShelfEntry) => void;
  /** How many times each build is already placed in this plan. */
  counts: ReadonlyMap<string, number>;
  loading: ReadonlySet<string>;
  failed: ReadonlySet<string>;
}

/** Below this a search box is noise; above it, hunting a list in a sidebar is. */
const SEARCH_THRESHOLD = 6;

export function ComponentsPanel({
  shelf,
  status,
  chosen,
  onChoose,
  counts,
  loading,
  failed,
}: ComponentsPanelProps) {
  const [query, setQuery] = useState('');

  /**
   * Structures by default.
   *
   * An interior is the inside of a building: rooms, furniture, a stairwell. Offering one as a
   * thing to drop on a plot offers a house's insides with no house. They stay reachable,
   * because placing a prefabricated room inside a larger shell is a real thing to want — it is
   * just not what you mean nine times in ten.
   */
  const [kinds, setKinds] = useState<BuildKind[]>(['structure']);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return shelf.filter(
      (entry) =>
        kinds.includes(entry.kind) &&
        (!needle || entry.name.toLowerCase().includes(needle)),
    );
  }, [shelf, query, kinds]);

  const interiors = useMemo(() => shelf.filter((entry) => entry.kind === 'interior').length, [shelf]);

  if (status === 'signedOut') {
    return (
      <p className="arch__empty">
        Components are your saved builds, so this needs an account.{' '}
        <Link to="/dashboard">Sign in</Link> and everything in your library shows up here.
      </p>
    );
  }

  if (status === 'loading') return <p className="arch__empty">Loading your library…</p>;
  if (status === 'error') return <p className="arch__empty">Could not load your library.</p>;

  if (shelf.length === 0) {
    return (
      <p className="arch__empty">
        Nothing saved yet. Build something in Build mode, save it to your library, and it
        becomes a component you can place here — as many times as you like.
      </p>
    );
  }

  return (
    <div className="shelf">
      {shelf.length > SEARCH_THRESHOLD && (
        <input
          className="field__input shelf__search"
          type="search"
          value={query}
          placeholder={`Search ${shelf.length} components…`}
          aria-label="Search components"
          onChange={(event) => setQuery(event.target.value)}
        />
      )}

      {interiors > 0 && (
        <div className="shelf__kinds" role="group" aria-label="Which components to show">
          {(['structure', 'interior'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className="shelf__kind"
              aria-pressed={kinds.includes(kind)}
              onClick={() =>
                setKinds((current) =>
                  current.includes(kind)
                    ? // Never leave nothing selected: an empty shelf with no explanation reads
                      // as a broken library rather than as a filter.
                      current.length === 1
                      ? current
                      : current.filter((k) => k !== kind)
                    : [...current, kind],
                )
              }
            >
              {kind === 'structure' ? 'Structures' : 'Interiors'}
            </button>
          ))}
        </div>
      )}

      <ul className="shelf__list">
        {matches.map((entry) => {
          const used = counts.get(entry.id) ?? 0;
          const broken = failed.has(entry.id);

          return (
            <li key={entry.id}>
              <button
                type="button"
                className="shelf__item"
                aria-pressed={chosen === entry.id}
                disabled={broken}
                title={
                  broken
                    ? 'This build could not be loaded'
                    : `Place "${entry.name}" — then click the plan to put it down`
                }
                onClick={() => onChoose(entry)}
              >
                <span className="shelf__name">{entry.name}</span>
                <span className="shelf__meta">
                  {entry.w}×{entry.h}×{entry.d} · {entry.blockCount.toLocaleString()}
                  {/* Worth saying: a hand-edited build has no program left, so placing it is
                      the only way it can be reused at all. */}
                  {entry.detached && ' · hand-edited'}
                </span>
                {used > 0 && (
                  <span className="shelf__used" title={`Placed ${used} time${used === 1 ? '' : 's'}`}>
                    {used}×
                  </span>
                )}
                {loading.has(entry.id) && <span className="shelf__spinner" aria-label="Loading" />}
              </button>
            </li>
          );
        })}
        {matches.length === 0 && <li className="arch__empty">No component matches.</li>}
      </ul>

      <p className="shelf__hint">
        {chosen
          ? 'Now click the plan to place it. R turns it once it is down.'
          : 'Pick one, then click the plan to place it.'}
      </p>
    </div>
  );
}
