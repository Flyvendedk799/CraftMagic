/**
 * Paired Minecraft worlds (agents), pairing codes, and sending a build into a game.
 *
 * The website never reaches into a Minecraft world. The game dials out, authenticates with a
 * token it obtained by claiming a code the player typed, and only then can a build be queued
 * for it — which is why this hook deals in codes and job ids rather than addresses.
 *
 * ## What a send writes
 *
 * Every send POSTs a *transport row* to `/api/builds`: the mod fetches the build by id over
 * HTTPS, and the browser is not reachable from a Minecraft server, so the build has to exist
 * server-side first. That row is deliberately **not in the library** (`in_library` false —
 * migration 002 exists for exactly this), because a build sent five times would otherwise be
 * five library entries and five placeable components. So sending never clutters the library,
 * and it also never *saves*: someone who wants the build tomorrow presses Save to library,
 * which is a separate row with `in_library` true. The two policies are intentional and this
 * paragraph is where they are written down.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeVoxels, toBase64 } from '@craftmagic/core';
import type { BuildProgram, EditLayer, VoxelGrid } from '@craftmagic/core';

export interface PairedAgent {
  id: string;
  name: string;
  envType: 'integrated' | 'dedicated' | null;
  mcVersion: string | null;
  lastSeenAt: string | null;
  online: boolean;
}

export interface PairCode {
  code: string;
  expiresAt: string;
}

export interface JobProgress {
  jobId: string;
  status: string;
  placed?: number;
  total?: number;
  error?: string | null;
}

export type SendState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'queued'; jobId: string }
  | { kind: 'progress'; jobId: string; status: string; placed: number; total: number }
  | { kind: 'done'; placed: number }
  | {
      kind: 'error';
      message: string;
      /**
       * The job already occupying the world, when that is what refused this send.
       *
       * A 409 `agent_busy` names it, and the cancel route can stop it — so the UI can offer
       * to, instead of telling someone to wait for a build they may not even have sent.
       */
      conflictJobId?: string;
    };

export interface UseAgents {
  agents: PairedAgent[];
  /** False while the database is unavailable, which disables the whole feature. */
  available: boolean;
  /**
   * True when the server answered 401.
   *
   * Distinct from `available`: "this server cannot pair worlds" and "you have to sign in to
   * pair a world" are different problems with different answers, and showing the first when
   * the second is true sends the user looking for a broken deployment.
   */
  needsAccount: boolean;
  loading: boolean;
  pairCode: PairCode | null;
  send: SendState;
  refresh: () => Promise<void>;
  createPairCode: () => Promise<void>;
  clearPairCode: () => void;
  forget: (agentId: string) => Promise<void>;
  sendToGame: (
    agentId: string,
    build: {
      name: string;
      grid: VoxelGrid;
      program: BuildProgram | null;
      /** True once hand edits are in the grid; carried so the transport row tells the truth. */
      detached?: boolean;
      /** The hand-edit layer, stored beside the program exactly as a library save stores it. */
      edits?: EditLayer | null;
    },
  ) => Promise<void>;
  resetSend: () => void;
  /**
   * Stop a job that is not this panel's own — the one a 409 said was in the way.
   *
   * Clears the error afterwards so the send can be tried again; the world is free the moment
   * the mod hears the cancel, which is faster than the stale-job reaper would ever be.
   */
  cancelJob: (jobId: string) => Promise<void>;
  /**
   * Stop a build that is already running in the game.
   *
   * The route has existed since jobs did (`POST /api/agent/jobs/:id/cancel`) and nothing in
   * this app has ever called it — so a build sent by mistake ran to completion and the only
   * way to stop it was a command typed in Minecraft. Blocks already placed stay placed;
   * cancelling is a stop, not an undo, and nothing here can pretend otherwise.
   */
  cancelSend: () => Promise<void>;
}

/** Poll while a pairing code is on screen, so the list flips to "online" without a refresh. */
const PAIRING_POLL_MS = 2500;

export function useAgents(): UseAgents {
  const [agents, setAgents] = useState<PairedAgent[]>([]);
  const [available, setAvailable] = useState(true);
  const [needsAccount, setNeedsAccount] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pairCode, setPairCode] = useState<PairCode | null>(null);
  const [send, setSend] = useState<SendState>({ kind: 'idle' });
  const sourceRef = useRef<EventSource | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/agent/agents');
      if (response.status === 503) {
        setAvailable(false);
        return;
      }
      if (response.status === 401) {
        // Not an error state. Paired worlds belong to an account, so there is genuinely
        // nothing to show until there is one.
        setNeedsAccount(true);
        setAgents([]);
        setAvailable(true);
        return;
      }
      const body = await response.json();
      setAgents(body.agents ?? []);
      setNeedsAccount(false);
      setAvailable(true);
    } catch {
      setAvailable(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => sourceRef.current?.close();
  }, [refresh]);

  // Only poll while a code is displayed. Polling all the time would be a request every few
  // seconds for a page that is usually just showing a build.
  useEffect(() => {
    if (!pairCode) return;
    const timer = setInterval(() => void refresh(), PAIRING_POLL_MS);
    return () => clearInterval(timer);
  }, [pairCode, refresh]);

  const createPairCode = useCallback(async () => {
    const response = await fetch('/api/agent/pair-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) {
      setAvailable(response.status !== 503);
      return;
    }
    setPairCode(await response.json());
  }, []);

  const clearPairCode = useCallback(() => setPairCode(null), []);

  const forget = useCallback(
    async (agentId: string) => {
      await fetch(`/api/agent/agents/${agentId}`, { method: 'DELETE' });
      await refresh();
    },
    [refresh],
  );

  const resetSend = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setSend({ kind: 'idle' });
  }, []);

  /**
   * Stop a running build.
   *
   * The stream is closed first and the state cleared regardless of what the server says: a
   * cancel that fails still means the user asked to stop watching, and leaving a progress
   * bar creeping upward after they pressed Stop is worse than losing the last few percent
   * of a count. The server has its own copy of the truth and the mod hears it over the
   * socket, so nothing depends on this response.
   */
  const cancelSend = useCallback(async () => {
    const jobId =
      send.kind === 'queued' || send.kind === 'progress' ? send.jobId : null;
    sourceRef.current?.close();
    sourceRef.current = null;
    setSend({ kind: 'idle' });
    if (!jobId) return;
    try {
      await fetch(`/api/agent/jobs/${jobId}/cancel`, { method: 'POST' });
    } catch {
      // Already stopped watching; the mod finds out over the socket either way.
    }
  }, [send]);

  const cancelJob = useCallback(async (jobId: string) => {
    try {
      await fetch(`/api/agent/jobs/${jobId}/cancel`, { method: 'POST' });
    } catch {
      // The mod hears the cancel over the socket, or the reaper catches it; either way the
      // next send is the real test.
    }
    setSend({ kind: 'idle' });
  }, []);

  const sendToGame = useCallback<UseAgents['sendToGame']>(async (agentId, build) => {
    sourceRef.current?.close();
    setSend({ kind: 'saving' });

    try {
      // The build has to exist server-side before it can be sent: the mod fetches it by id
      // over HTTPS, and the browser is not reachable from a Minecraft server. `library` is
      // omitted on purpose, which the server reads as false — see the module header.
      const saved = await fetch('/api/builds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: build.name,
          program: build.program ?? undefined,
          detached: build.detached === true,
          edits: build.edits ?? undefined,
          grid: {
            size: build.grid.size,
            palette: build.grid.palette,
            // The same base64 ICVX blob "Save to library" has sent since the body-limit fix.
            // This was still posting one JSON number per cell — 20 MB at the engine's own size
            // cap against a 16 MB limit — so the stress-test sample saved fine and then 413'd on
            // send, from the same Export bar.
            data: toBase64(encodeVoxels(build.grid)),
          },
        }),
      });
      if (!saved.ok) {
        setSend({ kind: 'error', message: `could not save the build (HTTP ${saved.status})` });
        return;
      }
      const { id: buildId } = await saved.json();

      const queued = await fetch('/api/agent/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, buildId }),
      });
      const body = await queued.json().catch(() => ({}));

      if (queued.status === 409) {
        // Two refusals share the status and are told apart by the body. `agent_busy` names the
        // job in the way and can be stopped; a `refused` offer (over the ceiling, or a map
        // region whose first region has not landed) carries the server's own sentence, which
        // is the useful one.
        const busy = body.error === 'agent_busy';
        setSend({
          kind: 'error',
          message: busy
            ? 'Minecraft is still building an earlier send. Wait for it to finish, or stop it and send again.'
            : body.message ?? 'that world will not take this build right now',
          ...(busy && typeof body.jobId === 'string' ? { conflictJobId: body.jobId } : {}),
        });
        return;
      }
      if (!queued.ok) {
        setSend({ kind: 'error', message: body.message ?? `could not queue the build (HTTP ${queued.status})` });
        return;
      }

      const jobId: string = body.id;
      setSend({ kind: 'queued', jobId });

      const source = new EventSource(`/api/agent/jobs/${jobId}/events`);
      sourceRef.current = source;

      source.onmessage = (event) => {
        const progress: JobProgress = JSON.parse(event.data);

        if (progress.status === 'done') {
          source.close();
          sourceRef.current = null;
          setSend({ kind: 'done', placed: progress.placed ?? 0 });
          return;
        }
        if (progress.status === 'failed' || progress.status === 'cancelled') {
          source.close();
          sourceRef.current = null;
          setSend({ kind: 'error', message: progress.error ?? `the build was ${progress.status}` });
          return;
        }

        setSend({
          kind: 'progress',
          jobId,
          status: progress.status,
          placed: progress.placed ?? 0,
          total: progress.total ?? 0,
        });
      };

      source.onerror = () => {
        // The server ends the stream after a terminal event, which surfaces as an error.
        // Only treat it as a failure if this stream is still the live one.
        if (sourceRef.current === source) {
          source.close();
          sourceRef.current = null;
          setSend({ kind: 'error', message: 'lost the connection while building' });
        }
      };
    } catch (err) {
      setSend({ kind: 'error', message: (err as Error).message });
    }
  }, []);

  return {
    agents,
    available,
    needsAccount,
    loading,
    pairCode,
    send,
    cancelSend,
    cancelJob,
    refresh,
    createPairCode,
    clearPairCode,
    forget,
    sendToGame,
    resetSend,
  };
}
