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

  function setupMockAgents(sendState: useAgentsModule.SendState) {
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
    });
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

  it('renders Undo in game button on done, confirms and calls undoJob', () => {
    setupMockAgents({
      kind: 'done',
      jobId: 'job-123',
      placed: 100,
    });

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <MemoryRouter>
        <SendToGame name="Castle" grid={dummyGrid} program={null} />
      </MemoryRouter>,
    );

    const undoBtn = screen.getByRole('button', { name: /undo in game/i });
    expect(undoBtn).toBeTruthy();

    fireEvent.click(undoBtn);
    expect(confirmSpy).toHaveBeenCalledWith('Tear down the placed blocks in Minecraft?');
    expect(mockUndoJob).toHaveBeenCalledWith('job-123');
  });

  it('renders Undo in game button on cancelled state', () => {
    setupMockAgents({
      kind: 'cancelled',
      jobId: 'job-123',
      placed: 30,
    });

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <MemoryRouter>
        <SendToGame name="Castle" grid={dummyGrid} program={null} />
      </MemoryRouter>,
    );

    const undoBtn = screen.getByRole('button', { name: /undo in game/i });
    expect(undoBtn).toBeTruthy();

    fireEvent.click(undoBtn);
    expect(confirmSpy).toHaveBeenCalledWith('Tear down the placed blocks in Minecraft?');
    expect(mockUndoJob).toHaveBeenCalledWith('job-123');
  });

  it('displays dismantling progress when undoing', () => {
    setupMockAgents({
      kind: 'undoing',
      jobId: 'job-123',
      placed: 35,
      total: 100,
    });

    render(
      <MemoryRouter>
        <SendToGame name="Castle" grid={dummyGrid} program={null} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Dismantling… 35 \/ 100/i)).toBeTruthy();
  });
});
