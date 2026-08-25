/**
 * "Send to game" — pair a world, then build in it.
 *
 * The pairing code is the security boundary of this whole feature, so it is shown large and
 * with the exact command to type. Anyone who can read it can attach a world to this account
 * for ten minutes; nobody who cannot read it can attach anything at all.
 */

import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BuildProgram, VoxelGrid } from '@craftmagic/core';
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

export function SendToGame({ name, grid, program }: SendToGameProps) {
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
          Unavailable — this server has no database configured, so worlds cannot be paired.
        </p>
      </div>
    );
  }

  // A paired world is a door into somebody's real game, so it has to belong to an account.
  // Said plainly here rather than left as a 401 in the console.
  if (needsAccount) {
    return (
      <div className="agent">
        <p className="agent__note">
          Pairing a world attaches it to your account, so a stranger cannot build in it.{' '}
          <Link className="agent__link" to="/dashboard">
            Sign in
          </Link>{' '}
          to pair one.
        </p>
      </div>
    );
  }

  const busy = send.kind === 'saving' || send.kind === 'queued' || send.kind === 'progress';

  return (
    <div className="agent">

      {loading && <p className="agent__note">Looking for paired worlds…</p>}

      {!loading && agents.length === 0 && !pairCode && (
        <p className="agent__note">
          No worlds paired yet. You’ll need the{' '}
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
                onClick={() => void sendToGame(agent.id, { name, grid, program })}
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
            Expires in 10 minutes. The world appears above once it connects. Command not
            recognised?{' '}
            <Link className="agent__link" to="/mod" target="_blank">
              Install the mod
            </Link>
            .
          </p>
        </div>
      ) : (
        <button type="button" className="agent__pair" onClick={() => void createPairCode()}>
          Pair a world…
        </button>
      )}

      {send.kind === 'saving' && <p className="agent__status">Saving the build…</p>}
      {send.kind === 'queued' && <p className="agent__status">Sent — waiting for the world…</p>}

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
          )}
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
          <button type="button" className="agent__link" onClick={resetSend}>
            Dismiss
          </button>
        </p>
      )}
    </div>
  );
}
