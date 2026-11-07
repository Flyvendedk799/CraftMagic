// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette, resolveCategory, type Command } from '../CommandPalette.js';
import { HistoryPanel } from './HistoryPanel.js';
import { WorkspaceModal } from './Modal.js';
import { recordChange, resetJournal, requestUndo, registerLive } from '../journal.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetJournal();
});

describe('CommandPalette category resolution and grouping', () => {
  it('categorizes commands accurately into Navigation, Tools, Actions, and Files', () => {
    const navCmd: Command = { id: 'mode-arch', label: 'Switch to Architecture mode', run: vi.fn() };
    const toolCmd: Command = { id: 'tool-brush', label: 'Tool: Brush', category: 'Tools', shortcut: 'B', run: vi.fn() };
    const actionCmd: Command = { id: 'file-save', label: 'Save build', run: vi.fn() };
    const fileCmd: Command = { id: 'file-open', label: 'Open Studio work', run: vi.fn() };

    expect(resolveCategory(navCmd)).toBe('Navigation');
    expect(resolveCategory(toolCmd)).toBe('Tools');
    expect(resolveCategory(actionCmd)).toBe('Actions');
    expect(resolveCategory(fileCmd)).toBe('Files');
  });

  it('maps real studio command IDs accurately into Navigation, Tools, Actions, or Files', () => {
    const realCommands: { id: string; label: string; expected: string }[] = [
      // Navigation
      { id: 'mode-arch', label: 'Switch to Architecture mode', expected: 'Navigation' },
      { id: 'mode-build', label: 'Switch to Build mode', expected: 'Navigation' },
      { id: 'mode-world', label: 'Switch to World Map mode', expected: 'Navigation' },
      { id: 'open-structure-plan', label: 'Open this build’s plan', expected: 'Navigation' },
      { id: 'go-library', label: 'Go to the library', expected: 'Navigation' },
      { id: 'go-dashboard', label: 'Go to the dashboard', expected: 'Navigation' },
      { id: 'go-mod', label: 'Go to the Minecraft mod page', expected: 'Navigation' },

      // Tools
      { id: 'tool-brush', label: 'Tool: Brush', expected: 'Tools' },
      { id: 'tool-select', label: 'Tool: Select', expected: 'Tools' },
      { id: 'tool-erase', label: 'Tool: Erase', expected: 'Tools' },
      { id: 'view-orbit', label: 'View: Orbit', expected: 'Tools' },

      // Files
      { id: 'file-open', label: 'Open Studio work', expected: 'Files' },
      { id: 'file-new', label: 'New document', expected: 'Files' },
      { id: 'build-cottage', label: 'Open build: Cottage', expected: 'Files' },
      { id: 'lib-open-abc', label: 'Open build: Castle', expected: 'Files' },
      { id: 'lib-place-abc', label: 'Place on map: Castle', expected: 'Files' },
      { id: 'lib-guide-abc', label: 'Open the build guide: Castle', expected: 'Files' },
      { id: 'world-draft', label: 'Open the map draft', expected: 'Files' },
      { id: 'map-m1', label: 'Open map: Valley', expected: 'Files' },

      // Actions
      { id: 'file-save', label: 'Save build', expected: 'Actions' },
      { id: 'file-export', label: 'Export current view', expected: 'Actions' },
      { id: 'style-rustic', label: 'Restyle: Rustic Oak', expected: 'Actions' },
      { id: 'style-off', label: 'Restyle: original materials', expected: 'Actions' },
      { id: 'guide', label: 'Open the build guide', expected: 'Actions' },
    ];

    for (const cmd of realCommands) {
      const resolved = resolveCategory({ id: cmd.id, label: cmd.label, run: vi.fn() });
      expect(resolved).toBe(cmd.expected);
    }
  });

  it('renders commands grouped by clean categories with subtle section headers and counts', () => {
    const commands: Command[] = [
      { id: 'mode-build', label: 'Switch to Build mode', run: vi.fn() },
      { id: 'tool-select', label: 'Tool: Select', category: 'Tools', shortcut: 'S', run: vi.fn() },
      { id: 'file-save', label: 'Save', run: vi.fn() },
      { id: 'file-open', label: 'Open files', run: vi.fn() },
    ];

    render(<CommandPalette commands={commands} onClose={vi.fn()} />);

    // Section headers
    const sectionHeaders = document.querySelectorAll('.command-search__section-header');
    expect(sectionHeaders.length).toBe(4);
    const titles = Array.from(sectionHeaders).map((h) =>
      h.querySelector('.command-search__section-title')?.textContent?.trim(),
    );
    expect(titles).toEqual(['Navigation', 'Tools', 'Actions', 'Files']);

    // Shortcut badge styling
    const kbd = screen.getByText('S');
    expect(kbd.tagName.toLowerCase()).toBe('kbd');
    expect(kbd.classList.contains('command-search__shortcut')).toBe(true);

    // Initial match count
    expect(screen.getByText('4 commands')).not.toBeNull();
  });

  it('supports search filtering, clear button, and count of matching commands', () => {
    const commands: Command[] = [
      { id: 'mode-arch', label: 'Switch to Architecture mode', hint: 'Floorplans', run: vi.fn() },
      { id: 'tool-brush', label: 'Tool: Brush', category: 'Tools', hint: 'Paint blocks', run: vi.fn() },
      { id: 'file-export', label: 'Export build', hint: 'Download file', run: vi.fn() },
    ];

    render(<CommandPalette commands={commands} onClose={vi.fn()} />);

    const input = screen.getByRole('combobox', { name: 'Search commands' });
    expect(screen.getByText('3 commands')).not.toBeNull();

    // Filter by 'brush'
    fireEvent.change(input, { target: { value: 'brush' } });
    expect(screen.getByText('1 command')).not.toBeNull();
    expect(screen.getByText('Tool: Brush')).not.toBeNull();
    expect(screen.queryByText('Switch to Architecture mode')).toBeNull();

    // Clear button should be present
    const clearBtn = screen.getByRole('button', { name: 'Clear search query' });
    expect(clearBtn).not.toBeNull();
    fireEvent.click(clearBtn);

    // After clearing, all commands return
    expect(screen.getByText('3 commands')).not.toBeNull();
    expect(screen.getByText('Switch to Architecture mode')).not.toBeNull();
  });

  it('supports smooth keyboard navigation: ArrowUp/ArrowDown, Enter to run, Escape to close', () => {
    const runArch = vi.fn();
    const runBrush = vi.fn();
    const onClose = vi.fn();
    const commands: Command[] = [
      { id: 'mode-arch', label: 'Switch to Architecture mode', run: runArch },
      { id: 'tool-brush', label: 'Tool: Brush', category: 'Tools', run: runBrush },
    ];

    render(<CommandPalette commands={commands} onClose={onClose} />);

    const input = screen.getByRole('combobox', { name: 'Search commands' });
    const items = screen.getAllByRole('option');

    // First item is initially active
    expect(items[0]!.getAttribute('aria-selected')).toBe('true');
    expect(items[1]!.getAttribute('aria-selected')).toBe('false');

    // ArrowDown moves active selection to second item
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(items[0]!.getAttribute('aria-selected')).toBe('false');
    expect(items[1]!.getAttribute('aria-selected')).toBe('true');

    // Enter executes active command
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(runBrush).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Escape closes palette
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('runs the top-ranked match on Enter even when it sits in a later category than a weaker match', () => {
    const runNav = vi.fn();
    const runTool = vi.fn();
    const commands: Command[] = [
      {
        id: 'mode-arch',
        label: 'Switch to Architecture mode',
        category: 'Navigation',
        hint: 'Use the brush tool to layout rooms',
        run: runNav,
      },
      {
        id: 'tool-brush',
        label: 'Tool: Brush',
        category: 'Tools',
        hint: 'Paint voxel blocks',
        run: runTool,
      },
    ];

    render(<CommandPalette commands={commands} onClose={vi.fn()} />);
    const input = screen.getByRole('combobox', { name: 'Search commands' });

    // Filter by 'brush'. 'Tool: Brush' has label match (higher rank) than 'Switch to Architecture mode' (hint match).
    fireEvent.change(input, { target: { value: 'brush' } });

    // First group shown should be Tools because top-ranked match is Tool: Brush
    const sectionTitles = Array.from(
      document.querySelectorAll('.command-search__section-title'),
    ).map((el) => el.textContent?.trim());
    expect(sectionTitles[0]).toBe('Tools');

    // Press Enter -> should execute runTool, not runNav
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runNav).not.toHaveBeenCalled();
  });

  it('displays informative empty state when search finds no matching command with quick reset', () => {
    const commands: Command[] = [
      { id: 'tool-brush', label: 'Tool: Brush', category: 'Tools', run: vi.fn() },
    ];

    render(<CommandPalette commands={commands} onClose={vi.fn()} />);
    const input = screen.getByRole('combobox', { name: 'Search commands' });

    fireEvent.change(input, { target: { value: 'nonexistentquery' } });
    expect(screen.getByText(/No matching actions for "nonexistentquery"/i)).not.toBeNull();

    const clearBtns = screen.getAllByRole('button', { name: /Clear search query/i });
    expect(clearBtns.length).toBe(2);

    // Clicking the empty state reset button clears query
    const emptyBtn = clearBtns[1]!;
    fireEvent.click(emptyBtn);
    expect(screen.getByText('Tool: Brush')).not.toBeNull();
  });
});

describe('Project HistoryPanel timeline', () => {
  it('renders empty state when no edits have been made in current session', () => {
    render(<HistoryPanel onUndo={vi.fn()} onRedo={vi.fn()} />);

    expect(screen.getByText('No edits in this session yet')).not.toBeNull();
    expect(screen.getByText('No edits')).not.toBeNull();

    const undoBtn = screen.getByRole('button', { name: 'Undo latest edit' });
    const redoBtn = screen.getByRole('button', { name: 'Redo' });

    expect(undoBtn.hasAttribute('disabled')).toBe(true);
    expect(redoBtn.hasAttribute('disabled')).toBe(true);
  });

  it('displays numbered timeline steps, action titles, time labels, and clear distinction for undone actions', () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();

    // Record two edits
    recordChange('build', 'lib:cottage', 'Box fill');
    recordChange('world', 'sample-world', 'Paint terrain');

    const { rerender } = render(<HistoryPanel onUndo={onUndo} onRedo={onRedo} />);

    // Quick Undo / Redo controls with shortcut hints
    const undoBtn = screen.getByRole('button', { name: 'Undo latest edit' });
    const redoBtn = screen.getByRole('button', { name: 'Redo' });

    expect(undoBtn.hasAttribute('disabled')).toBe(false);
    expect(redoBtn.hasAttribute('disabled')).toBe(true);
    expect(undoBtn.textContent).toContain('Ctrl Z');
    expect(redoBtn.textContent).toContain('Ctrl Shift Z');

    // Step counter
    expect(screen.getByText(/Step/)).not.toBeNull();

    // Check step numbers and action titles
    expect(screen.getByText('Box fill')).not.toBeNull();
    expect(screen.getByText('Paint terrain')).not.toBeNull();
    expect(screen.getByText('#1')).not.toBeNull();
    expect(screen.getByText('#2')).not.toBeNull();
    expect(screen.getByText(/Build · Library document/)).not.toBeNull();

    // Latest active item is Current
    const items = document.querySelectorAll('.workspace-history li');
    expect(items.length).toBe(2);

    // Item 2 (latest, top of list) is current
    const latestItem = items[0]!;
    expect(latestItem.getAttribute('data-current')).toBe('true');
    expect(latestItem.getAttribute('data-undone')).toBe('false');
    expect(latestItem.querySelector('.workspace-history__badge')?.textContent).toBe('Current');

    // Clicking Undo triggers onUndo
    fireEvent.click(undoBtn);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('handles undone actions with clear visual distinction and active Redo button', () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();

    registerLive({
      scope: 'build',
      docId: 'lib:build1',
      undo: () => true,
      redo: () => true,
    });
    recordChange('build', 'lib:build1', 'First edit');
    recordChange('build', 'lib:build1', 'Second edit');

    // Simulate undo: requestUndo from journal moves cursor back to 1
    requestUndo();

    render(<HistoryPanel onUndo={onUndo} onRedo={onRedo} />);

    const undoBtn = screen.getByRole('button', { name: 'Undo latest edit' });
    const redoBtn = screen.getByRole('button', { name: 'Redo' });

    expect(undoBtn.hasAttribute('disabled')).toBe(false);
    expect(redoBtn.hasAttribute('disabled')).toBe(false);

    // Frame 2 is undone
    const items = document.querySelectorAll('.workspace-history li');
    expect(items[0]!.getAttribute('data-undone')).toBe('true');
    expect(items[0]!.querySelector('.workspace-history__badge')?.textContent).toBe('Undone');

    // Frame 1 is current
    expect(items[1]!.getAttribute('data-undone')).toBe('false');
    expect(items[1]!.getAttribute('data-current')).toBe('true');
    expect(items[1]!.querySelector('.workspace-history__badge')?.textContent).toBe('Current');

    // Clicking Redo triggers onRedo
    fireEvent.click(redoBtn);
    expect(onRedo).toHaveBeenCalledTimes(1);
  });
});

describe('WorkspaceModal accessibility, focus management, and layout', () => {
  it('renders modal shell with eyebrow badge, header, title, and close button', () => {
    const onClose = vi.fn();
    render(
      <WorkspaceModal title="Project history" eyebrow="SESSION TIMELINE" onClose={onClose}>
        <div data-testid="modal-content">Content</div>
      </WorkspaceModal>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Project history' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    // Eyebrow badge
    const eyebrow = screen.getByText('SESSION TIMELINE');
    expect(eyebrow.classList.contains('workspace-modal__eyebrow')).toBe(true);

    // Title
    const title = screen.getByText('Project history');
    expect(title.tagName.toLowerCase()).toBe('h2');

    // Content
    expect(screen.getByTestId('modal-content')).not.toBeNull();

    // Close button
    const closeBtn = screen.getByRole('button', { name: 'Close Project history' });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismisses when clicking outside panel on the backdrop', () => {
    const onClose = vi.fn();
    render(
      <WorkspaceModal title="Settings" onClose={onClose}>
        <div>Settings content</div>
      </WorkspaceModal>,
    );

    const backdrop = document.querySelector('.workspace-modal')!;
    fireEvent.pointerDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps focus inside modal and dismisses on Escape key', () => {
    const onClose = vi.fn();
    const trigger = document.createElement('button');
    trigger.textContent = 'Open modal';
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(
      <WorkspaceModal title="Test Modal" onClose={onClose}>
        <div>
          <button id="btn1">Button 1</button>
          <button id="btn2">Button 2</button>
        </div>
      </WorkspaceModal>,
    );

    // Escape closes modal
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    // Focus restored to trigger on unmount
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('traps Tab key navigation within modal focusable elements and skips hidden elements', () => {
    // Stub getClientRects so that elements with non-empty client rects are recognized as visible
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
      if (this.id === 'hidden-by-css') {
        return [] as unknown as DOMRectList;
      }
      return [{ width: 100, height: 20 }] as unknown as DOMRectList;
    });

    const onClose = vi.fn();
    render(
      <WorkspaceModal title="Focus Trap Modal" onClose={onClose}>
        <div>
          <button id="first-btn">First</button>
          <button id="hidden-by-css">Hidden via CSS rule (0 rects)</button>
          <button id="hidden-by-attr" hidden>Hidden via hidden attribute</button>
          <button id="second-btn">Second</button>
        </div>
      </WorkspaceModal>,
    );

    const closeBtn = screen.getByRole('button', { name: 'Close Focus Trap Modal' });
    const secondBtn = screen.getByRole('button', { name: 'Second' });

    // Focus on second (last element) and press Tab -> should wrap to closeBtn (first element)
    secondBtn.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: false });
    expect(document.activeElement).toBe(closeBtn);

    // Focus on closeBtn (first element) and press Shift+Tab -> should wrap to secondBtn (last visible element)
    closeBtn.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(secondBtn);
  });
});
