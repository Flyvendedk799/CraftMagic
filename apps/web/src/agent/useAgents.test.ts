// @vitest-environment jsdom
/**
 * The send panel's controls, driven end to end through the hook: the request each one makes,
 * what the progress stream then says, and what the panel ends up showing.
 *
 * The stream is a stand-in EventSource the test pushes frames into, in the shapes the server's
 * events route writes. A control's request is answered per test, because the interesting cases
 * are the refusals — a 409 from the route, or the mod declining an undo over the socket.
 */
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoxelGrid } from '@craftmagic/core';
import { useAgents } from './useAgents.js';

class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  /** Deliver one frame, as the server's `data: {...}` line would. */
  emit(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
  static latest(): MockEventSource {
    const source = MockEventSource.instances.at(-1);
    if (!source) throw new Error('no EventSource was opened');
    return source;
  }
}

const grid: VoxelGrid = {
  size: { x: 2, y: 2, z: 2 },
  voxels: new Uint16Array(8).fill(1),
  palette: ['minecraft:air', 'minecraft:stone'],
};

/** Answers for the control routes, per test. Anything not listed is a 200. */
let controlReplies: Record<string, { status: number; body: Record<string, unknown> }> = {};
let fetchMock: ReturnType<typeof vi.fn>;

function reply(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
  MockEventSource.instances = [];
  controlReplies = {};
  vi.stubGlobal('EventSource', MockEventSource);
  fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/agent/agents') return reply(200, { agents: [] });
    if (url === '/api/builds' && init?.method === 'POST') return reply(201, { id: 'build-1' });
    if (url === '/api/agent/jobs' && init?.method === 'POST') return reply(202, { id: 'job-1', delivered: true });
    const action = /\/api\/agent\/jobs\/[^/]+\/(pause|resume|undo|cancel)$/.exec(url)?.[1];
    if (action) {
      const answer = controlReplies[action] ?? { status: 200, body: { ok: true } };
      return reply(answer.status, answer.body);
    }
    return reply(200, {});
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A hook that has sent a build and is watching it go down at 25 of 100. */
async function building() {
  const hook = renderHook(() => useAgents());
  await act(async () => {
    await hook.result.current.sendToGame('agent-1', { name: 'Castle', grid, program: null });
  });
  const stream = MockEventSource.latest();
  expect(stream.url).toBe('/api/agent/jobs/job-1/events');
  act(() => stream.emit({ jobId: 'job-1', status: 'building', placed: 25, total: 100 }));
  expect(hook.result.current.send).toMatchObject({ kind: 'progress', status: 'building', placed: 25 });
  return { hook, stream };
}

function calls(action: string): unknown[][] {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(`/${action}`));
}

describe('pause and resume', () => {
  it('pauses, then resumes, the job it is watching', async () => {
    const { hook, stream } = await building();

    await act(async () => {
      await hook.result.current.pauseSend();
    });
    expect(calls('pause')).toEqual([['/api/agent/jobs/job-1/pause', { method: 'POST' }]]);
    expect(hook.result.current.send).toEqual({ kind: 'paused', jobId: 'job-1', placed: 25, total: 100 });

    // The route emits the move too; the panel agrees with it rather than flickering.
    act(() => stream.emit({ jobId: 'job-1', status: 'paused', placed: 25, total: 100 }));
    expect(hook.result.current.send.kind).toBe('paused');

    await act(async () => {
      await hook.result.current.resumeSend();
    });
    expect(calls('resume')).toEqual([['/api/agent/jobs/job-1/resume', { method: 'POST' }]]);
    expect(hook.result.current.send).toMatchObject({ kind: 'progress', status: 'building', placed: 25 });
    expect(hook.result.current.controlError).toBeNull();
  });

  it('follows a pause made in game, from the stream alone', async () => {
    const { hook, stream } = await building();
    act(() => stream.emit({ jobId: 'job-1', status: 'paused', placed: 30, total: 100 }));
    expect(hook.result.current.send).toEqual({ kind: 'paused', jobId: 'job-1', placed: 30, total: 100 });
  });

  it('shows a refused pause without pretending the build paused', async () => {
    const { hook } = await building();
    controlReplies.pause = {
      status: 409,
      body: { error: 'agent_offline', message: 'That Minecraft world is not connected right now.' },
    };

    await act(async () => {
      await hook.result.current.pauseSend();
    });
    expect(hook.result.current.send.kind).toBe('progress');
    expect(hook.result.current.controlError).toBe('That Minecraft world is not connected right now.');
  });

  it('sends nothing when there is no build in progress to pause', async () => {
    const hook = renderHook(() => useAgents());
    await act(async () => {
      await hook.result.current.pauseSend();
      await hook.result.current.resumeSend();
    });
    expect(calls('pause')).toEqual([]);
    expect(calls('resume')).toEqual([]);
  });
});

describe('undo', () => {
  /** A hook whose build has finished: 100 blocks, done. */
  async function done() {
    const { hook, stream } = await building();
    act(() => stream.emit({ jobId: 'job-1', status: 'done', placed: 100, total: 100 }));
    expect(hook.result.current.send).toEqual({ kind: 'done', jobId: 'job-1', placed: 100 });
    return hook;
  }

  it('undoes a finished build and follows it to undone', async () => {
    const hook = await done();

    await act(async () => {
      await hook.result.current.undoJob();
    });
    expect(calls('undo')).toEqual([['/api/agent/jobs/job-1/undo', { method: 'POST' }]]);
    const stream = MockEventSource.latest();
    expect(stream.url).toBe('/api/agent/jobs/job-1/events');

    // The replay is `undoing` — the route moved the job before answering — and the count
    // falls as blocks come back out.
    act(() => stream.emit({ jobId: 'job-1', status: 'undoing', placed: 100, total: 100 }));
    act(() => stream.emit({ jobId: 'job-1', status: 'undoing', placed: 40, total: 100 }));
    expect(hook.result.current.send).toEqual({ kind: 'undoing', jobId: 'job-1', placed: 40, total: 100 });

    act(() => stream.emit({ jobId: 'job-1', status: 'undone', placed: 0, total: 100 }));
    expect(hook.result.current.send).toEqual({ kind: 'undone', jobId: 'job-1' });
    expect(stream.closed).toBe(true);
  });

  it('keeps the build as done, with the reason, when the mod refuses the undo', async () => {
    const hook = await done();
    await act(async () => {
      await hook.result.current.undoJob();
    });
    const stream = MockEventSource.latest();

    act(() =>
      stream.emit({ jobId: 'job-1', status: 'done', error: 'could not undo: this world only remembers its most recent build' }),
    );
    expect(hook.result.current.send).toEqual({
      kind: 'done',
      jobId: 'job-1',
      placed: 100,
      undoError: 'could not undo: this world only remembers its most recent build',
    });
  });

  it('does not open a stream, or leave done, when the route refuses', async () => {
    const hook = await done();
    const streamsBefore = MockEventSource.instances.length;
    controlReplies.undo = { status: 409, body: { error: 'invalid_state', message: 'cannot undo a job that is cancelled' } };

    await act(async () => {
      await hook.result.current.undoJob();
    });
    expect(MockEventSource.instances.length).toBe(streamsBefore);
    expect(hook.result.current.send.kind).toBe('done');
    expect(hook.result.current.controlError).toBe('cannot undo a job that is cancelled');
  });

  it('reports a lost stream during an undo instead of hanging on undoing', async () => {
    const hook = await done();
    await act(async () => {
      await hook.result.current.undoJob();
    });
    const stream = MockEventSource.latest();
    act(() => stream.onerror?.());
    expect(hook.result.current.send).toMatchObject({ kind: 'error', message: 'lost the connection while undoing' });
  });

  it('does not let a slow undo request take over a send started while it was waiting', async () => {
    const hook = await done();
    let answerUndo: (value: unknown) => void = () => undefined;
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      String(url).endsWith('/undo')
        ? new Promise((resolve) => {
            answerUndo = resolve;
          })
        : base(url, init),
    );

    let undoing: Promise<void> = Promise.resolve();
    act(() => {
      undoing = hook.result.current.undoJob();
    });
    await act(async () => {
      await hook.result.current.sendToGame('agent-2', { name: 'Tower', grid, program: null });
    });
    const newStream = MockEventSource.latest();
    act(() => newStream.emit({ jobId: 'job-1', status: 'building', placed: 5, total: 50 }));

    await act(async () => {
      answerUndo({ ok: true, status: 200, json: async () => ({ ok: true }) });
      await undoing;
    });
    expect(newStream.closed).toBe(false);
    expect(MockEventSource.latest()).toBe(newStream);
    expect(hook.result.current.send).toMatchObject({ kind: 'progress', placed: 5, total: 50 });
  });

  it('follows an undo started in game while it was still watching the build', async () => {
    const { hook, stream } = await building();
    act(() => stream.emit({ jobId: 'job-1', status: 'undoing', placed: 20, total: 100 }));
    expect(hook.result.current.send.kind).toBe('undoing');
    act(() => stream.emit({ jobId: 'job-1', status: 'undone', placed: 0, total: 100 }));
    expect(hook.result.current.send).toEqual({ kind: 'undone', jobId: 'job-1' });
  });
});
