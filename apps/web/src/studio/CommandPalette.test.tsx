// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette, type Command } from './CommandPalette.js';

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const sampleCommands: Command[] = [
  {
    id: 'save-doc',
    label: 'Save document',
    hint: 'Save changes to cloud',
    category: 'File',
    run: vi.fn(),
  },
  {
    id: 'tool-erase',
    label: 'Tool: Erase',
    hint: 'Erase voxels',
    category: 'Tools',
    run: vi.fn(),
  },
  {
    id: 'view-front',
    label: 'View: Front',
    hint: 'Switch to front camera',
    category: 'View',
    run: vi.fn(),
  },
];

describe('CommandPalette empty state and keyboard behavior', () => {
  it('displays empty state with typed query and hint line when search yields no matches', () => {
    const onClose = vi.fn();
    render(<CommandPalette commands={sampleCommands} onClose={onClose} />);

    const input = screen.getByRole('combobox', { name: 'Search commands' });
    fireEvent.change(input, { target: { value: 'zzzz-no-match' } });

    // C1: Displays "No commands match \"<query>\"" and hint line
    expect(
      screen.getByText('No commands match "zzzz-no-match"'),
    ).not.toBeNull();
    expect(
      screen.getByText('Try a different word, or press Esc to close.'),
    ).not.toBeNull();
  });

  it('displays neutral empty state when commands list is empty and query is empty', () => {
    const onClose = vi.fn();
    render(<CommandPalette commands={[]} onClose={onClose} />);

    expect(screen.getByText('No commands available')).not.toBeNull();
    expect(screen.getByText('Press Esc to close.')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it('Arrow keys and Enter do nothing while empty state is displayed, and Esc closes the palette', () => {
    const onClose = vi.fn();
    const runA = vi.fn();
    const runB = vi.fn();
    const commands: Command[] = [
      { id: '1', label: 'Action One', run: runA },
      { id: '2', label: 'Action Two', run: runB },
    ];

    render(<CommandPalette commands={commands} onClose={onClose} />);

    const input = screen.getByRole('combobox', { name: 'Search commands' });
    fireEvent.change(input, { target: { value: 'nonexistent-query' } });

    // Verify empty state is showing
    expect(
      screen.getByText('No commands match "nonexistent-query"'),
    ).not.toBeNull();

    // C3: ArrowDown, ArrowUp, and Enter do nothing
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(runA).not.toHaveBeenCalled();
    expect(runB).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // C3: Esc closes the palette
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores the command list when search is cleared via button or backspace', () => {
    const onClose = vi.fn();
    render(<CommandPalette commands={sampleCommands} onClose={onClose} />);

    const input = screen.getByRole('combobox', {
      name: 'Search commands',
    }) as HTMLInputElement;

    // Initially displays all commands
    expect(screen.getByText('Save document')).not.toBeNull();
    expect(screen.getByText('Tool: Erase')).not.toBeNull();

    // Search for something with no matches
    fireEvent.change(input, { target: { value: 'random-unknown' } });
    expect(screen.queryByText('Save document')).toBeNull();
    expect(
      screen.getByText('No commands match "random-unknown"'),
    ).not.toBeNull();

    // C4: Clicking "Clear search" restores the list
    const clearBtn = screen.getByRole('button', { name: 'Clear search' });
    fireEvent.click(clearBtn);

    expect(input.value).toBe('');
    expect(screen.getByText('Save document')).not.toBeNull();
    expect(screen.getByText('Tool: Erase')).not.toBeNull();
    expect(screen.getByText('View: Front')).not.toBeNull();

    // Type no match again and clear via empty value
    fireEvent.change(input, { target: { value: 'another-miss' } });
    expect(screen.queryByText('Save document')).toBeNull();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('Save document')).not.toBeNull();
  });

  it('filters commands, navigates with arrow keys, and executes action on Enter', () => {
    const onClose = vi.fn();
    const runErase = vi.fn();
    const testCommands: Command[] = [
      { id: 'save', label: 'Save document', run: vi.fn() },
      { id: 'erase', label: 'Erase blocks', run: runErase },
      { id: 'erase-all', label: 'Erase all voxels', run: vi.fn() },
    ];

    render(<CommandPalette commands={testCommands} onClose={onClose} />);

    const input = screen.getByRole('combobox', { name: 'Search commands' });
    fireEvent.change(input, { target: { value: 'erase' } });

    // Filtered results
    expect(screen.queryByText('Save document')).toBeNull();
    const eraseOptions = screen.getAllByRole('option');
    expect(eraseOptions).toHaveLength(2);

    // Keyboard navigation
    expect(eraseOptions[0]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(eraseOptions[1]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(eraseOptions[0]?.getAttribute('aria-selected')).toBe('true');

    // Enter executes the selected command and closes palette
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(runErase).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('executes command action on click and closes the palette', () => {
    const onClose = vi.fn();
    const runSave = vi.fn();
    const testCommands: Command[] = [
      { id: 'save', label: 'Save document', run: runSave },
    ];

    render(<CommandPalette commands={testCommands} onClose={onClose} />);

    const option = screen.getByRole('option', { name: /Save document/i });
    fireEvent.click(option);

    expect(runSave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
