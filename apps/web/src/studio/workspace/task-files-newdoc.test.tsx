// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioFiles, type StudioFilesProps } from '../StudioFiles.js';
import { NewDocument } from './NewDocument.js';
import type { LibraryBuild } from '../../library/library.js';
import type { SavedWorld } from '../../world/api.js';
import type { SavedPlan } from '../../architecture/storage.js';
import { createPlan } from '../../architecture/plan.js';

class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  Object.defineProperty(window, 'IntersectionObserver', {
    writable: true,
    configurable: true,
    value: MockIntersectionObserver,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const sampleBuilds: LibraryBuild[] = [
  {
    id: 'b1',
    name: 'Medieval Castle',
    sizeX: 64,
    sizeY: 64,
    sizeZ: 64,
    blockCount: 15420,
    kind: 'structure',
    hasProgram: true,
    hasPlan: true,
    detached: false,
    createdAt: '2026-10-01T12:00:00Z',
    updatedAt: '2026-10-15T14:30:00Z',
  },
];

const sampleMaps: SavedWorld[] = [
  {
    id: 'm1',
    name: 'Nordic Valley',
    sizeX: 512,
    sizeZ: 512,
    placements: 3,
    updatedAt: '2026-10-20T10:00:00Z',
    storage: 'account',
  },
  {
    id: 'm2',
    name: 'Desert Oasis',
    sizeX: 256,
    sizeZ: 256,
    placements: 1,
    updatedAt: '2026-10-25T16:00:00Z',
    storage: 'device',
  },
];

const samplePlans: SavedPlan[] = [
  {
    id: 'p1',
    name: 'Lakeside Cottage',
    updatedAt: '2026-10-18T09:00:00Z',
    plan: createPlan({ name: 'Lakeside Cottage' }),
  },
];

const sampleLocalBuilds = [
  { id: 'gen:1', name: 'Oak Watchtower' },
];

function renderFiles(overrides: Partial<StudioFilesProps> = {}) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const onRename = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn().mockResolvedValue(undefined);
  const onRetry = vi.fn();

  const props: StudioFilesProps = {
    builds: sampleBuilds,
    maps: sampleMaps,
    plans: samplePlans,
    localBuilds: sampleLocalBuilds,
    loading: false,
    signedIn: true,
    onOpen,
    onClose,
    onRename,
    onDelete,
    onRetry,
    ...overrides,
  };

  const utils = render(<StudioFiles {...props} />);
  return { ...utils, onOpen, onClose, onRename, onDelete, onRetry };
}

describe('StudioFiles Manager', () => {
  it('renders search input, filter chips, storage tabs, and file cards with metadata and badges', () => {
    renderFiles();

    // Search input
    const searchInput = screen.getByLabelText('Find Studio work');
    expect(searchInput).not.toBeNull();

    // Kind filter pills
    expect(screen.getByRole('button', { name: /all work/i })).not.toBeNull();
    expect(screen.getByRole('button', { name: /builds/i })).not.toBeNull();
    expect(screen.getByRole('button', { name: /floorplans/i })).not.toBeNull();
    expect(screen.getByRole('button', { name: /maps/i })).not.toBeNull();

    // Storage tabs
    expect(screen.getByRole('tab', { name: /all storage/i })).not.toBeNull();
    expect(screen.getByRole('tab', { name: /device/i })).not.toBeNull();
    expect(screen.getByRole('tab', { name: /account/i })).not.toBeNull();

    // File items rendered
    expect(screen.getByText('Medieval Castle')).not.toBeNull();
    expect(screen.getByText('Nordic Valley')).not.toBeNull();
    expect(screen.getByText('Desert Oasis')).not.toBeNull();
    expect(screen.getByText('Lakeside Cottage')).not.toBeNull();
    expect(screen.getByText('Oak Watchtower')).not.toBeNull();

    // Storage badges
    const accountBadges = screen.getAllByText('Account');
    expect(accountBadges.length).toBeGreaterThan(0);
    const deviceBadges = screen.getAllByText('Device');
    expect(deviceBadges.length).toBeGreaterThan(0);

    // Linked plan badge for Medieval Castle
    expect(screen.getByText(/linked plan/i)).not.toBeNull();
  });

  it('switches between grid and list views', () => {
    renderFiles();

    const resultsList = screen.getByRole('list', { name: 'Studio files' });
    expect(resultsList.className).toContain('workspace-files__results--grid');

    const listBtn = screen.getByRole('button', { name: 'List layout' });
    fireEvent.click(listBtn);
    expect(resultsList.className).toContain('workspace-files__results--list');

    const gridBtn = screen.getByRole('button', { name: 'Grid layout' });
    fireEvent.click(gridBtn);
    expect(resultsList.className).toContain('workspace-files__results--grid');
  });

  it('filters files by search query and clears search smoothly', () => {
    renderFiles();

    const searchInput = screen.getByLabelText('Find Studio work');
    fireEvent.change(searchInput, { target: { value: 'Nordic' } });

    expect(screen.getByText('Nordic Valley')).not.toBeNull();
    expect(screen.queryByText('Medieval Castle')).toBeNull();
    expect(screen.queryByText('Lakeside Cottage')).toBeNull();

    // Clear search button appears and works
    const clearBtn = screen.getByLabelText('Clear search');
    fireEvent.click(clearBtn);

    expect(screen.getByText('Medieval Castle')).not.toBeNull();
    expect(screen.getByText('Nordic Valley')).not.toBeNull();
  });

  it('filters files by kind pills and storage tabs', () => {
    renderFiles();

    // Filter by Maps
    const mapsPill = screen.getByRole('button', { name: /maps/i });
    fireEvent.click(mapsPill);

    expect(screen.getByText('Nordic Valley')).not.toBeNull();
    expect(screen.getByText('Desert Oasis')).not.toBeNull();
    expect(screen.queryByText('Medieval Castle')).toBeNull();
    expect(screen.queryByText('Lakeside Cottage')).toBeNull();

    // Further filter by Device storage tab
    const deviceTab = screen.getByRole('tab', { name: /device/i });
    fireEvent.click(deviceTab);

    expect(screen.getByText('Desert Oasis')).not.toBeNull();
    expect(screen.queryByText('Nordic Valley')).toBeNull();
  });

  it('handles inline rename with validation and save', async () => {
    const { onRename } = renderFiles();

    // Hover action rename button for Medieval Castle
    const renameButtons = screen.getAllByRole('button', { name: /rename/i });
    const castleRenameBtn = renameButtons.find((btn) =>
      btn.getAttribute('aria-label')?.includes('Medieval Castle'),
    );
    expect(castleRenameBtn).toBeDefined();

    fireEvent.click(castleRenameBtn!);

    // Inline input is displayed
    const inlineInput = screen.getByLabelText('Enter new name for Medieval Castle');
    expect(inlineInput).not.toBeNull();

    fireEvent.change(inlineInput, { target: { value: 'Grand Citadel' } });

    const saveBtn = screen.getByLabelText('Save name');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(onRename).toHaveBeenCalledWith('library', 'b1', 'Grand Citadel');
    });
  });

  it('shows clear delete confirmation dialog and calls onDelete only after confirmation', async () => {
    const { onDelete } = renderFiles();

    const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
    const oasisDeleteBtn = deleteButtons.find((btn) =>
      btn.getAttribute('aria-label')?.includes('Desert Oasis'),
    );
    expect(oasisDeleteBtn).toBeDefined();

    fireEvent.click(oasisDeleteBtn!);

    // Confirmation dialog is displayed
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).not.toBeNull();
    expect(screen.getByText(/delete “desert oasis”\?/i)).not.toBeNull();
    expect(screen.getByText(/this action cannot be undone/i)).not.toBeNull();

    // Confirm deletion
    const confirmBtn = screen.getByRole('button', { name: 'Delete file' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith('map', 'm2');
    });
  });

  it('renders loading skeleton state and error banner with retry option', () => {
    const { rerender } = render(
      <StudioFiles
        builds={[]}
        maps={[]}
        loading={true}
        signedIn={false}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole('status', { name: 'Loading your work' })).not.toBeNull();
    expect(screen.getByText(/loading your files…/i)).not.toBeNull();

    const onRetry = vi.fn();
    rerender(
      <StudioFiles
        builds={[]}
        maps={[]}
        loading={false}
        signedIn={false}
        error="Network timeout reaching storage"
        onRetry={onRetry}
        onOpen={vi.fn()}
        onClose={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).not.toBeNull();
    expect(screen.getByText('Network timeout reaching storage')).not.toBeNull();

    const retryBtn = screen.getByRole('button', { name: /retry loading/i });
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders helpful empty state with new document action', () => {
    const newDocListener = vi.fn();
    window.addEventListener('studio:new-document', newDocListener);

    renderFiles({
      builds: [],
      maps: [],
      plans: [],
      localBuilds: [],
    });

    expect(screen.getByText('No files found')).not.toBeNull();
    const createBtn = screen.getByRole('button', { name: /create new document/i });
    fireEvent.click(createBtn);

    expect(newDocListener).toHaveBeenCalledTimes(1);
    window.removeEventListener('studio:new-document', newDocListener);
  });
});

describe('NewDocument Creation Flow', () => {
  it('renders mode cards for Voxel Build, Floorplan, and World Map with descriptions', () => {
    render(
      <NewDocument
        initial="build"
        signedIn={false}
        onClose={vi.fn()}
        onBeforeCreate={() => true}
        onCreated={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /voxel build/i })).not.toBeNull();
    expect(screen.getByRole('button', { name: /floorplan/i })).not.toBeNull();
    expect(screen.getByRole('button', { name: /world map/i })).not.toBeNull();

    expect(screen.getByText(/shape blocks directly/i)).not.toBeNull();
  });

  it('updates working volume preview card in Voxel Build mode', () => {
    render(
      <NewDocument
        initial="build"
        signedIn={false}
        onClose={vi.fn()}
        onBeforeCreate={() => true}
        onCreated={vi.fn()}
      />,
    );

    const sizeSelect = screen.getByLabelText('Build volume');
    expect(screen.getByText('32 × 32 × 32')).not.toBeNull();

    fireEvent.change(sizeSelect, { target: { value: '64' } });
    expect(screen.getByText('64 × 64 × 64')).not.toBeNull();
    expect(screen.getByText(/cathedrals, keeps, castles/i)).not.toBeNull();
  });

  it('updates template preview and drawing in Architecture Floorplan mode', () => {
    render(
      <NewDocument
        initial="arch"
        signedIn={false}
        onClose={vi.fn()}
        onBeforeCreate={() => true}
        onCreated={vi.fn()}
      />,
    );

    const templateSelect = screen.getByLabelText('Starting floorplan');
    fireEvent.change(templateSelect, { target: { value: 'cottage' } });

    expect(screen.getAllByText('Two-room cottage').length).toBeGreaterThan(0);
    expect(screen.getByText(/two rooms sharing a wall, a stair/i)).not.toBeNull();
  });

  it('creates document and calls onCreated with correct URL', async () => {
    const onCreated = vi.fn();
    render(
      <NewDocument
        initial="build"
        signedIn={false}
        onClose={vi.fn()}
        onBeforeCreate={() => true}
        onCreated={onCreated}
      />,
    );

    const nameInput = screen.getByLabelText('New document name');
    fireEvent.change(nameInput, { target: { value: 'Tower of Light' } });

    const submitBtn = screen.getByRole('button', { name: /create & open/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onCreated.mock.calls[0]![0]).toContain('/studio?');
    });
  });

  it('supports Esc key to cancel modal', () => {
    const onClose = vi.fn();
    render(
      <NewDocument
        initial="build"
        signedIn={false}
        onClose={onClose}
        onBeforeCreate={() => true}
        onCreated={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
