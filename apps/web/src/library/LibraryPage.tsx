/**
 * The build library.
 *
 * A gallery, and it took a while to admit that. This was a table for a long time, on the
 * reasoning that thumbnails would mean fetching, expanding and meshing every build to draw a
 * grid of pictures — hundreds of milliseconds each, on a page whose only job is to get you
 * back to the one you meant. The cost was real. The conclusion was wrong: what identifies a
 * build to the person who made it is what it *looks like*, and a row reading "19×17×19, 818
 * blocks" asks them to remember which of their builds was the 818-block one.
 *
 * So the pictures are here and the cost is paid where it has to be — lazily, once, and one
 * at a time. See `thumbnail.ts`, which is the whole of that argument in code.
 *
 * The numbers did not leave; they moved. Each card carries size, block count, date and
 * whether the build still has a program behind it, because those are what you check *after*
 * recognising the build rather than in order to. And the strip above the grid answers the
 * question a list of builds cannot: how much is in here.
 *
 * `data-ready` and `data-count` on the root are the headless driver's readiness signal, the
 * same convention the editor uses: the list arrives over the network, so there is nothing
 * else for a screenshot to wait on.
 *
 * It is the *whole* list, and only that. The dashboard shows the handful of most recent
 * builds alongside everything else about an account; this page is where you come when the
 * handful is not the one you meant — which is why it, and not the dashboard, grew a filter.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AppNav } from '../shell/AppNav.js';
import { StatBand } from '../shell/StatBand.js';
import { AccountPanel } from './AccountPanel.js';
import { BuildThumb } from './BuildThumb.js';
import { useAuth } from './auth.js';
import { deleteBuild, listBuilds, renameBuild, type LibraryBuild } from './library.js';
import { forgetLibraryBuild, libraryBuildId } from '../editor/builds.js';
import './library.css';

type Listing =
  | { status: 'loading' }
  | { status: 'ready'; builds: LibraryBuild[] }
  | { status: 'error'; message: string };

/** How the grid is ordered. Recent first, because the last thing you touched usually wins. */
type SortKey = 'recent' | 'name' | 'size';

const SORTS: readonly { key: SortKey; label: string }[] = [
  { key: 'recent', label: 'Recent' },
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Biggest' },
];

export function LibraryPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  // `?signup=1` chooses which tab the account form opens on. The landing page's buttons carry
  // it to the dashboard now, but the flag is still honoured here: links that pointed at this
  // page are out in the world, in other people's bookmarks and messages, and they should still
  // land on the form they promised.
  const [search] = useSearchParams();
  const signingUp = search.get('signup') === '1';
  const [listing, setListing] = useState<Listing>({ status: 'loading' });
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');

  const refresh = useCallback(async () => {
    try {
      setListing({ status: 'ready', builds: await listBuilds() });
    } catch (err) {
      setListing({ status: 'error', message: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    if (auth.status === 'loading') return;
    if (auth.status === 'anonymous') {
      setListing({ status: 'ready', builds: [] });
      return;
    }
    void refresh();
  }, [auth.status, refresh]);

  const onRename = useCallback(
    async (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setBusy(id);
      try {
        await renameBuild(id, trimmed);
        setRenaming(null);
        await refresh();
      } catch (err) {
        setListing({ status: 'error', message: (err as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const onDelete = useCallback(
    async (build: LibraryBuild) => {
      // A build is minutes of work and there is no undo behind this, so it asks. The name is
      // in the question because the rows look alike.
      if (!window.confirm(`Delete "${build.name}"? This cannot be undone.`)) return;
      setBusy(build.id);
      try {
        await deleteBuild(build.id);
        // The editor caches library builds by id for the session; without this, the back
        // button would happily re-open one that no longer exists.
        forgetLibraryBuild(build.id);
        await refresh();
      } catch (err) {
        setListing({ status: 'error', message: (err as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const builds = listing.status === 'ready' ? listing.builds : [];
  const shown = useMemo(() => arrange(builds, query, sort), [builds, query, sort]);
  const ready = auth.status !== 'loading' && listing.status !== 'loading';

  return (
    <>
      {/* Outside `.library`, which is a centred column: the bar is chrome and spans the
          window. It also replaces the lone "← Editor" link this page used to carry. */}
      <AppNav current="library" />

      <div className="library" data-ready={ready ? '1' : '0'} data-count={builds.length}>
        <header className="library__head">
          <div>
            <p className="library__eyebrow">Library</p>
            <h1 className="library__title">Everything you have built</h1>
            <p className="library__sub">
              Saved builds stay here across devices. Open one to keep editing it, print it as a
              guide, or send it into a paired world — <Link to="/dashboard">your dashboard</Link>{' '}
              shows the recent ones.
            </p>
          </div>
          <Link className="library__new" to="/editor?build=empty">
            New build
          </Link>
        </header>

        {/* Only for someone who arrived signed out, which a direct link and an expired session
            both do. Signed in, the bar above already says who you are and offers the way out, and
            a second copy of that is furniture. The form stays here rather than redirecting to the
            dashboard: this page is a destination people bookmark, and a redirect would lose the
            build they came back for. */}
        {auth.status === 'anonymous' && (
          <section className="panel library__account">
            <AccountPanel
              initiallyOpen
              initialMode={signingUp ? 'register' : 'login'}
              invitation={
                signingUp
                  ? 'Create an account to save builds, generate from a prompt, and send a bot into your world.'
                  : 'Sign in to keep your builds.'
              }
            />
          </section>
        )}

        {listing.status === 'error' && (
          <p className="library__error" role="alert">
            {listing.message}
          </p>
        )}

        {auth.status === 'signedIn' && (
          <>
            {builds.length > 0 && <Totals builds={builds} />}

            {builds.length > 0 && (
              <div className="library__controls">
                <label className="library__search">
                  <span className="library__search-icon" aria-hidden="true">
                    ⌕
                  </span>
                  <input
                    type="search"
                    value={query}
                    placeholder={`Filter ${builds.length} build${builds.length === 1 ? '' : 's'}`}
                    aria-label="Filter builds by name"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>

                <div className="library__sort" role="group" aria-label="Sort builds">
                  {SORTS.map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      aria-pressed={sort === entry.key}
                      onClick={() => setSort(entry.key)}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {listing.status === 'loading' && <p className="library__empty">Loading…</p>}

            {ready && builds.length === 0 && <FirstBuild />}

            {ready && builds.length > 0 && shown.length === 0 && (
              <p className="library__empty">
                No build here is called “{query}”. <button
                  type="button"
                  className="library__linkish"
                  onClick={() => setQuery('')}
                >
                  Clear the filter
                </button>{' '}
                to see all {builds.length}.
              </p>
            )}

            {shown.length > 0 && (
              <ul className="gallery">
                {shown.map((build) => (
                  <li key={build.id} className="card" data-build={build.id}>
                    {renaming?.id === build.id ? (
                      <form
                        className="card__rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void onRename(build.id, renaming.name);
                        }}
                      >
                        <label className="card__rename-label" htmlFor={`rename-${build.id}`}>
                          New name
                        </label>
                        <input
                          id={`rename-${build.id}`}
                          className="card__input"
                          value={renaming.name}
                          autoFocus
                          maxLength={80}
                          onChange={(event) =>
                            setRenaming({ id: build.id, name: event.target.value })
                          }
                        />
                        <div className="card__actions">
                          <button
                            type="submit"
                            className="card__action card__action--go"
                            disabled={busy === build.id}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="card__action"
                            onClick={() => setRenaming(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        {/* The whole picture opens the build. It is the biggest target on the
                            card and the thing people reach for; a link buried in the caption
                            would be a smaller target for the same intent. */}
                        <Link
                          className="card__open"
                          to={`/editor?build=${libraryBuildId(build.id)}`}
                          aria-label={`Open ${build.name} in the editor`}
                        >
                          <BuildThumb build={build} />
                        </Link>

                        <div className="card__body">
                          <h2 className="card__name">
                            <Link to={`/editor?build=${libraryBuildId(build.id)}`}>
                              {build.name}
                            </Link>
                          </h2>

                          <p className="card__facts">
                            <span className="card__dim">
                              {build.sizeX}×{build.sizeY}×{build.sizeZ}
                            </span>
                            <span>{build.blockCount.toLocaleString()} blocks</span>
                            <span>{formatDate(build.updatedAt)}</span>
                          </p>

                          {/* A resizable build still has its program, so the size sliders work
                              on it; an edited one is voxels only. Which of the two you are
                              looking at decides what the editor can do with it, so it is on the
                              card rather than a surprise once it is open. */}
                          <p className="card__kind" data-kind={kindOf(build)}>
                            {kindOf(build) === 'resizable'
                              ? 'Resizable — keeps its program'
                              : 'Edited — voxels only'}
                          </p>
                        </div>

                        <div className="card__actions">
                          <Link
                            className="card__action card__action--go"
                            to={`/editor?build=${libraryBuildId(build.id)}`}
                          >
                            Open
                          </Link>
                          <Link
                            className="card__action"
                            to={`/guide?build=${libraryBuildId(build.id)}`}
                          >
                            Guide
                          </Link>
                          {/* Only for builds Architecture mode saved: the drawing rode up with
                              them, so they reopen as a plan — walls still walls. */}
                          {build.hasPlan && (
                            <Link
                              className="card__action"
                              to={`/architecture?plan=lib:${encodeURIComponent(build.id)}`}
                              aria-label={`Open ${build.name} as a plan in Architecture`}
                            >
                              Plan
                            </Link>
                          )}
                          {/* Housekeeping, pushed to the far edge and drawn quietly. Four
                              buttons of equal weight would say all four are equally likely,
                              and one of them deletes the build. */}
                          <button
                            type="button"
                            className="card__action card__action--quiet card__actions-gap"
                            onClick={() => setRenaming({ id: build.id, name: build.name })}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            className="card__action card__action--quiet card__action--danger"
                            disabled={busy === build.id}
                            onClick={() => void onDelete(build)}
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  );
}

/* --- summary ------------------------------------------------------------- */

/**
 * What is in here, in four numbers.
 *
 * A list of builds cannot answer "how much have I made", and that is the question someone
 * opening their own library after a while actually has. The tallest build is in there
 * because height is the one dimension people remember competing on.
 */
function Totals({ builds }: { builds: LibraryBuild[] }) {
  const blocks = builds.reduce((sum, build) => sum + build.blockCount, 0);
  const tallest = builds.reduce((best, build) => (build.sizeY > best.sizeY ? build : best), builds[0]!);
  const resizable = builds.filter((build) => kindOf(build) === 'resizable').length;

  return (
    <StatBand
      label="Library totals"
      stats={[
        { label: 'Builds', value: builds.length.toLocaleString() },
        { label: 'Blocks', value: blocks.toLocaleString() },
        { label: 'Tallest', value: `${tallest.sizeY}`, note: `high · ${tallest.name}` },
        { label: 'Still resizable', value: `${resizable}`, note: `of ${builds.length}` },
      ]}
    />
  );
}

/* --- empty state --------------------------------------------------------- */

/**
 * The library with nothing in it.
 *
 * Three doors rather than one sentence, because "nothing saved yet" is a statement about the
 * past and what someone needs here is the next move. All three lead into the editor, which
 * is the only place a build can be made.
 */
function FirstBuild() {
  return (
    <section className="firstbuild">
      <h2 className="firstbuild__title">Nothing saved yet</h2>
      <p className="firstbuild__lead">
        A build lands here the moment you press “Save to library” in the editor. From there it
        follows you across devices, prints as a guide, and can be handed to a bot in your own
        world.
      </p>
      <div className="firstbuild__ways">
        <Link className="firstbuild__way" to="/editor?build=empty">
          <span className="firstbuild__way-title">Start from an empty plot</span>
          <span className="firstbuild__way-body">
            Bare ground and a full block palette. Click the floor to lay the first block.
          </span>
        </Link>
        <Link className="firstbuild__way" to="/editor?build=cottage">
          <span className="firstbuild__way-title">Open a sample</span>
          <span className="firstbuild__way-body">
            The cottage, the tower and the pavilion all come apart — change their shape with the
            sliders and save the result.
          </span>
        </Link>
        <Link className="firstbuild__way" to="/dashboard">
          <span className="firstbuild__way-title">Describe one instead</span>
          <span className="firstbuild__way-body">
            Type what you want on the dashboard and let the model draft it, then edit from there.
          </span>
        </Link>
      </div>
    </section>
  );
}

/* --- ordering ------------------------------------------------------------ */

/** True once no program describes the build any more — only its voxels do. */
function kindOf(build: LibraryBuild): 'resizable' | 'edited' {
  return build.detached || !build.hasProgram ? 'edited' : 'resizable';
}

/**
 * Filter, then order.
 *
 * The server's order is not part of its contract and "recent" is a promise the sort control
 * makes out loud, so this sorts rather than trusts. `updatedAt` rather than `createdAt`:
 * renaming a build is how someone tells you which one they care about.
 */
function arrange(builds: LibraryBuild[], query: string, sort: SortKey): LibraryBuild[] {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? builds.filter((build) => build.name.toLowerCase().includes(needle))
    : builds;

  const ordered = [...matched];
  if (sort === 'name') ordered.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'size') ordered.sort((a, b) => b.blockCount - a.blockCount);
  else ordered.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return ordered;
}

/** Absolute rather than relative: "3 days ago" is worse than a date once builds are old. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
