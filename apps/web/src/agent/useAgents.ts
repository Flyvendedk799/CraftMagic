/**
 * Paired worlds, pairing codes, and sending a build into a game.
 *
 * The website never reaches into a Minecraft world. A world dials out, authenticates with a
 * token it obtained by claiming a code the player typed, and only then can a build be queued
 * for it — which is why this hook deals in codes and job ids rather than addresses.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BuildProgram, VoxelGrid } from '@imaginecraft/core';

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
  | { kind: 'error'; message: string };

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
    build: { name: string; grid: VoxelGrid; program: BuildProgram | null },
  ) => Promise<void>;
  resetSend: () => void;
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

  const sendToGame = useCallback<UseAgents['sendToGame']>(async (agentId, build) => {
    sourceRef.current?.close();
    setSend({ kind: 'saving' });

    try {
      // The build has to exist server-side before it can be sent: the mod fetches it by id
      // over HTTPS, and the browser is not reachable from a Minecraft server.
      const saved = await fetch('/api/builds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: build.name,
          program: build.program ?? undefined,
          grid: {
            size: build.grid.size,
            palette: build.grid.palette,
            voxels: Array.from(build.grid.voxels),
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
        setSend({ kind: 'error', message: 'that world is already building something' });
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
    refresh,
    createPairCode,
    clearPairCode,
    forget,
    sendToGame,
    resetSend,
  };
}
