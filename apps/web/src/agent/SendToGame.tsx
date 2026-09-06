/**
 * "Send to game" — pair Minecraft, then build in it.
 *
 * The pairing code is the security boundary of this whole feature, so it is shown large and
 * with the exact command to type. Anyone who can read it can attach a Minecraft world to this
 * account for ten minutes; nobody who cannot read it can attach anything at all.
 *
 * On the words: a paired game instance is "Minecraft" or "a Minecraft world" everywhere in the
 * UI, never a bare "world". The studio has a World mode — a map you sculpt and place builds
 * on — and a dashboard card called "Your worlds" that meant paired game servers was the single
 * most frequent way for the two to be confused.
 */

import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BuildProgram, EditLayer, VoxelGrid } from '@craftmagic/core';
import { useAgents, type PairedAgent } from './useAgents.js';
import './agent.css';

export interface SendToGameProps {
  name: string;
  grid: VoxelGrid;
  /**
   * Null for a hand-edited build. The mod is sent the voxels either way — it places blocks,
   * not programs — so this only decides whether the saved row keeps its recipe.
   */
  program: BuildProgram | null;
  /**
   * Whether hand edits are in the grid, and the layer they live in.
   *
   * The transport row a send writes used to carry the composited voxels and the program but
   * never the edit layer, so a row reopened from the database — support looking into a send,
   * say — showed a program that no longer described its own voxels with nothing to explain the
   * gap. "Save to library" has always sent all three; the send now does too.
   */
  detached?: boolean;
  getEdits?: () => EditLayer | null;
}

function lastSeen(agent: PairedAgent): string {
  if (agent.online) return 'online now';
  if (!agent.lastSeenAt) return 'never connected';
  const minutes = Math.round((Date.now() - new Date(agent.lastSeenAt).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function SendToGame({ name, grid, program, detached = false, getEdits }: SendToGameProps) {
  const {
    agents,
    available,
    needsAccount,
    loading,
    pairCode,
    send,
    createPairCode,
    clearPairCode,
    forget,
    sendToGame,
    resetSend,
    cancelSend,
    cancelJob,
  } = useAgents();
  const [copied, setCopied] = useState(false);

  const copyCommand = useCallback(async () => {
    if (!pairCode) return;
    try {
      await navigator.clipboard.writeText(`/craftmagic pair ${pairCode.code}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the command is on screen to type either way.
    }
  }, [pairCode]);

  if (!available) {
    return (
      <div className="agent">
        <p className="agent__note">
          Unavailable — this server has no database configured, so Minecraft cannot be paired.
        </p>
      </div>
    );
  }

  // A paired game is a door into somebody's real Minecraft world, so it has to belong to an
  // account. Said plainly here rather than left as a 401 in the console.
  if (needsAccount) {
    return (
      <div className="agent">
        <p className="agent__note">
          Sending a build needs an account: pairing attaches your Minecraft world to it, so a
          stranger cannot build there.{' '}
          <Link className="agent__link" to="/dashboard">
            Sign in
          </Link>{' '}
          to pair Minecraft.
        </p>
      </div>
    );
  }

  const busy = send.kind === 'saving' || send.kind === 'queued' || send.kind === 'progress';

  return (
    <div className="agent">

      {loading && <p className="agent__note">Looking for paired Minecraft…</p>}

      {!loading && agents.length === 0 && !pairCode && (
        <p className="agent__note">
          Nothing paired yet. You’ll need the{' '}
          {/* The pairing command below does not exist until the mod is installed, so the
              first-run state has to say where to get it rather than assuming they know. */}
          <Link className="agent__link" to="/mod" target="_blank">
            CraftMagic mod
          </Link>{' '}
          in Minecraft first.
        </p>
      )}

      {agents.length > 0 && (
        <ul className="agent__list">
          {agents.map((agent) => (
            <li key={agent.id} className="agent__row">
              <span className={`agent__dot ${agent.online ? 'agent__dot--on' : ''}`} aria-hidden="true" />
              <span className="agent__name" title={agent.mcVersion ?? undefined}>
                {agent.name}
                <span className="agent__meta">{lastSeen(agent)}</span>
              </span>
              <button
                type="button"
                className="agent__send"
                disabled={!agent.online || busy}
                title={agent.online ? `Build "${name}" here` : 'That world is offline — start Minecraft first'}
                onClick={() =>
                  void sendToGame(agent.id, { name, grid, program, detached, edits: getEdits?.() ?? null })
                }
              >
                Build here
              </button>
              <button
                type="button"
                className="agent__forget"
                title="Forget this world"
                onClick={() => void forget(agent.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {pairCode ? (
        <div className="agent__pairing">
          <p className="agent__note">In Minecraft, run:</p>
          <code className="agent__code">/craftmagic pair {pairCode.code}</code>
          <div className="agent__pairing-actions">
            <button type="button" onClick={() => void copyCommand()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" onClick={clearPairCode}>
              Done
            </button>
          </div>
          <p className="agent__note agent__note--dim">
            Expires in 10 minutes. Your Minecraft world appears above once it connects. Command
            not recognised?{' '}
            <Link className="agent__link" to="/mod" target="_blank">
              Install the mod
            </Link>
            .
          </p>
        </div>
      ) : (
        <button type="button" className="agent__pair" onClick={() => void createPairCode()}>
          Pair Minecraft…
        </button>
      )}

      {send.kind === 'saving' && <p className="agent__status">Saving the build…</p>}
      {send.kind === 'queued' && (
        <p className="agent__status">
          Sent — waiting for the world…{' '}
          <button type="button" className="tools__inline" onClick={() => void cancelSend()}>
            stop
          </button>
        </p>
      )}

      {send.kind === 'progress' && (
        <div className="agent__status">
          {send.status === 'previewing' ? (
            <>Ready in game — right-click with your wand where you want it, then punch the air.</>
          ) : (
            <>
              Building… {send.placed.toLocaleString()} / {send.total.toLocaleString()}
              <span className="agent__bar">
                <span style={{ width: `${send.total ? Math.round((send.placed / send.total) * 100) : 0}%` }} />
              </span>
            </>
          )}{' '}
          {/* Stopping matters most here, once blocks are actually going down. It is a stop, not
              an undo — what is placed stays placed — and the wording has to say so. */}
          <button type="button" className="tools__inline" onClick={() => void cancelSend()}>
            stop building
          </button>
        </div>
      )}

      {send.kind === 'done' && (
        <p className="agent__status agent__status--ok">
          Built — {send.placed.toLocaleString()} blocks placed.{' '}
          <button type="button" className="agent__link" onClick={resetSend}>
            Send again
          </button>
        </p>
      )}

      {send.kind === 'error' && (
        <p className="agent__status agent__status--error" role="alert">
          {send.message}{' '}
          {/* A 409 names the job in the way, and the cancel route has always been able to stop
              it — so the honest answer to "already building something" is a button, not a
              shrug. Stopping is not undoing: what is placed stays placed, and the label says
              stop. */}
          {send.conflictJobId && (
            <button
              type="button"
              className="agent__link"
              onClick={() => void cancelJob(send.conflictJobId!)}
            >
              Stop that build
            </button>
          )}{' '}
          <button type="button" className="agent__link" onClick={resetSend}>
            Dismiss
          </button>
        </p>
      )}
    </div>
  );
}
