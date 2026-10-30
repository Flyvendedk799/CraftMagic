// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ModPage, CopyCommand } from './ModPage.js';
import * as useAgentsModule from '../agent/useAgents.js';

describe('CopyCommand component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('copies command to clipboard and shows visual feedback for 2s', async () => {
    render(<CopyCommand command="/craftmagic pause" />);

    expect(screen.getByText('/craftmagic pause')).toBeTruthy();
    const btn = screen.getByRole('button', { name: /copy command \/craftmagic pause/i });
    expect(btn.textContent).toBe('Copy');

    await act(async () => {
      fireEvent.click(btn);
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/craftmagic pause');
    expect(btn.textContent).toBe('Copied');
    expect(btn.classList.contains('modpage__copy-btn--copied')).toBe(true);

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(btn.textContent).toBe('Copy');
    expect(btn.classList.contains('modpage__copy-btn--copied')).toBe(false);
  });

  it('restarts the two seconds on a second copy instead of cutting it short', async () => {
    render(<CopyCommand command="/wand" />);
    const btn = screen.getByRole('button', { name: /copy command \/wand/i });

    await act(async () => {
      fireEvent.click(btn);
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    await act(async () => {
      fireEvent.click(btn);
    });
    // The first copy's timer would have fired here.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(btn.textContent).toBe('Copied');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(btn.textContent).toBe('Copy');
  });
});

describe('ModPage component', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        file: '/mod/craftmagic-1.0.jar',
        version: '1.0.0',
        minecraft: '1.21.4',
        loader: 'fabric',
        loaderVersion: '0.16.9',
        java: 21,
        bytes: 1048576,
        builtAt: '2026-10-29T00:00:00Z',
      }),
    }) as never;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function mockAgentsState(overrides: Partial<ReturnType<typeof useAgentsModule.useAgents>> = {}) {
    vi.spyOn(useAgentsModule, 'useAgents').mockReturnValue({
      agents: [],
      available: true,
      needsAccount: false,
      loading: false,
      pairCode: null,
      send: { kind: 'idle' },
      refresh: vi.fn().mockResolvedValue(undefined),
      createPairCode: vi.fn().mockResolvedValue(undefined),
      clearPairCode: vi.fn(),
      forget: vi.fn().mockResolvedValue(undefined),
      sendToGame: vi.fn().mockResolvedValue(undefined),
      resetSend: vi.fn(),
      cancelJob: vi.fn().mockResolvedValue(undefined),
      cancelSend: vi.fn().mockResolvedValue(undefined),
      pauseSend: vi.fn().mockResolvedValue(undefined),
      resumeSend: vi.fn().mockResolvedValue(undefined),
      undoJob: vi.fn().mockResolvedValue(undefined),
      controlError: null,
      ...overrides,
    });
  }

  it('renders Live Connection Status Card when a world is online', () => {
    mockAgentsState({
      agents: [
        {
          id: 'agent-1',
          name: 'Survival SMP',
          mcVersion: '1.21.4',
          online: true,
          envType: 'dedicated',
          lastSeenAt: new Date().toISOString(),
        },
      ],
    });

    render(
      <MemoryRouter>
        <ModPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Connected to Survival SMP/i)).toBeTruthy();
    expect(screen.getByText(/Minecraft 1\.21\.4 is connected and ready/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Send to Game/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open Studio/i })).toBeTruthy();
  });

  it('renders status guidance when world is offline', () => {
    mockAgentsState({
      agents: [
        {
          id: 'agent-1',
          name: 'Creative Build World',
          mcVersion: '1.21.4',
          online: false,
          envType: 'integrated',
          lastSeenAt: new Date().toISOString(),
        },
      ],
    });

    render(
      <MemoryRouter>
        <ModPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Creative Build World is offline/i)).toBeTruthy();
    expect(screen.getByText(/Launch Minecraft and load your world to reconnect/i)).toBeTruthy();
  });

  it('renders pairing guidance when no world is paired', () => {
    mockAgentsState({
      agents: [],
    });

    render(
      <MemoryRouter>
        <ModPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/No Minecraft world paired/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Pair Minecraft/i })).toBeTruthy();
  });

  it('supports Tabbed Setup Guides with Singleplayer, Dedicated Server, and LAN', () => {
    mockAgentsState();

    render(
      <MemoryRouter>
        <ModPage />
      </MemoryRouter>,
    );

    const singleplayerTab = screen.getByRole('tab', { name: /Singleplayer \(Solo\)/i });
    const dedicatedTab = screen.getByRole('tab', { name: /Dedicated Server \(Multiplayer\)/i });
    const lanTab = screen.getByRole('tab', { name: /LAN \/ Friends/i });

    expect(singleplayerTab).toBeTruthy();
    expect(dedicatedTab).toBeTruthy();
    expect(lanTab).toBeTruthy();

    // Singleplayer tab is active by default
    expect(singleplayerTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/Cheats and operator permissions are/i)).toBeTruthy();
    expect(screen.getByText(/not required/i)).toBeTruthy();

    // Switch to Dedicated Server tab
    fireEvent.click(dedicatedTab);
    expect(dedicatedTab.getAttribute('aria-selected')).toBe('true');
    expect(singleplayerTab.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByText(/Vanilla clients can connect without the mod/i)).toBeTruthy();
    expect(screen.getByText(/OP level 2/i)).toBeTruthy();
    expect(screen.getByText(/No open incoming ports needed/i)).toBeTruthy();

    // Switch to LAN / Friends tab
    fireEvent.click(lanTab);
    expect(lanTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/Host owns the pairing/i)).toBeTruthy();
    expect(screen.getByText(/Guests need OP permissions from the host/i)).toBeTruthy();
  });

  it('moves between guide tabs with the arrow keys, Home and End', () => {
    mockAgentsState();
    render(
      <MemoryRouter>
        <ModPage />
      </MemoryRouter>,
    );

    const tablist = screen.getByRole('tablist');
    const tab = (name: RegExp) => screen.getByRole('tab', { name });

    // Only the selected tab is in the Tab order.
    expect(tab(/Singleplayer/).getAttribute('tabindex')).toBe('0');
    expect(tab(/Dedicated/).getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(tab(/Dedicated/).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab(/Dedicated/));

    fireEvent.keyDown(tablist, { key: 'End' });
    expect(tab(/LAN/).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(tablist, { key: 'ArrowRight' }); // wraps
    expect(tab(/Singleplayer/).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(tablist, { key: 'ArrowLeft' }); // wraps back
    expect(tab(/LAN/).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(tab(/Singleplayer/).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab(/Singleplayer/));
  });

  it('keeps asking whether the world is online while the page is open', () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn().mockResolvedValue(undefined);
      mockAgentsState({ refresh });
      const view = render(
        <MemoryRouter>
          <ModPage />
        </MemoryRouter>,
      );

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(refresh).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(refresh).toHaveBeenCalledTimes(2);

      view.unmount();
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll for a signed-out visitor, who has no worlds to watch', () => {
    vi.useFakeTimers();
    try {
      const refresh = vi.fn().mockResolvedValue(undefined);
      mockAgentsState({ refresh, needsAccount: true });
      render(
        <MemoryRouter>
          <ModPage />
        </MemoryRouter>,
      );
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders interactive click-to-copy for commands', () => {
    mockAgentsState();

    render(
      <MemoryRouter>
        <ModPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('/craftmagic pause')).toBeTruthy();
    expect(screen.getByText('/craftmagic resume')).toBeTruthy();
    expect(screen.getByText('/craftmagic undo')).toBeTruthy();
    expect(screen.getByText('/craftmagic offset <dy>')).toBeTruthy();

    const copyBtns = screen.getAllByRole('button', { name: /copy command/i });
    expect(copyBtns.length).toBeGreaterThan(5);
  });
});
