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
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
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
  // `?signup=1` is what the landing page's buttons carry. This page is where the account form
  // lives, so it is also the sign-up destination — the flag only chooses which tab is open.
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
    <div className="library" data-ready={ready ? '1' : '0'} data-count={builds.length}>
      <header className="library__head">
        <div>
          <h1 className="library__title">Library</h1>
          <p className="library__sub">Builds you have saved. They stay here across devices.</p>
        </div>
        <Link className="library__back" to="/editor">
          ← Editor
        </Link>
      </header>

      <section className="panel library__account">
        {/* Unconditionally open, not `auth.status === 'anonymous'`: the panel captures this
            in `useState` on its first render, and on that render the session has not been
            fetched yet — so a computed value here would always resolve to false and the form
            would never appear. Signed in, the panel ignores it. */}
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
  );
}

/** Absolute rather than relative: "3 days ago" is worse than a date once builds are old. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
