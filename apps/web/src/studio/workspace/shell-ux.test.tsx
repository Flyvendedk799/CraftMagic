// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceFrame } from './WorkspaceFrame.js';
import { ResizeHandle } from './ResizeHandle.js';
import { DockProvider, WorkspaceDock } from './Docks.js';
import { defaultLayout, sectionDock } from './layout.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const defaultFrameProps = {
  href: '/studio?build=cottage',
  title: 'Oak Cottage',
  presence: null,
  workbench: null,
};

describe('Workspace shell UX and navigation', () => {
  it('renders mode switcher with accessible names and strong labels for all three modes', () => {
    const onMode = vi.fn();
    render(
      <MemoryRouter>
        <WorkspaceFrame
          {...defaultFrameProps}
          mode="build"
          onMode={onMode}
          onCommands={vi.fn()}
          onFiles={vi.fn()}
          onOpen={vi.fn()}
          signedIn={false}
          canUndo={false}
          canRedo={false}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
        >
          <div>Canvas content</div>
        </WorkspaceFrame>
      </MemoryRouter>,
    );

    const switchNav = screen.getByRole('navigation', {
      name: 'Studio workspaces',
    });
    expect(switchNav.classList.contains('studio__switch')).toBe(true);

    const buildBtn = screen.getByRole('button', { name: 'Build' });
    const planBtn = screen.getByRole('button', { name: 'Plan' });
    const worldBtn = screen.getByRole('button', { name: 'World' });

    expect(buildBtn.getAttribute('aria-pressed')).toBe('true');
    expect(planBtn.getAttribute('aria-pressed')).toBe('false');
    expect(worldBtn.getAttribute('aria-pressed')).toBe('false');

    expect(buildBtn.querySelector('strong')?.textContent?.trim()).toBe('Build');
    expect(planBtn.querySelector('strong')?.textContent?.trim()).toBe(
      'Architecture',
    );
    expect(worldBtn.querySelector('strong')?.textContent?.trim()).toBe('World');
  });

  it('supports keyboard navigation across mode buttons with arrow keys, Home, and End', () => {
    const onMode = vi.fn();
    render(
      <MemoryRouter>
        <WorkspaceFrame
          {...defaultFrameProps}
          mode="build"
          onMode={onMode}
          onCommands={vi.fn()}
          onFiles={vi.fn()}
          onOpen={vi.fn()}
          signedIn={false}
          canUndo={false}
          canRedo={false}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
        >
          <div>Canvas</div>
        </WorkspaceFrame>
      </MemoryRouter>,
    );

    const buildBtn = screen.getByRole('button', { name: 'Build' });

    // ArrowRight moves from build (index 0) to arch (index 1)
    fireEvent.keyDown(buildBtn, { key: 'ArrowRight' });
    expect(onMode).toHaveBeenCalledWith('arch');

    // ArrowLeft wraps from build (index 0) to world (index 2)
    fireEvent.keyDown(buildBtn, { key: 'ArrowLeft' });
    expect(onMode).toHaveBeenCalledWith('world');

    // End key moves to last mode (world)
    fireEvent.keyDown(buildBtn, { key: 'End' });
    expect(onMode).toHaveBeenCalledWith('world');

    // Home key moves to first mode (build)
    fireEvent.keyDown(buildBtn, { key: 'Home' });
    expect(onMode).toHaveBeenCalledWith('build');
  });

  it('displays document breadcrumb and status state indicator', () => {
    render(
      <MemoryRouter>
        <WorkspaceFrame
          {...defaultFrameProps}
          mode="build"
          onMode={vi.fn()}
          onCommands={vi.fn()}
          onFiles={vi.fn()}
          onOpen={vi.fn()}
          signedIn={false}
          canUndo={true}
          canRedo={false}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
        >
          <div>Canvas</div>
        </WorkspaceFrame>
      </MemoryRouter>,
    );

    const breadcrumb = document.querySelector('.workspace-breadcrumb');
    expect(breadcrumb).not.toBeNull();
    expect(breadcrumb?.classList.contains('studio__document')).toBe(true);

    const stateIndicator = document.querySelector('.studio__document-state');
    expect(stateIndicator).not.toBeNull();
    expect(stateIndicator?.textContent).toContain('Ready to work');

    const undoBtn = screen.getByRole('button', { name: 'Undo' });
    expect(undoBtn.hasAttribute('disabled')).toBe(false);
    expect(undoBtn.getAttribute('title')).toContain('Ctrl Z');

    const redoBtn = screen.getByRole('button', { name: 'Redo' });
    expect(redoBtn.hasAttribute('disabled')).toBe(true);

    const historyBtn = screen.getByRole('button', { name: 'Project history' });
    expect(historyBtn).not.toBeNull();

    const focusBtn = screen.getByRole('button', { name: 'Focus mode' });
    expect(focusBtn.getAttribute('title')).toContain('F8');
  });

  it('renders split view canvas layout dropdown only in non-build modes', () => {
    const { unmount } = render(
      <MemoryRouter>
        <WorkspaceFrame
          {...defaultFrameProps}
          mode="build"
          onMode={vi.fn()}
          onCommands={vi.fn()}
          onFiles={vi.fn()}
          onOpen={vi.fn()}
          signedIn={false}
          canUndo={false}
          canRedo={false}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
        >
          <div>Canvas</div>
        </WorkspaceFrame>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('combobox', { name: 'Canvas layout' })).toBeNull();
    unmount();

    render(
      <MemoryRouter>
        <WorkspaceFrame
          {...defaultFrameProps}
          mode="arch"
          onMode={vi.fn()}
          onCommands={vi.fn()}
          onFiles={vi.fn()}
          onOpen={vi.fn()}
          signedIn={false}
          canUndo={false}
          canRedo={false}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
        >
          <div>Canvas</div>
        </WorkspaceFrame>
      </MemoryRouter>,
    );

    const select = screen.getByRole('combobox', { name: 'Canvas layout' });
    expect(select).not.toBeNull();
  });

  it('provides accessible collapse and keyboard tabs in WorkspaceDock', () => {
    const layout = defaultLayout();
    const onTab = vi.fn();
    const onClose = vi.fn();

    render(
      <DockProvider reveal={vi.fn()}>
        <WorkspaceDock
          side="left"
          mode="build"
          layout={layout}
          onTab={onTab}
          onClose={onClose}
        />
      </DockProvider>,
    );

    const collapseBtn = screen.getByRole('button', {
      name: 'Hide left panel',
    });
    expect(collapseBtn.getAttribute('aria-expanded')).toBe('true');
    expect(collapseBtn.getAttribute('title')).toContain('Ctrl \\');

    fireEvent.click(collapseBtn);
    expect(onClose).toHaveBeenCalledTimes(1);

    const toolsTab = screen.getByRole('tab', { name: 'Tools' });
    fireEvent.keyDown(toolsTab, { key: 'ArrowRight' });
    expect(onTab).toHaveBeenCalledWith('shape');
  });

  it('supports rich keyboard stepping and double-click reset on ResizeHandle', () => {
    const onChange = vi.fn();
    render(<ResizeHandle side="left" width={272} onChange={onChange} />);

    const resizer = screen.getByRole('separator', {
      name: 'Resize left panel',
    });
    expect(resizer.getAttribute('aria-valuenow')).toBe('272');

    // Arrow keys standard step (8px)
    fireEvent.keyDown(resizer, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith(280);

    // Shift arrow step (40px)
    fireEvent.keyDown(resizer, { key: 'ArrowRight', shiftKey: true });
    expect(onChange).toHaveBeenCalledWith(312);

    // PageUp/PageDown step (40px)
    fireEvent.keyDown(resizer, { key: 'PageUp' });
    expect(onChange).toHaveBeenCalledWith(312);

    // Home / End constraints
    fireEvent.keyDown(resizer, { key: 'Home' });
    expect(onChange).toHaveBeenCalledWith(224);

    fireEvent.keyDown(resizer, { key: 'End' });
    expect(onChange).toHaveBeenCalledWith(480);

    // Double-click resets to default 272
    fireEvent.doubleClick(resizer);
    expect(onChange).toHaveBeenCalledWith(272);
  });

  it('keeps panel and mode-switch keys away from the window-level editor shortcuts', () => {
    // Build and Architecture listen on `window` for arrows and Page Up/Down and nudge the
    // selection; a key the shell has already used must not also edit the document.
    const seen: string[] = [];
    const onWindowKey = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener('keydown', onWindowKey);

    try {
      const { unmount } = render(<ResizeHandle side="left" width={272} onChange={vi.fn()} />);
      const resizer = screen.getByRole('separator', { name: 'Resize left panel' });
      for (const key of ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']) {
        fireEvent.keyDown(resizer, { key });
      }
      unmount();

      const { unmount: unmountDock } = render(
        <DockProvider reveal={vi.fn()}>
          <WorkspaceDock side="left" mode="build" layout={defaultLayout()} onTab={vi.fn()} onClose={vi.fn()} />
        </DockProvider>,
      );
      const tab = screen.getByRole('tab', { name: 'Tools' });
      for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']) {
        fireEvent.keyDown(tab, { key });
      }
      unmountDock();

      render(
        <MemoryRouter>
          <WorkspaceFrame
            {...defaultFrameProps}
            mode="build"
            onMode={vi.fn()}
            onCommands={vi.fn()}
            onFiles={vi.fn()}
            onOpen={vi.fn()}
            signedIn={false}
            canUndo={false}
            canRedo={false}
            onUndo={vi.fn()}
            onRedo={vi.fn()}
          >
            <div>Canvas</div>
          </WorkspaceFrame>
        </MemoryRouter>,
      );
      const modeButton = screen.getByRole('button', { name: 'Build' });
      for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']) {
        fireEvent.keyDown(modeButton, { key });
      }

      expect(seen).toEqual([]);

      // Keys the shell does not claim still reach the editors.
      fireEvent.keyDown(modeButton, { key: 'PageUp' });
      expect(seen).toEqual(['PageUp']);
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('routes dock slot identifiers correctly across build, arch, and world modes', () => {
    // Left dock slots
    expect(sectionDock('tools')).toEqual({ side: 'left', tab: 'tools' });
    expect(sectionDock('terrain')).toEqual({ side: 'left', tab: 'tools' });
    expect(sectionDock('shape')).toEqual({ side: 'left', tab: 'shape' });
    expect(sectionDock('storeys')).toEqual({ side: 'left', tab: 'shape' });
    expect(sectionDock('assets')).toEqual({ side: 'left', tab: 'assets' });
    expect(sectionDock('blocks')).toEqual({ side: 'left', tab: 'assets' });
    expect(sectionDock('rooms')).toEqual({ side: 'left', tab: 'assets' });
    expect(sectionDock('shelf')).toEqual({ side: 'left', tab: 'assets' });

    // Right dock slots
    expect(sectionDock('inspect')).toEqual({ side: 'right', tab: 'inspect' });
    expect(sectionDock('selection')).toEqual({ side: 'right', tab: 'inspect' });
    expect(sectionDock('checks')).toEqual({ side: 'right', tab: 'inspect' });
    expect(sectionDock('settings')).toEqual({ side: 'right', tab: 'world' });
    expect(sectionDock('deliver')).toEqual({ side: 'right', tab: 'deliver' });
  });
});
