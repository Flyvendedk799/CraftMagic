/**
 * Drives a generation from the browser: estimate, start, follow progress.
 *
 * A generation takes 15–60 seconds, so the request that starts it returns immediately and
 * progress arrives over SSE. The server replays buffered events on connect, so there is no
 * race between starting and subscribing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BuildProgram, ExpandIssue, SizeChoice } from '@craftmagic/core';

export interface SpendSummary {
  spentThisMonthUsd: number;
  remainingUsd: number;
  monthlyBudgetUsd: number;
  callsThisMonth: number;
}

export interface Estimate {
  /** Which of the four is serving, so the panel can say who is paying for this. */
  provider: 'anthropic' | 'openai' | 'claude-code' | 'codex';
  /** False on a subscription: the plan is bought, so every figure below is zero. */
  metered: boolean;
  model: string;
  inputTokens: number;
  firstCallUsd: number;
  cachedCallUsd: number;
  worstCaseUsd: number;
  spend: SpendSummary;
}

export interface GenerationResult {
  program: BuildProgram;
  blockCount: number;
  status: 'succeeded' | 'succeeded_with_omissions';
  repaired: boolean;
  issues: ExpandIssue[];
  costUsd: number;
}

export type GenerationPhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'thinking' }
  | {
      kind: 'emitting';
      components: number;
      /** The program so far — only fully-closed components. Drives the live 3D preview. */
      partial?: BuildProgram;
    }
  | { kind: 'validating' }
  | { kind: 'repairing' }
  | { kind: 'failed'; message: string };

export interface UseGeneration {
  phase: GenerationPhase;
  spend: SpendSummary | null;
  estimate: Estimate | null;
  estimating: boolean;
  /** Free — uses the token-counting endpoint, which is not billed. */
  requestEstimate: (prompt: string, size?: SizeChoice) => Promise<void>;
  /** A picture to build from, as base64 and its media type. */
  generateFromImage: (request: {
    prompt: string;
    image: { data: string; mediaType: string };
  }) => Promise<void>;
  clearEstimate: () => void;
  /**
   * Generate a build, or refine one.
   *
   * Passing `refineOf` sends the whole existing program so the model edits it rather than
   * inventing something new that merely matches a description.
   *
   * `size` decides how big the finished build is, not how much detail it gets: the server
   * asks for the structure at whatever size it needs and returns a program carrying the scale
   * that brings it down. It is meaningless alongside `refineOf`, which keeps the size the
   * build is already at.
   */
  generate: (prompt: string, refineOf?: unknown, size?: SizeChoice) => Promise<void>;
  cancel: () => void;
}

const busy = (phase: GenerationPhase) =>
  phase.kind !== 'idle' && phase.kind !== 'failed';

export function useGeneration(onComplete: (result: GenerationResult) => void): UseGeneration {
  const [phase, setPhase] = useState<GenerationPhase>({ kind: 'idle' });
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimating, setEstimating] = useState(false);

  const sourceRef = useRef<EventSource | null>(null);
  // Kept in a ref so the SSE handler always calls the latest callback without needing to
  // tear down and re-open the stream when the parent re-renders.
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;

  useEffect(() => {
    fetch('/api/spend')
      .then((r) => (r.ok ? r.json() : null))
      .then((s: SpendSummary | null) => s && setSpend(s))
      .catch(() => undefined);
    return () => sourceRef.current?.close();
  }, []);

  const cancel = useCallback(() => {
    // Closes the browser's stream only. The generation itself continues server-side — it is
    // already paid for, so abandoning it would waste the spend rather than save it.
    sourceRef.current?.close();
    sourceRef.current = null;
    setPhase({ kind: 'idle' });
  }, []);

  const requestEstimate = useCallback(async (prompt: string, size?: SizeChoice) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setEstimating(true);
    try {
      const response = await fetch('/api/generations/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The size brief is part of the prompt the model sees, so it is part of the price.
        body: JSON.stringify({ prompt: trimmed, ...(size ? { size } : {}) }),
      });
      if (!response.ok) {
        setEstimate(null);
        return;
      }
      const value: Estimate = await response.json();
      setEstimate(value);
      setSpend(value.spend);
    } catch {
      setEstimate(null);
    } finally {
      setEstimating(false);
    }
  }, []);

  const clearEstimate = useCallback(() => setEstimate(null), []);

  const generate = useCallback(async (
    prompt: string,
    refineOf?: unknown,
    size?: SizeChoice,
    image?: { data: string; mediaType: string },
  ) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;

    sourceRef.current?.close();
    setPhase({ kind: 'starting' });

    let id: string;
    try {
      const response = await fetch('/api/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: trimmed,
          ...(refineOf ? { refineOf } : {}),
          ...(size && !refineOf ? { size } : {}),
          // A picture rides along on a refine too: "make it look like this" with a
          // reference image is exactly what a refine is for.
          ...(image ? { image } : {}),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setPhase({
          kind: 'failed',
          message:
            body.message ??
            (response.status === 503
              ? 'No API key configured on the server.'
              : `Could not start generation (HTTP ${response.status}).`),
        });
        if (body.spend) setSpend(body.spend);
        return;
      }
      id = body.id;
    } catch (err) {
      setPhase({ kind: 'failed', message: `Could not reach the server: ${(err as Error).message}` });
      return;
    }

    const source = new EventSource(`/api/generations/${id}/events`);
    sourceRef.current = source;

    source.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'progress') {
        if (data.stage === 'emitting') {
          // Count-only events land between previews; they must not blank the preview a
          // moment after it appeared, so the last partial is carried forward.
          setPhase((previous) => ({
            kind: 'emitting',
            components: data.components ?? 0,
            partial: data.partial ?? (previous.kind === 'emitting' ? previous.partial : undefined),
          }));
        }
        else if (data.stage === 'thinking') setPhase({ kind: 'thinking' });
        else if (data.stage === 'validating') setPhase({ kind: 'validating' });
        else if (data.stage === 'repairing') setPhase({ kind: 'repairing' });
        return;
      }

      if (data.type === 'done') {
        source.close();
        sourceRef.current = null;
        setSpend((previous) => ({
          monthlyBudgetUsd: previous?.monthlyBudgetUsd ?? 0,
          callsThisMonth: (previous?.callsThisMonth ?? 0) + 1,
          spentThisMonthUsd: data.spentThisMonthUsd,
          remainingUsd: data.remainingUsd,
        }));
        setPhase({ kind: 'idle' });
        setEstimate(null);
        completeRef.current({
          program: data.program,
          blockCount: data.blockCount,
          status: data.status,
          repaired: data.repaired,
          issues: data.issues ?? [],
          costUsd: data.costUsd,
        });
        return;
      }

      if (data.type === 'error') {
        source.close();
        sourceRef.current = null;
        setPhase({ kind: 'failed', message: data.message });
      }
    };

    source.onerror = () => {
      // The server ends the stream after a terminal event, which surfaces here as an error.
      // Only treat it as a failure if the generation had not already finished.
      if (sourceRef.current === source) {
        source.close();
        sourceRef.current = null;
        setPhase({ kind: 'failed', message: 'Lost the connection to the generator.' });
      }
    };
  }, []);

  // A picture and a written prompt are the same request with a different subject, so they
  // share the whole path — progress, spend, cancel and the completion callback included.
  const generateFromImage = useCallback(
    (request: { prompt: string; image: { data: string; mediaType: string } }) =>
      generate(request.prompt, undefined, undefined, request.image),
    [generate],
  );

  return {
    phase,
    spend,
    estimate,
    estimating,
    requestEstimate,
    clearEstimate,
    generate,
    generateFromImage,
    cancel,
  };
}

export { busy as isGenerating };
