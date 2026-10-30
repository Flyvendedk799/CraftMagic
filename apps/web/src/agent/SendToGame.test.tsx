// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SendToGame } from './SendToGame.js';
import * as useAgentsModule from './useAgents.js';
import type { VoxelGrid } from '@craftmagic/core';

const dummyGrid: VoxelGrid = {
  size: { x: 2, y: 2, z: 2 },
  voxels: new Uint16Array(8),
  palette: ['minecraft:air', 'minecraft:stone'],
};

describe('SendToGame controls', () => {
  const mockPauseSend = vi.fn().mockResolvedValue(undefined);
  const mockResumeSend = vi.fn().mockResolvedValue(undefined);
  const mockUndoJob = vi.fn().mockResolvedValue(undefined);
  const mockCancelSend = vi.fn().mockResolvedValue(undefined);
  const mockResetSend = vi.fn();
  const mockSendToGame = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  function setupMockAgents(sendState: useAgentsModule.SendState, controlError: string | null = null) {
    vi.spyOn(useAgentsModule, 'useAgents').mockReturnValue({
      agents: [
        {
          id: 'agent-1',
          name: 'My World',
          mcVersion: '1.21.4',
          online: true,
          envType: 'integrated',
          lastSeenAt: new Date().toISOString(),
        },
      ],
      available: true,
      needsAccount: false,
      loading: false,
      pairCode: null,
      send: sendState,
      refresh: vi.fn().mockResolvedValue(undefined),
      createPairCode: vi.fn().mockResolvedValue(undefined),
      clearPairCode: vi.fn(),
      forget: vi.fn().mockResolvedValue(undefined),
      sendToGame: mockSendToGame,
      resetSend: mockResetSend,
      cancelJob: vi.fn().mockResolvedValue(undefined),
      cancelSend: mockCancelSend,
      pauseSend: mockPauseSend,
      resumeSend: mockResumeSend,
      undoJob: mockUndoJob,
      controlError,
    });
  }

  function renderPanel() {
    render(
      <MemoryRouter>
        <SendToGame name="Castle" grid={dummyGrid} program={null} />
      </MemoryRouter>,
    );
  }

  it('renders Pause button alongside Stop building during progress', () => {
    setupMockAgents({
      kind: 'progress',
      jobId: 'job-123',
      status: 'building',
      placed: 25,
      total: 100,
    });

    render(
      <MemoryRouter>
        <SendToGame name="Castle" grid={dummyGrid} program={null} />
      </MemoryRouter>,
    );

    const pauseBtn = screen.getByRole('button', { name: /^pause$/i });
    expect(pauseBtn).toBeTruthy();

    const stopBtn = screen.getByRole('button', { name: /stop building/i });
    expect(stopBtn).toBeTruthy();

    fireEvent.click(pauseBtn);
    expect(mockPauseSend).toHaveBeenCalledTimes(1);
  });

  it('renders Paused badge and Resume button when job is paused', () => {
    setupMockAgents({
      kind: 'paused',
      jobId: 'job-123',
      placed: 45,
      total: 100,
    });

    render(
      <MemoryRouter>
        <SendToGame name="Castle" grid={dummyGrid} program={null} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/⏸ Paused in game/i)).toBeTruthy();
    const resumeBtn = screen.getByRole('button', { name: /^resume$/i });
    expect(resumeBtn).toBeTruthy();

    fireEvent.click(resumeBtn);
    expect(mockResumeSend).toHaveBeenCalledTimes(1);
  });

  it('offers Pause only while blocks are going down', () => {
    for (const status of ['offered', 'previewing']) {
      setupMockAgents({ kind: 'progress', jobId: 'job-123', status, placed: 0, total: 100 });
      renderPanel();
      expect(screen.queryByRole('button', { name: /^pause$/i }), status).toBeNull();
      cleanup();
    }
  });

  it('asks before undoing, then calls undoJob with the finished job', () => {
    setupMockAgents({ kind: 'done', jobId: 'job-123', placed: 100 });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /undo in game/i }));
    // Nothing happens on the first click — it rewrites a build's worth of someone's world.
    expect(mockUndoJob).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /confirm undo/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^undo it$/i }));
    expect(mockUndoJob).toHaveBeenCalledWith('job-123');
  });

  it('does nothing when the undo is declined', () => {
    setupMockAgents({ kind: 'done', jobId: 'job-123', placed: 100 });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /undo in game/i }));
    fireEvent.click(screen.getByRole('button', { name: /keep it/i }));
    expect(mockUndoJob).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows why an undo was refused, beside a build that is still standing', () => {
    setupMockAgents({
      kind: 'done',
      jobId: 'job-123',
      placed: 100,
      undoError: 'could not undo: this world only remembers its most recent build',
    });
    renderPanel();

    expect(screen.getByRole('alert').textContent).toMatch(/only remembers its most recent build/);
    expect(screen.getByText(/Built — 100 blocks placed/)).toBeTruthy();
  });

  it('does not offer website undo for a stopped build, and says how to do it in game', () => {
    setupMockAgents({ kind: 'cancelled', jobId: 'job-123', placed: 30 });
    renderPanel();

    // The server refuses undo for anything but a finished build; a button here could only fail.
    expect(screen.queryByRole('button', { name: /undo in game/i })).toBeNull();
    expect(screen.getByText(/30 blocks were placed and stay placed/)).toBeTruthy();
    expect(screen.getByText('/craftmagic undo')).toBeTruthy();
  });

  it('shows undo progress as blocks put back, counting up', () => {
    // `placed` is what is still standing: 35 of 100 left means 65 put back.
    setupMockAgents({ kind: 'undoing', jobId: 'job-123', placed: 35, total: 100 });
    renderPanel();

    expect(screen.getByText(/Undoing… 65 \/ 100 put back/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /stop undoing/i }));
    expect(mockCancelSend).toHaveBeenCalledTimes(1);
  });

  it('reports a finished undo as a success, not an error', () => {
    setupMockAgents({ kind: 'undone', jobId: 'job-123' });
    renderPanel();

    expect(screen.getByText(/Undone — what was there before is back/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a refused control without hiding the build it was about', () => {
    setupMockAgents(
      { kind: 'progress', jobId: 'job-123', status: 'building', placed: 25, total: 100 },
      'That Minecraft world is not connected right now. Start it, then try again.',
    );
    renderPanel();

    expect(screen.getByRole('alert').textContent).toMatch(/not connected/);
    expect(screen.getByText(/Building… 25 \/ 100/)).toBeTruthy();
  });
});
