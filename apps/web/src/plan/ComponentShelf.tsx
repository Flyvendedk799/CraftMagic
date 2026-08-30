/**
 * The parts bin: every build in your library, ready to place.
 *
 * This is the whole point of the feature — a saved build stops being an archived thing you
 * can only reopen one at a time and becomes a *component*. Clicking one drops an instance on
 * the plot; clicking it again drops another. Nothing is consumed, so the same watchtower is
 * four corner towers.
 *
 * Only the library appears here, deliberately. A generated build that has not been saved is
 * kept in this browser tab and nowhere else, so a plan that referenced one would break on the
 * next reload — and the plan stores ids, not grids. Saving it first is one click, and it is
 * the click that makes the reference durable.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LibraryBuild } from '../library/library.js';

export interface ComponentShelfProps {
  builds: LibraryBuild[];
  /** How many times each source id is already on the plot. */
  counts: Map<string, number>;
  loading: Set<string>;
  failed: Set<string>;
  onPlace: (build: { id: string; name: string }) => void;
  signedIn: boolean;
  status: 'loading' | 'ready' | 'error';
}

/** Below this the search box is noise; above it, scrolling a sidebar to find one build is. */
const SEARCH_THRESHOLD = 6;

export function ComponentShelf({
  builds,
  counts,
  loading,
  failed,
  onPlace,
  signedIn,
  status,
}: ComponentShelfProps) {
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return builds;
    return builds.filter((build) => build.name.toLowerCase().includes(needle));
  }, [builds, query]);

  if (!signedIn) {
    return (
      <p className="shelf__empty">
        Components come from your library, so this needs an account. Sign in from the title bar
        and everything you have saved shows up here.
      </p>
    );
  }

  if (status === 'loading') return <p className="shelf__empty">Loading your library…</p>;
  if (status === 'error') return <p className="shelf__empty shelf__empty--error">Could not load your library.</p>;

  if (builds.length === 0) {
    return (
      <p className="shelf__empty">
        Nothing saved yet. Build something in the <Link to="/">editor</Link>, save it to your
        library, and it becomes a component you can place here — as many times as you like.
      </p>
    );
  }

  return (
    <div className="shelf">
      {builds.length > SEARCH_THRESHOLD && (
        <input
          className="shelf__search"
          type="search"
          value={query}
          placeholder={`Search ${builds.length} components…`}
          aria-label="Search components"
          onChange={(event) => setQuery(event.target.value)}
        />
      )}

      <ul className="shelf__list">
        {matches.map((build) => {
          const used = counts.get(build.id) ?? 0;
          const busy = loading.has(build.id);
          const broken = failed.has(build.id);

          return (
            <li key={build.id}>
              <button
                type="button"
                className="shelf__item"
                disabled={busy || broken}
                title={broken ? 'This build could not be loaded' : `Place "${build.name}" on the plot`}
                onClick={() => onPlace({ id: build.id, name: build.name })}
              >
                <span className="shelf__name">{build.name}</span>
                <span className="shelf__meta">
                  {build.sizeX}×{build.sizeY}×{build.sizeZ} · {build.blockCount.toLocaleString()}
                  {build.detached && ' · edited'}
                </span>
                {/* The count is the difference between "did that work?" and clicking twice. */}
                {used > 0 && <span className="shelf__used">{used}×</span>}
                <span className="shelf__add" aria-hidden="true">
                  {busy ? '…' : broken ? '!' : '+'}
                </span>
              </button>
            </li>
          );
        })}
        {matches.length === 0 && <li className="shelf__empty">No component matches.</li>}
      </ul>
    </div>
  );
}
