import { useEffect, useRef, useState } from 'react';
import type { LibraryBuild } from '../library/library.js';
import type { SavedWorld } from '../world/api.js';
import type { SavedPlan } from '../architecture/storage.js';
import { openInBuild, openMap, openPlan } from './handoff.js';

interface LocalBuild { id: string; name: string }
export type StudioFileKind = 'map' | 'library' | 'plan' | 'browserBuild';

export interface StudioFilesProps {
  builds: LibraryBuild[];
  maps: SavedWorld[];
  plans: SavedPlan[];
  localBuilds: LocalBuild[];
  loading: boolean;
  signedIn: boolean;
  onOpen: (href: string) => void;
  onClose: () => void;
  onRename: (kind: StudioFileKind, id: string, name: string) => Promise<void>;
  onDelete: (kind: StudioFileKind, id: string) => Promise<void>;
}

/** One place to find and manage every type of Studio work. */
export function StudioFiles({ builds, maps, plans, localBuilds, loading, signedIn, onOpen, onClose, onRename, onDelete }: StudioFilesProps) {
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const match = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());
  const visibleMaps = maps.filter((entry) => match(entry.name));
  const visibleBuilds = builds.filter((entry) => match(entry.name));
  const visiblePlans = plans.filter((entry) => match(entry.name));
  const visibleLocal = localBuilds.filter((entry) => match(entry.name));
  const rename = async (kind: StudioFileKind, id: string, current: string) => {
    const name = window.prompt(`Rename ${current}`, current)?.trim();
    if (!name || name === current) return;
    setPending(`${kind}:${id}`);
    setError(null);
    try { await onRename(kind, id, name); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not rename this file.'); }
    finally { setPending(null); }
  };
  const remove = async (kind: StudioFileKind, id: string, name: string) => {
    if (!window.confirm(`Delete “${name}”? This cannot be undone.`)) return;
    setPending(`${kind}:${id}`);
    setError(null);
    try { await onDelete(kind, id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete this file.'); }
    finally { setPending(null); }
  };
  const actions = (kind: StudioFileKind, id: string, name: string) => <span className="studio-files__manage">
    <button type="button" disabled={pending !== null} onClick={() => void rename(kind, id, name)} aria-label={`Rename ${name}`}>Rename</button>
    <button type="button" disabled={pending !== null} onClick={() => void remove(kind, id, name)} aria-label={`Delete ${name}`}>Delete</button>
  </span>;

  return (
    <div className="studio-files" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="studio-files__panel" role="dialog" aria-modal="true" aria-label="Open Studio work">
        <header className="studio-files__head">
          <div><span className="studio__eyebrow">STUDIO / FILES</span><h2>Open your work</h2><p>Maps, structures, and plans in one place.</p></div>
          <button type="button" className="studio-files__close" onClick={onClose} aria-label="Close files">×</button>
        </header>
        <div className="studio-files__search">
          <input ref={input} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a map, build, or floorplan" aria-label="Find Studio work" />
        </div>
        {error && <p className="studio-files__error" role="alert">{error}</p>}
        <div className="studio-files__list">
          {loading && <p className="studio-files__empty" role="status">Loading your work…</p>}
          {!loading && <>
            <FileGroup title="Maps" count={visibleMaps.length} empty={query ? 'No matching maps.' : 'No saved maps yet.'}>
              {visibleMaps.map((entry) => (
                <div key={entry.id} className="studio-files__row-wrap"><button type="button" className="studio-files__row" onClick={() => onOpen(openMap(entry.id))}>
                  <span className="studio-files__glyph">▦</span><span><strong>{entry.name}</strong><small>{entry.sizeX}×{entry.sizeZ} · {entry.placements} placed</small></span><span className="studio-files__open">Open →</span>
                </button>{actions('map', entry.id, entry.name)}</div>
              ))}
            </FileGroup>
            <FileGroup title="Library builds" count={visibleBuilds.length} empty={signedIn ? (query ? 'No matching builds.' : 'No saved builds yet.') : 'Sign in to see your library.'}>
              {visibleBuilds.map((entry) => (
                <div key={entry.id} className="studio-files__row-wrap">
                  <button type="button" className="studio-files__row" onClick={() => onOpen(openInBuild(`lib:${entry.id}`))}>
                    <span className="studio-files__glyph">◇</span><span><strong>{entry.name}</strong><small>{entry.kind} · {entry.sizeX}×{entry.sizeY}×{entry.sizeZ}</small></span><span className="studio-files__open">Build →</span>
                  </button>
                  {entry.hasPlan && <button type="button" className="studio-files__plan" onClick={() => onOpen(openPlan(entry.id))}>Open plan</button>}
                  {actions('library', entry.id, entry.name)}
                </div>
              ))}
            </FileGroup>
            <FileGroup title="Browser floorplans" count={visiblePlans.length} empty={query ? 'No matching floorplans.' : 'No named drafts yet.'}>
              {visiblePlans.map((entry) => (
                <div key={entry.id} className="studio-files__row-wrap"><button type="button" className="studio-files__row" onClick={() => onOpen(`/studio?mode=arch&plan=local:${encodeURIComponent(entry.id)}`)}>
                  <span className="studio-files__glyph">▤</span><span><strong>{entry.name}</strong><small>Saved on this device</small></span><span className="studio-files__open">Open →</span>
                </button>{actions('plan', entry.id, entry.name)}</div>
              ))}
            </FileGroup>
            {visibleLocal.length > 0 && <FileGroup title="Browser builds" count={visibleLocal.length} empty="">
              {visibleLocal.map((entry) => (
                <div key={entry.id} className="studio-files__row-wrap"><button type="button" className="studio-files__row" onClick={() => onOpen(openInBuild(entry.id))}>
                  <span className="studio-files__glyph">◇</span><span><strong>{entry.name}</strong><small>Saved on this device</small></span><span className="studio-files__open">Open →</span>
                </button>{actions('browserBuild', entry.id, entry.name)}</div>
              ))}
            </FileGroup>}
          </>}
        </div>
        <footer className="studio-files__foot">
          <span>Browser files live on this device. Library builds and signed-in maps live on your account.</span>
          <a href="/library">Library →</a>
        </footer>
      </section>
    </div>
  );
}

function FileGroup({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return <section className="studio-files__group"><h3>{title}<span>{count}</span></h3>{count ? children : <p className="studio-files__empty">{empty}</p>}</section>;
}
