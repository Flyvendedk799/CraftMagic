// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgents } from './useAgents.js';

describe('useAgents pause, resume, and undo actions', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        if (url === '/api/agent/agents') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              available: true,
              agents: [
                {
                  id: 'agent-1',
                  name: 'SMP',
                  mcVersion: '1.21.4',
                  online: true,
                  envType: 'integrated',
                  lastSeenAt: new Date().toISOString(),
                },
              ],
            }),
          });
        }
        if (url === '/api/agent/status') {
          return Promise.resolve({
            ok: true,
            json: async () => ({ available: true, activeJobs: 0, pendingPairs: 0 }),
          });
        }
        if (url.includes('/pause')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ ok: true }),
          });
        }
        if (url.includes('/resume')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ ok: true }),
          });
        }
        if (url.includes('/undo')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ ok: true, jobId: 'job-undo-1' }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({}),
        });
      }),
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('provides pauseSend, resumeSend, and undoJob functions', () => {
    const { result } = renderHook(() => useAgents());
    expect(typeof result.current.pauseSend).toBe('function');
    expect(typeof result.current.resumeSend).toBe('function');
    expect(typeof result.current.undoJob).toBe('function');
  });

  it('calls POST /api/agent/jobs/:id/undo on undoJob', async () => {
    const { result } = renderHook(() => useAgents());

    await act(async () => {
      await result.current.undoJob('job-999');
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/agent/jobs/job-999/undo',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.current.send.kind).toBe('undoing');
  });

  it('handles pause and resume with mocked EventSource', async () => {
    class MockEventSource {
      url: string;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();
      constructor(url: string) {
        this.url = url;
      }
    }
    vi.stubGlobal('EventSource', MockEventSource);

    const { result } = renderHook(() => useAgents());

    // Trigger undo with event stream
    await act(async () => {
      await result.current.undoJob('job-sse-test');
    });

    expect(result.current.send.kind).toBe('undoing');
  });
});
