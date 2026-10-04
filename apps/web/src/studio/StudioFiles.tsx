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
  type FileFilter,
  type FileSort,
  type StudioFile,
} from './workspace/fileCatalogue.js';
import { WorkspaceModal } from './workspace/Modal.js';
import { StudioIcon } from './workspace/Icon.js';
interface LocalBuild {
  id: string;
  name: string;
}
export type StudioFileKind = FileKind;
export interface StudioFilesProps {
  builds: LibraryBuild[];
  maps: SavedWorld[];
  plans: SavedPlan[];
  localBuilds: LocalBuild[];
  loading: boolean;
  signedIn: boolean;
  error?: string | null;
  onRetry?: () => void;
  onOpen: (href: string) => void;
  onClose: () => void;
  onRename: (kind: StudioFileKind, id: string, name: string) => Promise<void>;
  onDelete: (kind: StudioFileKind, id: string) => Promise<void>;
}
const FILTERS: { id: FileFilter; label: string }[] = [
  { id: 'all', label: 'All work' },
  { id: 'builds', label: 'Structures' },
  { id: 'plans', label: 'Floorplans' },
  { id: 'maps', label: 'Worlds' },
  { id: 'device', label: 'This device' },
  { id: 'account', label: 'Account' },
];
export function StudioFiles(props: StudioFilesProps) {
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState<FileFilter>('all'),
    [sort, setSort] = useState<FileSort>('recent'),
    [view, setView] = useState<'grid' | 'list'>('grid');
  const [selected, setSelected] = useState<string | null>(null),
    [operation, setOperation] = useState<'rename' | 'delete' | null>(null),
    [name, setName] = useState('');
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const live = useRef(true),
    busy = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const files = useMemo(
    () => catalogue(props),
    [props.builds, props.maps, props.plans, props.localBuilds, props.signedIn],
  );
  const libraryById = useMemo(
    () => new Map(props.builds.map((build) => [build.id, build])),
    [props.builds],
  );
  const plansById = useMemo(
    () => new Map(props.plans.map((plan) => [plan.id, plan.plan])),
    [props.plans],
  );
  const visible = useMemo(
    () => filterFiles(files, query, filter, sort),
    [files, query, filter, sort],
  );
  const current = files.find((file) => file.key === selected) ?? null;
  const select = (file: StudioFile) => {
    if (pending) return;
    setSelected(file.key);
    setOperation(null);
    setError(null);
  };
  const apply = async () => {
    if (!current || !operation || busy.current) return;
    const validation = operation === 'rename' ? validateFileName(name) : null;
    if (validation) {
      setError(validation);
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (operation === 'rename')
        await props.onRename(current.kind, current.id, name.trim());
      else await props.onDelete(current.kind, current.id);
      if (live.current) {
        setOperation(null);
        if (operation === 'delete') setSelected(null);
      }
    } catch (cause) {
      if (live.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'This action could not be completed.',
        );
    } finally {
      busy.current = false;
      if (live.current) setPending(false);
    }
  };
  const close = () => {
    if (pending) return;
    props.onClose();
  };
  return (
    <WorkspaceModal
      title="Your work"
      eyebrow="STRUCTURES · FLOORPLANS · WORLDS"
      wide
      onClose={close}
    >
      <div className="workspace-files">
        <div className="workspace-files__toolbar">
          <label>
            <StudioIcon name="search" />
            <input
              type="search"
              autoFocus
              placeholder="Find a structure, floorplan or world…"
              aria-label="Find Studio work"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            aria-label="Sort files"
            value={sort}
            onChange={(event) => setSort(event.target.value as FileSort)}
          >
            <option value="recent">Recently updated</option>
            <option value="name">Name A–Z</option>
            <option value="kind">Type</option>
          </select>
          <button
            aria-label="Toggle file layout"
            onClick={() => setView((v) => (v === 'grid' ? 'list' : 'grid'))}
          >
            {view === 'grid' ? 'List' : 'Grid'}
          </button>
        </div>
        <div className="workspace-files__body">
          <nav aria-label="File filters">
            {FILTERS.map((entry) => (
              <button
                key={entry.id}
                aria-pressed={filter === entry.id}
                onClick={() => setFilter(entry.id)}
              >
                {entry.label}
                <small>{filterFiles(files, '', entry.id, 'name').length}</small>
              </button>
            ))}
            <p>
              Device files stay in this browser. Account files travel with you.
            </p>
          </nav>
          <div className="workspace-files__main">
            {props.error && (
              <div className="workspace-files__error" role="alert">
                {props.error}
                <button onClick={props.onRetry}>Retry loading</button>
              </div>
            )}
            {props.loading ? (
              <div className="workspace-empty" role="status">
                Loading your work…
              </div>
            ) : visible.length ? (
              <div
                className={`workspace-files__results workspace-files__results--${view}`}
                role="list"
                aria-label="Studio files"
              >
                {visible.map((file) => (
                  <div
                    key={file.key}
                    role="listitem"
                    className="workspace-file"
                    data-selected={selected === file.key}
                  >
                    <button
                      className="workspace-file__select"
                      aria-pressed={selected === file.key}
                      onClick={() => select(file)}
                      onDoubleClick={() => !pending && props.onOpen(file.href)}
                      disabled={pending}
                    >
                      <div
                        className={`workspace-file__preview workspace-file__preview--${file.kind}`}
                      >
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
                        <span>
                          {file.kind === 'map'
                            ? 'WORLD'
                            : file.kind === 'plan'
                              ? 'PLAN'
                              : 'BUILD'}
                        </span>
                      </div>
                      <div className="workspace-file__copy">
                        <strong>{file.title}</strong>
                        <small>{file.detail}</small>
                        <span>
                          {file.storage === 'device'
                            ? 'This device'
                            : 'Account'}
                          {file.planHref ? ' · Linked plan' : ''}
                        </span>
                      </div>
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="workspace-empty">
                <StudioIcon name="folder" />
                <h3>{query ? 'No matching work' : 'Nothing here yet'}</h3>
                <p>
                  {filter === 'account' && !props.signedIn
                    ? 'Sign in to see your account library.'
                    : 'Try a different filter, or create something in the studio and save it.'}
                </p>
                {(query || filter !== 'all') && (
                  <button
                    onClick={() => {
                      setQuery('');
                      setFilter('all');
                    }}
                  >
                    Show all work
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="workspace-files__selection">
          {current ? (
            <>
              <div>
                <strong>{current.title}</strong>
                <small>
                  {current.blocks !== undefined
                    ? `${current.blocks.toLocaleString()} blocks · `
                    : ''}
                  {current.storage === 'account'
                    ? 'Saved to account'
                    : 'Stored on this device'}
                </small>
              </div>
              {!operation ? (
                <>
                  <button
                    disabled={pending}
                    onClick={() => {
                      setName(current.title);
                      setOperation('rename');
                      setError(null);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    disabled={pending}
                    onClick={() => {
                      setOperation('delete');
                      setError(null);
                    }}
                  >
                    Delete
                  </button>
                  {current.planHref && (
                    <button onClick={() => props.onOpen(current.planHref!)}>
                      Open plan
                    </button>
                  )}
                  <button
                    className="workspace-files__open"
                    onClick={() => props.onOpen(current.href)}
                  >
                    Open <StudioIcon name="arrow" />
                  </button>
                </>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void apply();
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
                  <button type="submit" disabled={pending}>
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
            <p>
              Select a file to inspect it, then open it. Double-click opens
              directly.
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
