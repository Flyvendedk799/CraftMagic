/**
 * The build library.
 *
 * A table, not a gallery. Thumbnails would mean expanding and meshing every build to draw a
 * grid of pictures — hundreds of milliseconds each, on a page whose entire job is to get you
 * back to the one you meant. Name, size, block count and date identify a build well enough
 * for that, and opening one is a click away.
 *
 * `data-ready` and `data-count` on the root are the headless driver's readiness signal, the
 * same convention the editor uses: the list arrives over the network, so there is nothing
 * else for a screenshot to wait on.
 *
 * It is the *whole* list, and only that. The dashboard shows the handful of most recent builds
 * alongside everything else about an account; this page is where you come when the handful is
 * not the one you meant. Splitting them that way is what lets this stay a dense table instead
 * of growing a summary nobody scrolls past.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AppNav } from '../shell/AppNav.js';
import { AccountPanel } from './AccountPanel.js';
import { useAuth } from './auth.js';
import { deleteBuild, listBuilds, renameBuild, type LibraryBuild } from './library.js';
import { forgetLibraryBuild, libraryBuildId } from '../editor/builds.js';
import './library.css';

type Listing =
  | { status: 'loading' }
  | { status: 'ready'; builds: LibraryBuild[] }
  | { status: 'error'; message: string };

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
  const ready = auth.status !== 'loading' && listing.status !== 'loading';

  return (
    <>
      {/* Outside `.library`, which is a centred 60rem column: the bar is chrome and spans the
          window. It also replaces the lone "← Editor" link this page used to carry. */}
      <AppNav current="library" />

      <div className="library" data-ready={ready ? '1' : '0'} data-count={builds.length}>
        <header className="library__head">
          <div>
            <h1 className="library__title">Library</h1>
            <p className="library__sub">
              Every build you have saved. They stay here across devices —{' '}
              <Link to="/dashboard">your dashboard</Link> shows the recent ones.
            </p>
          </div>
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
          <section className="panel">
            <h2>Saved builds</h2>

            {listing.status === 'loading' && <p className="library__empty">Loading…</p>}

            {ready && builds.length === 0 && (
              <p className="library__empty">
                Nothing saved yet. Open a build in the <Link to="/editor">editor</Link> and press
                “Save to library”.
              </p>
            )}

            {builds.length > 0 && (
              <ul className="library__list">
                {builds.map((build) => (
                  <li key={build.id} className="library__row" data-build={build.id}>
                    {renaming?.id === build.id ? (
                      <form
                        className="library__rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void onRename(build.id, renaming.name);
                        }}
                      >
                        <input
                          className="library__input"
                          aria-label="New name"
                          value={renaming.name}
                          autoFocus
                          maxLength={80}
                          onChange={(event) => setRenaming({ id: build.id, name: event.target.value })}
                        />
                        <button type="submit" disabled={busy === build.id}>
                          Save
                        </button>
                        <button type="button" onClick={() => setRenaming(null)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="library__name"
                          title="Open in the editor"
                          onClick={() => navigate(`/editor?build=${libraryBuildId(build.id)}`)}
                        >
                          {build.name}
                        </button>

                        <dl className="library__meta">
                          <dt>Size</dt>
                          <dd>
                            {build.sizeX}×{build.sizeY}×{build.sizeZ}
                          </dd>
                          <dt>Blocks</dt>
                          <dd>{build.blockCount.toLocaleString()}</dd>
                          <dt>Saved</dt>
                          <dd>{formatDate(build.createdAt)}</dd>
                          <dt>Kind</dt>
                          <dd>{build.detached || !build.hasProgram ? 'edited' : 'resizable'}</dd>
                        </dl>

                        <div className="library__actions">
                          <button
                            type="button"
                            onClick={() => navigate(`/editor?build=${libraryBuildId(build.id)}`)}
                          >
                            Open
                          </button>
                          <button
                            type="button"
                            onClick={() => setRenaming({ id: build.id, name: build.name })}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            className="library__delete"
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
          </section>
        )}
      </div>
    </>
  );
}

/** Absolute rather than relative: "3 days ago" is worse than a date once builds are old. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
