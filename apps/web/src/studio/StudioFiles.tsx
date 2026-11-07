import { BuildThumb } from '../library/BuildThumb.js';
import { PlanThumbnail } from './workspace/PlanThumbnail.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryBuild } from '../library/library.js';
import type { SavedWorld } from '../world/api.js';
import type { SavedPlan } from '../architecture/storage.js';
import {
  catalogue,
  filterFiles,
  validateFileName,
  type FileKind,
  type FileSort,
  type StudioFile,
} from './workspace/fileCatalogue.js';
import { WorkspaceModal } from './workspace/Modal.js';
import { StudioIcon } from './workspace/Icon.js';
import './workspace/files-newdoc.css';

interface LocalBuild {
  id: string;
  name: string;
}

export type StudioFileKind = FileKind;

export type KindFilter = 'all' | 'builds' | 'plans' | 'maps';
export type StorageFilter = 'all' | 'device' | 'account';

export interface StudioFilesProps {
  open?: boolean;
  builds: LibraryBuild[];
  maps: SavedWorld[];
  plans?: SavedPlan[];
  localBuilds?: LocalBuild[];
  loading: boolean;
  signedIn?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onOpen: (href: string) => void;
  onClose: () => void;
  onRename: (kind: StudioFileKind, id: string, name: string) => Promise<void>;
  onDelete: (kind: StudioFileKind, id: string) => Promise<void>;
}

const KIND_FILTERS: { id: KindFilter; label: string; icon: 'folder' | 'cube' | 'plan' | 'world' }[] = [
  { id: 'all', label: 'All work', icon: 'folder' },
  { id: 'builds', label: 'Builds', icon: 'cube' },
  { id: 'plans', label: 'Floorplans', icon: 'plan' },
  { id: 'maps', label: 'Maps', icon: 'world' },
];

const STORAGE_TABS: { id: StorageFilter; label: string }[] = [
  { id: 'all', label: 'All storage' },
  { id: 'device', label: 'Device' },
  { id: 'account', label: 'Account' },
];

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return 'Local draft';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'Recently';
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return 'Recently';
  }
}

export function StudioFiles(props: StudioFilesProps) {
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [storageFilter, setStorageFilter] = useState<StorageFilter>('all');
  const [sort, setSort] = useState<FileSort>('recent');
  const [view, setView] = useState<'grid' | 'list'>('grid');

  const [selected, setSelected] = useState<string | null>(null);
  const [operation, setOperation] = useState<'rename' | 'delete' | null>(null);
  const [name, setName] = useState('');

  // Inline rename state for cards/rows
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  // Delete confirmation dialog state
  const [deletingFile, setDeletingFile] = useState<StudioFile | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const busy = useRef(false);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const safePlans = props.plans ?? [];
  const safeLocalBuilds = props.localBuilds ?? [];
  const safeSignedIn = props.signedIn ?? false;

  const files = useMemo(
    () =>
      catalogue({
        builds: props.builds,
        maps: props.maps,
        plans: safePlans,
        localBuilds: safeLocalBuilds,
        signedIn: safeSignedIn,
      }),
    [props.builds, props.maps, safePlans, safeLocalBuilds, safeSignedIn],
  );

  const libraryById = useMemo(
    () => new Map(props.builds.map((build) => [build.id, build])),
    [props.builds],
  );
  const plansById = useMemo(
    () => new Map(safePlans.map((plan) => [plan.id, plan.plan])),
    [safePlans],
  );

  const counts = useMemo(() => {
    return {
      kind: {
        all: files.length,
        builds: files.filter((f) => f.kind === 'library' || f.kind === 'browserBuild').length,
        plans: files.filter((f) => f.kind === 'plan').length,
        maps: files.filter((f) => f.kind === 'map').length,
      },
      storage: {
        all: files.length,
        device: files.filter((f) => f.storage === 'device').length,
        account: files.filter((f) => f.storage === 'account').length,
      },
    };
  }, [files]);

  const visible = useMemo(
    () => filterFiles(files, query, kindFilter, sort, storageFilter),
    [files, query, kindFilter, sort, storageFilter],
  );

  const current = files.find((file) => file.key === selected) ?? null;

  const select = (file: StudioFile) => {
    if (pending) return;
    setSelected(file.key);
    setOperation(null);
    setError(null);
  };

  const startRename = (file: StudioFile) => {
    setSelected(file.key);
    setRenamingKey(file.key);
    setRenameName(file.title);
    setRenameError(null);
  };

  const applyInlineRename = async (file: StudioFile) => {
    const validation = validateFileName(renameName);
    if (validation) {
      setRenameError(validation);
      return;
    }
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setRenameError(null);
    try {
      await props.onRename(file.kind, file.id, renameName.trim());
      if (live.current) {
        setRenamingKey(null);
      }
    } catch (cause) {
      if (live.current) {
        setRenameError(
          cause instanceof Error ? cause.message : 'Rename could not be completed.',
        );
      }
    } finally {
      busy.current = false;
      if (live.current) setPending(false);
    }
  };

  const applyBottomAction = async () => {
    if (!current || !operation || busy.current) return;
    if (operation === 'rename') {
      const validation = validateFileName(name);
      if (validation) {
        setError(validation);
        return;
      }
    }
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (operation === 'rename') {
        await props.onRename(current.kind, current.id, name.trim());
      } else {
        await props.onDelete(current.kind, current.id);
      }
      if (live.current) {
        setOperation(null);
        if (operation === 'delete') setSelected(null);
      }
    } catch (cause) {
      if (live.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'This action could not be completed.',
        );
      }
    } finally {
      busy.current = false;
      if (live.current) setPending(false);
    }
  };

  const confirmDeleteFile = async (file: StudioFile) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setDeleteError(null);
    try {
      await props.onDelete(file.kind, file.id);
      if (live.current) {
        setDeletingFile(null);
        if (selected === file.key) setSelected(null);
      }
    } catch (cause) {
      if (live.current) {
        const message =
          cause instanceof Error ? cause.message : 'Could not delete this file.';
        setDeleteError(message);
      }
    } finally {
      busy.current = false;
      if (live.current) setPending(false);
    }
  };

  // The confirmation is its own aria-modal dialog, so useModalFocus no longer sees Escape.
  useEffect(() => {
    if (!deletingFile || pending) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDeletingFile(null);
        setDeleteError(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deletingFile, pending]);

  const close = () => {
    if (pending) return;
    props.onClose();
  };

  const openNewDocument = () => {
    close();
    window.dispatchEvent(new CustomEvent('studio:new-document'));
  };

  if (props.open === false) return null;

  return (
    <WorkspaceModal
      title="Your work"
      eyebrow="STRUCTURES · FLOORPLANS · WORLDS"
      wide
      onClose={close}
    >
      <div className="workspace-files">
        {/* Top Toolbar */}
        <div className="workspace-files__toolbar">
          <div className="workspace-files__search-wrap">
            <StudioIcon name="search" />
            <input
              type="search"
              autoFocus
              placeholder="Find a structure, floorplan or world…"
              aria-label="Find Studio work"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                className="workspace-files__search-clear"
                aria-label="Clear search"
                title="Clear search"
                onClick={() => setQuery('')}
              >
                <StudioIcon name="close" />
              </button>
            )}
          </div>
          <div className="workspace-files__toolbar-controls">
            <select
              aria-label="Sort files"
              value={sort}
              onChange={(event) => setSort(event.target.value as FileSort)}
            >
              <option value="recent">Recently updated</option>
              <option value="name">Name A–Z</option>
              <option value="kind">Type</option>
            </select>
            <div className="workspace-files__view-toggle" role="radiogroup" aria-label="Layout view">
              <button
                type="button"
                aria-label="Grid layout"
                aria-pressed={view === 'grid'}
                data-active={view === 'grid'}
                onClick={() => setView('grid')}
                title="Grid view"
              >
                <StudioIcon name="cube" />
                <span>Grid</span>
              </button>
              <button
                type="button"
                aria-label="List layout"
                aria-pressed={view === 'list'}
                data-active={view === 'list'}
                onClick={() => setView('list')}
                title="List view"
              >
                <StudioIcon name="plan" />
                <span>List</span>
              </button>
            </div>
          </div>
        </div>

        {/* Filter Chips Bar (Kind chips + Storage tabs) */}
        <nav className="workspace-files__filters-bar" role="navigation" aria-label="File filters">
          <div className="workspace-files__kind-pills" role="toolbar" aria-label="File kind filters">
            {KIND_FILTERS.map((entry) => (
              <button
                type="button"
                key={entry.id}
                className="workspace-files__pill"
                aria-pressed={kindFilter === entry.id}
                data-active={kindFilter === entry.id}
                onClick={() => setKindFilter(entry.id)}
              >
                <StudioIcon name={entry.icon} />
                <span>{entry.label}</span>
                <span className="workspace-files__pill-count">{counts.kind[entry.id]}</span>
              </button>
            ))}
          </div>

          <div className="workspace-files__storage-tabs" role="tablist" aria-label="Storage location">
            {STORAGE_TABS.map((tab) => (
              <button
                type="button"
                key={tab.id}
                role="tab"
                className="workspace-files__storage-tab"
                aria-selected={storageFilter === tab.id}
                data-active={storageFilter === tab.id}
                onClick={() => setStorageFilter(tab.id)}
              >
                <span>{tab.label}</span>
                <span className="workspace-files__pill-count">{counts.storage[tab.id]}</span>
              </button>
            ))}
          </div>
        </nav>

        {/* Modal Main Content */}
        <div className="workspace-files__body">
          <div className="workspace-files__main">
            {props.error && (
              <div className="workspace-files__error-banner" role="alert">
                <StudioIcon name="warning" />
                <div className="workspace-files__error-copy">
                  <strong>Failed to load work</strong>
                  <span>{props.error}</span>
                </div>
                {props.onRetry && (
                  <button type="button" className="workspace-files__retry-btn" onClick={props.onRetry}>
                    Retry loading
                  </button>
                )}
              </div>
            )}

            {props.loading ? (
              <div className="workspace-files__loading-state" role="status" aria-label="Loading your work">
                <div className={`workspace-files__skeletons workspace-files__skeletons--${view}`}>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="workspace-file-skeleton">
                      <div className="workspace-file-skeleton__thumb" />
                      <div className="workspace-file-skeleton__meta">
                        <div className="workspace-file-skeleton__bar workspace-file-skeleton__bar--title" />
                        <div className="workspace-file-skeleton__bar workspace-file-skeleton__bar--sub" />
                        <div className="workspace-file-skeleton__bar workspace-file-skeleton__bar--badge" />
                      </div>
                    </div>
                  ))}
                </div>
                <p className="workspace-files__loading-text">Loading your files…</p>
              </div>
            ) : visible.length ? (
              <div
                className={`workspace-files__results workspace-files__results--${view}`}
                role="list"
                aria-label="Studio files"
              >
                {visible.map((file) => {
                  const isRenaming = renamingKey === file.key;
                  const isSelected = selected === file.key;
                  return (
                    <div
                      key={file.key}
                      role="listitem"
                      className="workspace-file workspace-file__select"
                      data-selected={isSelected}
                      data-kind={file.kind}
                      data-storage={file.storage}
                      tabIndex={0}
                      onClick={() => select(file)}
                      onDoubleClick={(e) => {
                        if ((e.target as HTMLElement).closest('button, input, form')) return;
                        if (!pending) props.onOpen(file.href);
                      }}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' && !isRenaming) {
                          props.onOpen(file.href);
                        }
                      }}
                    >
                      {/* Preview area */}
                      <div className={`workspace-file__preview workspace-file__preview--${file.kind}`}>
                        {file.kind === 'library' && libraryById.has(file.id) ? (
                          <BuildThumb
                            build={libraryById.get(file.id)!}
                            variant={view === 'grid' ? 'card' : 'row'}
                          />
                        ) : file.kind === 'plan' && plansById.has(file.id) ? (
                          <PlanThumbnail plan={plansById.get(file.id)!} />
                        ) : (
                          <StudioIcon
                            name={
                              file.kind === 'map'
                                ? 'world'
                                : file.kind === 'plan'
                                  ? 'plan'
                                  : 'cube'
                            }
                          />
                        )}
                        <span className="workspace-file__kind-pill">
                          <StudioIcon
                            name={
                              file.kind === 'map'
                                ? 'world'
                                : file.kind === 'plan'
                                  ? 'plan'
                                  : 'cube'
                            }
                          />
                          {file.kind === 'map'
                            ? 'WORLD'
                            : file.kind === 'plan'
                              ? 'PLAN'
                              : 'BUILD'}
                        </span>
                      </div>

                      {/* Content copy */}
                      <div className="workspace-file__copy">
                        {isRenaming ? (
                          <form
                            className="workspace-file__inline-rename"
                            onSubmit={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void applyInlineRename(file);
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              autoFocus
                              value={renameName}
                              maxLength={120}
                              disabled={pending}
                              aria-label={`Enter new name for ${file.title}`}
                              onChange={(e) => setRenameName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  e.stopPropagation();
                                  setRenamingKey(null);
                                  setRenameError(null);
                                }
                              }}
                            />
                            <div className="workspace-file__inline-rename-buttons">
                              <button
                                type="submit"
                                className="workspace-file__rename-btn workspace-file__rename-btn--save"
                                disabled={pending}
                                title="Save name"
                                aria-label="Save name"
                              >
                                <StudioIcon name="check" />
                              </button>
                              <button
                                type="button"
                                className="workspace-file__rename-btn workspace-file__rename-btn--cancel"
                                disabled={pending}
                                title="Cancel rename"
                                aria-label="Cancel rename"
                                onClick={() => {
                                  setRenamingKey(null);
                                  setRenameError(null);
                                }}
                              >
                                <StudioIcon name="close" />
                              </button>
                            </div>
                            {renameError && (
                              <p className="workspace-file__rename-error" role="alert">
                                {renameError}
                              </p>
                            )}
                          </form>
                        ) : (
                          <>
                            <strong title={file.title}>{file.title}</strong>
                            <div className="workspace-file__meta">
                              <span className="workspace-file__measure">
                                {file.blocks !== undefined
                                  ? `${file.blocks.toLocaleString()} blocks`
                                  : file.detail}
                              </span>
                              <span className="workspace-file__dot">·</span>
                              <span className="workspace-file__date">{formatTimestamp(file.updatedAt)}</span>
                            </div>
                            <div className="workspace-file__badges">
                              <span
                                className={`workspace-file__storage-badge workspace-file__storage-badge--${file.storage}`}
                                data-storage={file.storage}
                              >
                                <StudioIcon name={file.storage === 'account' ? 'spark' : 'folder'} />
                                {file.storage === 'account' ? 'Account' : 'Device'}
                              </span>
                              {file.planHref && (
                                <span className="workspace-file__linked-badge">
                                  <StudioIcon name="plan" />
                                  Linked plan
                                </span>
                              )}
                            </div>
                          </>
                        )}
                      </div>

                      {/* Hover action bar */}
                      <div
                        className="workspace-file__hover-actions"
                        role="toolbar"
                        aria-label={`Actions for ${file.title}`}
                      >
                        <button
                          type="button"
                          className="workspace-file__action-btn workspace-file__action-btn--open"
                          title="Open file"
                          aria-label={`Open ${file.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onOpen(file.href);
                          }}
                        >
                          <StudioIcon name="arrow" />
                          <span>Open</span>
                        </button>
                        <button
                          type="button"
                          className="workspace-file__action-btn workspace-file__action-btn--rename"
                          title="Rename file"
                          aria-label={`Rename ${file.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(file);
                          }}
                        >
                          <StudioIcon name="settings" />
                          <span>Rename</span>
                        </button>
                        <button
                          type="button"
                          className="workspace-file__action-btn workspace-file__action-btn--delete"
                          title="Delete file"
                          aria-label={`Delete ${file.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteError(null);
                            setDeletingFile(file);
                          }}
                        >
                          <StudioIcon name="close" />
                          <span>Delete</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="workspace-empty workspace-files__empty" role="status">
                <div className="workspace-empty__icon">
                  <StudioIcon name="folder" />
                </div>
                <h3>{query ? `No work matching "${query}"` : 'No files found'}</h3>
                <p>
                  {storageFilter === 'account' && !safeSignedIn
                    ? 'Sign in to access your cloud account library across devices.'
                    : query
                      ? 'Try different search keywords, or reset your filters.'
                      : 'Try a different filter, or create a new file to get started.'}
                </p>
                <div className="workspace-files__empty-actions">
                  {(query || kindFilter !== 'all' || storageFilter !== 'all') && (
                    <button
                      type="button"
                      className="workspace-files__btn"
                      onClick={() => {
                        setQuery('');
                        setKindFilter('all');
                        setStorageFilter('all');
                      }}
                    >
                      Show all work
                    </button>
                  )}
                  <button
                    type="button"
                    className="workspace-primary"
                    onClick={openNewDocument}
                  >
                    <StudioIcon name="plus" />
                    <span>Create new document</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Delete Confirmation Dialog Overlay */}
        {deletingFile && (
          <div
            className="workspace-files__confirm-overlay"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-delete-title"
            aria-describedby="confirm-delete-desc"
            onClick={() => {
              if (!pending) {
                setDeletingFile(null);
                setDeleteError(null);
              }
            }}
          >
            <div
              className="workspace-files__confirm-modal workspace-files__confirm-dialog"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="workspace-files__confirm-icon">
                <StudioIcon name="warning" />
              </div>
              <div className="workspace-files__confirm-body">
                <h3 id="confirm-delete-title">Delete “{deletingFile.title}”?</h3>
                <p id="confirm-delete-desc">
                  Are you sure you want to delete this {deletingFile.kind === 'map' ? 'world' : deletingFile.kind === 'plan' ? 'floorplan' : 'structure'}?
                  {deletingFile.storage === 'account'
                    ? ' This will permanently remove it from your account.'
                    : ' This will permanently remove it from this device.'}
                  {' '}This action cannot be undone.
                </p>
                {deleteError && (
                  <p className="workspace-files__confirm-error" role="alert">
                    {deleteError}
                  </p>
                )}
              </div>
              <div className="workspace-files__confirm-buttons workspace-files__confirm-actions">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setDeletingFile(null);
                    setDeleteError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="workspace-files__btn-danger workspace-danger"
                  disabled={pending}
                  onClick={() => void confirmDeleteFile(deletingFile)}
                >
                  {pending ? 'Deleting…' : 'Delete file'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Selection Bar */}
        <div className="workspace-files__selection">
          {current ? (
            <>
              <div className="workspace-files__selection-info">
                <strong>{current.title}</strong>
                <small>
                  {current.blocks !== undefined
                    ? `${current.blocks.toLocaleString()} blocks · `
                    : ''}
                  {current.storage === 'account'
                    ? 'Saved to account'
                    : 'Stored on this device'}
                  {current.updatedAt ? ` · ${formatTimestamp(current.updatedAt)}` : ''}
                </small>
              </div>
              {!operation ? (
                <div className="workspace-files__selection-actions">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setName(current.title);
                      setOperation('rename');
                      setError(null);
                    }}
                  >
                    <StudioIcon name="settings" />
                    Rename
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setOperation('delete');
                      setError(null);
                    }}
                  >
                    <StudioIcon name="close" />
                    Delete
                  </button>
                  {current.planHref && (
                    <button
                      type="button"
                      onClick={() => props.onOpen(current.planHref!)}
                    >
                      <StudioIcon name="plan" />
                      Open plan
                    </button>
                  )}
                  <button
                    type="button"
                    className="workspace-files__open workspace-primary"
                    onClick={() => props.onOpen(current.href)}
                  >
                    Open <StudioIcon name="arrow" />
                  </button>
                </div>
              ) : (
                <form
                  className="workspace-files__selection-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void applyBottomAction();
                  }}
                >
                  {operation === 'rename' ? (
                    <input
                      autoFocus
                      aria-label="New file name"
                      value={name}
                      maxLength={120}
                      disabled={pending}
                      onChange={(event) => setName(event.target.value)}
                    />
                  ) : (
                    <span>Delete this saved file? This cannot be undone.</span>
                  )}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setOperation(null);
                      setError(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="workspace-primary" disabled={pending}>
                    {pending
                      ? 'Working…'
                      : operation === 'rename'
                        ? 'Save name'
                        : 'Delete file'}
                  </button>
                </form>
              )}
            </>
          ) : (
            <p className="workspace-files__selection-hint">
              Select a file to inspect details, rename or delete. Double-click opens directly.
            </p>
          )}
        </div>

        {error && (
          <p className="workspace-files__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </WorkspaceModal>
  );
}
