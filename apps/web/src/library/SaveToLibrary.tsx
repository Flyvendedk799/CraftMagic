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
import { useAuth } from './auth.js';
import { LibraryError, saveToLibrary } from './library.js';
import './library.css';

export interface SaveToLibraryProps {
  name: string;
  grid: VoxelGrid;
  program: BuildProgram | null;
  detached: boolean;
  /** The hand-edit layer, read at save time so renders never pay for serialising it. */
  getEdits?: () => EditLayer | null;
  /** The layouter's drawing. Stored beside the build so it can be reopened as a plan. */
  plan?: unknown;
}

type State =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; id: string }
  | { kind: 'error'; message: string };

export function SaveToLibrary({ name, grid, program, detached, getEdits, plan }: SaveToLibraryProps) {
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
      });
      setState({ kind: 'saved', id: saved.id });
    } catch (err) {
      const message =
        err instanceof LibraryError && err.status === 401
          ? 'Sign in first — a library needs somewhere to keep things.'
          : (err as Error).message;
      setState({ kind: 'error', message });
    }
  }, [name, grid, program, detached, getEdits, plan]);

  if (auth.status !== 'signedIn') {
    return (
      <div className="save">
        <p className="account__note">
          <Link className="hud__link" to="/library">
            Sign in
          </Link>{' '}
          to keep this build.
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

      {state.kind === 'saved' && (
        <p className="save__note save__note--ok">
          Saved{detached ? ' with your edits' : ''}. It is in your{' '}
          <Link className="save__inline" to="/library">
            library
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
