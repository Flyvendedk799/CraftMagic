/**
 * "Save to library" — the editor's one write into the library.
 *
 * Saves the grid *as it is on screen*, edits included, which is why it takes the live session
 * grid rather than the expanded build. A hand-edited build is marked detached on the way up so
 * the server knows the program no longer describes it; the program is still stored, because
 * throwing away the recipe would be irreversible and keeping it costs a few kilobytes.
 */

import { useCallback, useState } from 'react';
import type { BuildProgram, EditLayer, VoxelGrid } from '@craftmagic/core';
import { Link } from 'react-router-dom';
import { placeOnMap } from '../studio/handoff.js';
import { useAuth } from './auth.js';
import { LibraryError, saveToLibrary, type BuildKind } from './library.js';
import './library.css';

export interface SaveToLibraryProps {
  name: string;
  grid: VoxelGrid;
  program: BuildProgram | null;
  detached: boolean;
  /** The hand-edit layer, read at save time so renders never pay for serialising it. */
  getEdits?: () => EditLayer | null;
  /** Architecture mode's drawing. Stored beside the build so it can be reopened as a plan. */
  plan?: unknown;
  /**
   * Which tier made this. Defaults to a structure, which is what the editor makes.
   *
   * It decides which shelf the build turns up on later: a component shelf offering interiors
   * as things to drop on a hillside is offering the inside of a house with no house.
   */
  kind?: BuildKind;
  /**
   * The library row this build was opened from, if any.
   *
   * Saving always writes a new row — there is no "save over", and the server's PATCH only
   * renames — so someone who opened a library build and pressed Save gets a second copy. That
   * is not wrong, but it has to be said before the click rather than discovered in the list.
   */
  libraryRowId?: string | null;
  /** Called with the new row's id. The page uses it to offer the next step with a durable id. */
  onSaved?: (id: string) => void;
  /** The generation this program came from, so the server can link the two rows. */
  generationId?: string | null;
}

type State =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; id: string }
  | { kind: 'error'; message: string };

export function SaveToLibrary({
  name,
  grid,
  program,
  detached,
  getEdits,
  plan,
  kind,
  libraryRowId = null,
  onSaved,
  generationId = null,
}: SaveToLibraryProps) {
  const auth = useAuth();
  const [state, setState] = useState<State>({ kind: 'idle' });

  const save = useCallback(async () => {
    setState({ kind: 'saving' });
    try {
      const saved = await saveToLibrary({
        name,
        grid,
        program,
        detached,
        edits: getEdits?.() ?? null,
        plan: plan ?? null,
        kind,
        generationId,
      });
      setState({ kind: 'saved', id: saved.id });
      onSaved?.(saved.id);
    } catch (err) {
      const message =
        err instanceof LibraryError && err.status === 401
          ? 'Sign in first — a library needs somewhere to keep things.'
          : (err as Error).message;
      setState({ kind: 'error', message });
    }
  }, [name, grid, program, detached, getEdits, plan, kind, generationId, onSaved]);

  if (auth.status !== 'signedIn') {
    return (
      <div className="save">
        <p className="account__note">
          <Link className="hud__link" to="/dashboard">
            Sign in
          </Link>{' '}
          to keep this build. Until it is saved it lives only in this browser.
        </p>
      </div>
    );
  }

  return (
    <div className="save">
      <div className="save__actions">
        <button type="button" onClick={() => void save()} disabled={state.kind === 'saving'}>
          {state.kind === 'saving' ? 'Saving…' : 'Save to library'}
        </button>
        <Link className="export__link" to="/library">
          Library →
        </Link>
      </div>

      {state.kind === 'idle' && libraryRowId && (
        <p className="save__note">
          Saves a new copy. The build you opened stays as it is in the library.
        </p>
      )}

      {state.kind === 'saved' && (
        <p className="save__note save__note--ok">
          Saved{detached ? ' with your edits' : ''}. It is in your{' '}
          <Link className="save__inline" to="/library">
            library
          </Link>
          {' · '}
          {/* The next step in the product's own order — Make, Save, then Compose — offered with
              the id that will still resolve tomorrow, not the browser-only one it was made
              under. */}
          <Link className="save__inline" to={placeOnMap(state.id)}>
            place it on a map
          </Link>
          .
        </p>
      )}
      {state.kind === 'error' && (
        <p className="save__note save__note--error" role="alert">
          {state.message}
        </p>
      )}
    </div>
  );
}
