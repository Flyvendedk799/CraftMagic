/**
 * One workbench for three document types: voxel builds, floorplans, and maps.
 *
 * The shell owns document navigation, File actions, project history, and the command palette.
 * Each mounted editor owns the format and tools for its document and registers its live Save
 * and New operations with the workbench. Handoffs are canonical Studio links, so work can be
 * reopened from the file manager or a shared address.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { STYLE_PACKS } from '@craftmagic/core';
import { BUILD_IDS, forgetLibraryBuild, forgetLocalBuild, generatedBuilds, importedBuilds, muralBuilds, renameLocalBuild } from '../editor/builds.js';
import { EditorPage } from '../editor/EditorPage.js';
import { ArchitecturePage } from '../architecture/ArchitecturePage.js';
import { deleteSaved, listSaved, savePlan } from '../architecture/storage.js';
import { WorldPage } from '../world/WorldPage.js';
import { NavCenterProvider } from '../shell/NavCenter.js';
import { useAuth } from '../library/auth.js';
import { deleteBuild, listBuilds, renameBuild, type LibraryBuild } from '../library/library.js';
import { localStore, remoteStore, type SavedWorld } from '../world/api.js';
import { CommandPalette, type Command } from './CommandPalette.js';
import { StudioFiles, type StudioFileKind } from './StudioFiles.js';
import { composeMap, drawFloorplan, libRef, libRowId, openGuide, openInBuild, openMap, openPlan, placeOnMap, planForBuild } from './handoff.js';
import { takePlanHandoff } from './handoffBridge.js';
import { bindZoom, redoProject, undoProject, type JournalFrame } from './journal.js';
import { useUndoKeys } from './undoKeys.js';
import { useJournalFlags } from './useZoomUndo.js';
import { WorkbenchProvider, useWorkbenchActions } from './workbench.js';
import { PresenceProvider, useConfirmLeave, useStudioPresence } from './presence.js';
import { MODE_SPECS, STUDIO_MODES, foreignParams, modeParam, ownsParam, parseMode, type StudioMode } from './mode.js';
import './studio.css';

/** Enough recent library builds for the palette to offer without becoming the library. */
const PALETTE_LIBRARY_LIMIT = 5;
const RETURN_TO_KEY = 'craftmagic.studio.openDocuments';

function restoreOpenDocuments(): Partial<Record<StudioMode, string>> {
  try {
    const stored = JSON.parse(sessionStorage.getItem(RETURN_TO_KEY) ?? '{}') as Record<string, unknown>;
    const result: Partial<Record<StudioMode, string>> = {};
    for (const mode of STUDIO_MODES) {
      const href = stored[mode];
      if (typeof href !== 'string') continue;
      const url = new URL(href, window.location.origin);
      if (url.origin === window.location.origin && url.pathname === '/studio' && parseMode(url.searchParams.get('mode')) === mode) {
        result[mode] = `${url.pathname}${url.search}`;
      }
    }
    return result;
  } catch { return {}; }
}

export type { StudioMode } from './mode.js';

/**
 * Which page each mode mounts.
 *
 * A record rather than a chain of ternaries. Two modes fit in a ternary; three is where one
 * gets forgotten in the mount but not the switch, and the symptom is a pill that lights up
 * over the wrong page.
 */
const MODE_PAGES: Readonly<Record<StudioMode, () => JSX.Element>> = {
  build: EditorPage,
  arch: ArchitecturePage,
  world: WorldPage,
};

export function StudioPage() {
  return (
    <PresenceProvider>
      <WorkbenchProvider><StudioShell /></WorkbenchProvider>
    </PresenceProvider>
  );
}

function StudioShell() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const mode = parseMode(searchParams.get('mode'));
  const [palette, setPalette] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [, setFilesRevision] = useState(0);
  const [documentRevision, setDocumentRevision] = useState(0);
  const [mobilePane, setMobilePane] = useState<'canvas' | 'tools' | 'project'>('canvas');
  useEffect(() => setMobilePane('canvas'), [mode]);
  const auth = useAuth();
  // Every editor gets its own return address. A mode switch must not quietly turn a named
  // map into the browser draft or a selected build into the empty plot.
  const returnTo = useRef<Partial<Record<StudioMode, string>>>(restoreOpenDocuments());
  useEffect(() => {
    const own = new URLSearchParams();
    for (const [key, value] of searchParams) {
      if (ownsParam(mode, key)) own.set(key, value);
    }
    const modeValue = modeParam(mode);
    if (modeValue) own.set('mode', modeValue);
    returnTo.current[mode] = `/studio${own.size ? `?${own}` : ''}`;
    try { sessionStorage.setItem(RETURN_TO_KEY, JSON.stringify(returnTo.current)); } catch { /* Navigation still works without storage. */ }
  }, [mode, searchParams]);

  /**
   * What the palette can name that is not in the bundle: the account's maps and its recent
   * library builds. Fetched when the palette opens rather than on mount, because most visits
   * never open it, and kept as plain lists so every command stays a navigation — the map
   * opens through `?world=`, the build arms through `?place=`, exactly as the dashboard's
   * links do.
   */
  const [maps, setMaps] = useState<SavedWorld[]>([]);
  const [libraryBuilds, setLibraryBuilds] = useState<LibraryBuild[]>([]);
  useEffect(() => {
    if ((!palette && !filesOpen) || auth.status === 'loading') return;
    let live = true;
    if (filesOpen) setFilesLoading(true);
    const store = auth.status === 'signedIn' ? remoteStore : localStore;
    const mapRequest = store.list().then((rows) => { if (live) setMaps(rows); }, () => undefined);
    if (auth.status === 'signedIn') {
      const buildRequest = listBuilds().then(
        (rows) => { if (live) setLibraryBuilds([...rows].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))); },
        () => undefined,
      );
      void Promise.allSettled([mapRequest, buildRequest]).then(() => { if (live) setFilesLoading(false); });
    } else {
      setLibraryBuilds([]);
      void mapRequest.finally(() => { if (live) setFilesLoading(false); });
    }
    return () => {
      live = false;
    };
  }, [palette, filesOpen, auth.status]);

  const presence = useStudioPresence();
  const currentPresence = presence.mode === mode ? presence : null;
  const journal = useJournalFlags();
  const workbench = useWorkbenchActions(mode);
  const workbenchRef = useRef(workbench);
  workbenchRef.current = workbench;
  useEffect(() => {
    const onSave = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const action = workbenchRef.current;
      if (action?.canSave) void action.save();
    };
    window.addEventListener('keydown', onSave, true);
    return () => window.removeEventListener('keydown', onSave, true);
  }, []);
  const confirmLeave = useConfirmLeave();

  const openFrame = useCallback(
    (frame: JournalFrame) => {
      const href = frame.scope === 'build'
        ? openInBuild(frame.docId)
        : frame.scope === 'arch'
          ? returnTo.current.arch ?? drawFloorplan()
          : returnTo.current.world ?? composeMap();
      navigate(href, { replace: true });
    },
    [navigate],
  );

  useEffect(() => bindZoom(openFrame), [openFrame]);
  useUndoKeys({ undo: undoProject, redo: redoProject });

  // A stale `?build=lib:` left in the address bar while Architecture is open used to mean
  // "Untitled layout" plus the disconnect banner. Translate it into the linked plan URL.
  useEffect(() => {
    if (mode !== 'arch') return;
    if (searchParams.get('plan')) return;
    const row = libRowId(searchParams.get('build') ?? '');
    if (!row) return;
    navigate(openPlan(row), { replace: true });
  }, [mode, searchParams, navigate]);

  /**
   * Zoom to another level of the same project — carrying identity, not opening a peer draft.
   *
   * Build → Architecture opens that library build's plan (`?plan=lib:`), or starts a layout
   * bound to the same row. Architecture → Build compiles into the linked row (or a hand-off).
   * Zooming out to the map drops `build` / `plan` so the "not on the map" banner does not
   * fire for a structure you just left.
   */
  const setMode = useCallback(
    (next: StudioMode) => {
      if (next === mode) return;
      setMobilePane('canvas');
      if (next === 'world') {
        navigate(returnTo.current.world ?? composeMap());
        return;
      }
      if (next === 'build') {
        if (mode === 'arch') {
          const id = takePlanHandoff() ?? (libRowId(searchParams.get('plan') ?? '') ? searchParams.get('plan') : null);
          if (id) {
            navigate(openInBuild(id));
            return;
          }
        }
        navigate(returnTo.current.build ?? '/studio');
        return;
      }
      const row = mode === 'build'
        ? presence.structureRowId ?? libRowId(searchParams.get('build') ?? '')
        : null;
      if (row) navigate(openPlan(row));
      else navigate(returnTo.current.arch ?? drawFloorplan());
    },
    [mode, navigate, presence.structureRowId, searchParams],
  );

  const openStructurePlan = useCallback(() => {
    const row = presence.structureRowId ?? libRowId(searchParams.get('build') ?? '');
    if (row) {
      navigate(openPlan(row));
      return;
    }
    setMode('arch');
  }, [presence.structureRowId, searchParams, navigate, setMode]);

  // Ctrl+K (or ⌘K) from anywhere on the page, text fields included — the palette is how you
  // leave wherever you are, so no context may swallow it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const openOutput = useCallback(() => {
    setMobilePane(mode === 'arch' ? 'tools' : 'project');
    requestAnimationFrame(() => {
      const section = document.getElementById('studio-section-export');
      section?.dispatchEvent(new Event('studio:open-section'));
      section?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, [mode]);

  const openFile = useCallback((href: string) => {
    if (currentPresence?.dirty && !window.confirm(`Open another document? Save changes to ${currentPresence.dirtyLabel} first if you need this version.`)) return;
    setFilesOpen(false);
    navigate(href);
  }, [navigate, currentPresence?.dirty, currentPresence?.dirtyLabel]);

  const isOpenFile = useCallback((kind: StudioFileKind, id: string) => {
    if (kind === 'map') return mode === 'world' && searchParams.get('world') === id;
    if (kind === 'library') return (mode === 'build' && searchParams.get('build') === `lib:${id}`)
      || (mode === 'arch' && searchParams.get('plan') === `lib:${id}`);
    if (kind === 'plan') return mode === 'arch' && searchParams.get('plan') === `local:${id}`;
    return mode === 'build' && searchParams.get('build') === id;
  }, [mode, searchParams]);

  const refreshFiles = useCallback(async () => {
    const store = auth.status === 'signedIn' ? remoteStore : localStore;
    const [mapsResult, buildsResult] = await Promise.allSettled([
      store.list(),
      auth.status === 'signedIn' ? listBuilds() : Promise.resolve([]),
    ]);
    if (mapsResult.status === 'fulfilled') setMaps(mapsResult.value);
    if (buildsResult.status === 'fulfilled') setLibraryBuilds(buildsResult.value);
    setFilesRevision((value) => value + 1);
  }, [auth.status]);

  const guardActiveFile = useCallback((kind: StudioFileKind, id: string) => {
    if (isOpenFile(kind, id) && currentPresence?.dirty) {
      throw new Error('Save your changes to this open document before renaming or deleting it.');
    }
  }, [isOpenFile, currentPresence?.dirty]);

  const renameFile = useCallback(async (kind: StudioFileKind, id: string, name: string) => {
    guardActiveFile(kind, id);
    if (kind === 'library') { await renameBuild(id, name); forgetLibraryBuild(id); }
    else if (kind === 'plan') {
      const entry = listSaved().find((item) => item.id === id);
      if (!entry) throw new Error('This floorplan is no longer saved here.');
      savePlan({ ...entry.plan, name });
    } else if (kind === 'browserBuild') {
      if (!renameLocalBuild(id, name)) throw new Error('This build is no longer saved here.');
    } else {
      const store = auth.status === 'signedIn' ? remoteStore : localStore;
      const doc = await store.load(id);
      if (!doc || !(await store.save({ ...doc, name }))) throw new Error('Could not rename this map.');
    }
    await refreshFiles();
    if (isOpenFile(kind, id)) setDocumentRevision((value) => value + 1);
  }, [auth.status, guardActiveFile, isOpenFile, refreshFiles]);

  const deleteFile = useCallback(async (kind: StudioFileKind, id: string) => {
    guardActiveFile(kind, id);
    if (kind === 'library') { await deleteBuild(id); forgetLibraryBuild(id); }
    else if (kind === 'plan') deleteSaved(id);
    else if (kind === 'browserBuild') {
      if (!forgetLocalBuild(id)) throw new Error('This build is no longer saved here.');
    } else {
      const store = auth.status === 'signedIn' ? remoteStore : localStore;
      if (!(await store.remove(id))) throw new Error('Could not delete this map.');
    }
    if (isOpenFile(kind, id)) {
      const fallback = mode === 'world' ? composeMap() : mode === 'arch' ? drawFloorplan() : '/studio';
      returnTo.current[mode] = fallback;
      navigate(fallback, { replace: true });
      setDocumentRevision((value) => value + 1);
    }
    await refreshFiles();
  }, [auth.status, guardActiveFile, isOpenFile, mode, navigate, refreshFiles]);

  /**
   * The command list, rebuilt when the palette opens. Document actions use the mounted
   * editor's registered callbacks; opening other work uses canonical Studio links.
   */
  const commands = useMemo<Command[]>(() => {
    if (!palette) return [];
    const withSearch = (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams);
      mutate(params);
      const search = params.toString();
      navigate({ pathname: '/studio', search: search ? `?${search}` : '' });
    };

    // Every mode except the one you are in. This was a ternary offering the single other
    // mode, which with three of them would silently hide one. Architecture is reached through
    // `setMode`, which opens the linked plan when a library build is on screen — never an
    // untitled draft with the old "belongs to Build" banner.
    const list: Command[] = STUDIO_MODES.filter((id) => id !== mode).map((id) => ({
      id: `mode-${id}`,
      label: `Switch to ${MODE_SPECS[id].label} mode`,
      hint:
        id === 'arch' && (presence.structureRowId || libRowId(searchParams.get('build') ?? ''))
          ? presence.hasPlan
            ? 'Open this build’s floorplan'
            : 'Create a layout for this build'
          : MODE_SPECS[id].hint,
      run: () => setMode(id),
    }));

    if (mode === 'build') {
      const planHref = planForBuild(searchParams.get('build')) ?? (presence.structureRowId ? openPlan(presence.structureRowId) : null);
      if (planHref) {
        list.unshift({
          id: 'open-structure-plan',
          label: presence.hasPlan ? 'Open this build’s plan' : 'Create a layout for this build',
          hint: 'Architecture — linked to the same library row',
          run: () => navigate(planHref),
        });
      }
    }

    for (const id of BUILD_IDS) {
      list.push({
        id: `build-${id}`,
        label: `Open build: ${id[0]!.toUpperCase()}${id.slice(1)}`,
        hint: 'Sample',
        // Deleting the mode is what makes this land in Build, which is where a build opens.
        run: () => withSearch((params) => {
          params.delete('mode');
          params.set('build', id);
        }),
      });
    }
    // Recent generations, newest first — the builds someone actually comes back for.
    for (const entry of generatedBuilds().slice(-3).reverse()) {
      list.push({
        id: `build-${entry.id}`,
        label: `Open build: ${entry.name}`,
        hint: 'Generated — this browser only',
        run: () => withSearch((params) => {
          params.delete('mode');
          params.set('build', entry.id);
        }),
      });
    }

    // The account's recent library builds: open, guide, or arm on a map. Every one of these
    // carries a `lib:` id, which is the one kind of id that still resolves tomorrow.
    for (const build of libraryBuilds.slice(0, PALETTE_LIBRARY_LIMIT)) {
      list.push({
        id: `lib-open-${build.id}`,
        label: `Open build: ${build.name}`,
        hint: 'Library',
        run: () => navigate(openInBuild(libRef(build.id))),
      });
      list.push({
        id: `lib-place-${build.id}`,
        label: `Place on map: ${build.name}`,
        hint: 'World — armed in the Place tool',
        run: () => navigate(placeOnMap(build.id)),
      });
      list.push({
        id: `lib-guide-${build.id}`,
        label: `Open the build guide: ${build.name}`,
        hint: 'Printable, in a new tab',
        run: () => window.open(openGuide(libRef(build.id)), '_blank', 'noreferrer'),
      });
    }

    // Maps. Nothing here reaches into World mode's state: a map opens through `?world=`, the
    // same door the dashboard uses, and the draft is simply the mode with nothing named.
    list.push({
      id: 'world-draft',
      label: 'Open the map draft',
      hint: 'World — whatever was last sculpted in this browser',
      run: () => navigate(composeMap()),
    });
    for (const map of maps) {
      list.push({
        id: `map-${map.id}`,
        label: `Open map: ${map.name}`,
        hint: `World — ${map.sizeX}×${map.sizeZ}, ${map.placements} placed`,
        run: () => navigate(openMap(map.id)),
      });
    }

    if (mode === 'build') {
      for (const pack of STYLE_PACKS) {
        list.push({
          id: `style-${pack.id}`,
          label: `Restyle: ${pack.label}`,
          hint: pack.description,
          run: () => withSearch((params) => params.set('style', pack.id)),
        });
      }
      list.push({
        id: 'style-off',
        label: 'Restyle: original materials',
        hint: 'Back to the build’s own palette',
        run: () => withSearch((params) => params.delete('style')),
      });
      list.push({
        id: 'guide',
        label: 'Open the build guide',
        hint: 'Printable, layer by layer, in a new tab',
        run: () => {
          const params = new URLSearchParams(searchParams);
          params.delete('mode');
          window.open(`/guide?${params.toString()}`, '_blank', 'noreferrer');
        },
      });
    }

    if (workbench) {
      if (workbench.canSave) list.unshift({ id: 'file-save', label: workbench.saveLabel, hint: workbench.saveHint ?? 'Save the current document', run: () => void workbench.save() });
      list.unshift({ id: 'file-new', label: 'New document', hint: 'Start a new document in this workspace', run: workbench.create });
    }
    list.unshift(
      { id: 'file-open', label: 'Open Studio work', hint: 'Maps, builds, and browser floorplans', run: () => setFilesOpen(true) },
      { id: 'file-export', label: 'Export current view', hint: 'Schematic, program, guide, and game delivery', run: openOutput },
    );

    list.push(
      {
        id: 'go-library',
        label: 'Go to the library',
        hint: 'Saved builds',
        run: () => {
          if (confirmLeave('/library')) navigate('/library');
        },
      },
      {
        id: 'go-dashboard',
        label: 'Go to the dashboard',
        hint: 'Account, quota, paired Minecraft, maps',
        run: () => {
          if (confirmLeave('/dashboard')) navigate('/dashboard');
        },
      },
      {
        id: 'go-mod',
        label: 'Go to the Minecraft mod page',
        hint: 'Pairing and downloads',
        run: () => {
          if (confirmLeave('/mod')) navigate('/mod');
        },
      },
    );

    return list;
  }, [palette, mode, searchParams, navigate, setMode, maps, libraryBuilds, confirmLeave, presence.structureRowId, presence.hasPlan, workbench, openOutput]);

  // Resolved once per render rather than inside the JSX: mounting through a variable is what
  // keeps "which page" and "which pill is lit" reading from the same table.
  const Mounted = MODE_PAGES[mode];

  /**
   * Parameters in the address bar that this mode does not read.
   *
   * Mode switching now opens each editor's own return address. An external link can still
   * arrive with mixed parameters, such as `/studio?mode=world&build=lib:x`; this notice
   * explains that the build has not been placed on the map and offers the relevant actions.
   */
  const foreign = foreignParams(mode, searchParams);
  const foreignKey = `${mode}|${foreign.map((entry) => entry.key).join(',')}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const clearForeign = useCallback(() => {
    setSearchParams(
      (params) => {
        for (const entry of foreign) params.delete(entry.key);
        return params;
      },
      { replace: true },
    );
  }, [foreign, setSearchParams]);

  /**
   * The mode switch, handed to the app bar rather than floated over the page.
   *
   * Every mounted page renders `AppNav`, and `AppNav` renders whatever this provides in the
   * middle of the bar — so the pill is a flex child of the chrome instead of a fixed overlay
   * that used to land on Architecture's zoom controls and World's toolbar.
   */
  const placeBuild = searchParams.get('build');
  const documentName = mode === 'world'
    ? currentPresence?.project ?? 'Opening map…'
    : mode === 'arch'
      ? currentPresence?.structure ? `${currentPresence.structure} · floorplan` : 'Untitled floorplan'
      : currentPresence?.structure ?? 'Untitled build';
  const switcher = (
    <div className="studio__workbar">
      <nav className="studio__switch" aria-label="Studio workspaces">
        {STUDIO_MODES.map((id, index) => (
          <button
            key={id}
            type="button"
            data-mode={id}
            aria-pressed={mode === id}
            title={id === 'arch' && presence.hasPlan ? 'Open this build’s floorplan' : MODE_SPECS[id].hint}
            onClick={id === 'arch' && mode === 'build' ? openStructurePlan : () => setMode(id)}
          >
            <span className="studio__mode-number" aria-hidden="true">0{index + 1}</span>
            <span className="studio__mode-copy">
              <strong>{MODE_SPECS[id].label}</strong>
              <small>{id === 'world' ? 'Terrain & map' : id === 'build' ? 'Blocks & form' : 'Rooms & plan'}</small>
            </span>
          </button>
        ))}
      </nav>
      <div className="studio__document" title={documentName}>
        <span className="studio__document-label">Current work</span>
        <strong>{documentName}</strong>
        <span className={`studio__document-state${currentPresence?.dirty ? ' is-dirty' : ''}`}>
          {currentPresence?.dirty ? 'Changes pending' : 'Ready to work'}
        </span>
      </div>
      <div className="studio__file-actions" aria-label="Document actions">
        <button type="button" className="studio__file-action" onClick={() => workbench?.create()} disabled={!workbench} title="Start a new document in this workspace">New</button>
        <button type="button" className="studio__file-action" onClick={() => setFilesOpen(true)} title="Open maps, builds, and floorplans">Open</button>
        <button type="button" className="studio__file-action studio__file-action--save" onClick={() => { if (workbench?.canSave) void workbench.save(); }} disabled={!workbench?.canSave} title={workbench?.saveHint ?? 'Save the current document'}>{workbench?.saveLabel ?? 'Save'}</button>
        <button type="button" className="studio__file-action" onClick={openOutput} title="Export or send the current view">Export</button>
      </div>
      <div className="studio__global-actions" aria-label="Workspace actions">
        <button type="button" onClick={undoProject} disabled={!journal.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
        <button type="button" onClick={redoProject} disabled={!journal.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
        <button type="button" className="studio__search" onClick={() => setPalette(true)} title="Find a command (Ctrl+K)">
          <span>Find anything</span><kbd>Ctrl K</kbd>
        </button>
      </div>
      <nav className="studio__pane-switch" aria-label="Workspace view">
        {(['canvas', 'tools', 'project'] as const).map((pane) => (
          <button key={pane} type="button" aria-pressed={mobilePane === pane} onClick={() => setMobilePane(pane)}>
            {pane === 'canvas' ? (mode === 'arch' ? 'Plan' : 'Canvas') : pane === 'tools' ? 'Tools' : mode === 'arch' ? '3D preview' : mode === 'world' ? 'Contents' : 'Create & export'}
          </button>
        ))}
      </nav>
    </div>
  );

  return (
    <div className="studio" data-pane={mobilePane}>
      <NavCenterProvider node={switcher}>
        <Mounted key={`${mode}:${documentRevision}`} />
      </NavCenterProvider>

      {foreign.length > 0 && dismissed !== foreignKey && (
        <p className="studio__notice" role="status">
          {describeForeign(foreign, mode)}{' '}
          {mode === 'world' && placeBuild && (
            <>
              <button
                type="button"
                className="studio__notice-link"
                onClick={() =>
                  setSearchParams(
                    (params) => {
                      params.set('mode', 'world');
                      params.set('place', placeBuild.startsWith('lib:') ? placeBuild.slice(4) : placeBuild);
                      params.delete('build');
                      return params;
                    },
                    { replace: true },
                  )
                }
              >
                Place this build on the map
              </button>
              {' · '}
            </>
          )}
          <button type="button" className="studio__notice-link" onClick={() => setMode(foreign[0]!.owner)}>
            Switch to {MODE_SPECS[foreign[0]!.owner].label}
          </button>
          {' · '}
          <button type="button" className="studio__notice-link" onClick={clearForeign}>
            Clear
          </button>
          <button
            type="button"
            className="studio__notice-close"
            aria-label="Dismiss"
            onClick={() => setDismissed(foreignKey)}
          >
            ×
          </button>
        </p>
      )}

      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {filesOpen && <StudioFiles
        builds={libraryBuilds}
        maps={maps}
        plans={listSaved()}
        localBuilds={[...generatedBuilds(), ...muralBuilds(), ...importedBuilds()]}
        loading={filesLoading}
        signedIn={auth.status === 'signedIn'}
        onOpen={openFile}
        onClose={() => setFilesOpen(false)}
        onRename={renameFile}
        onDelete={deleteFile}
      />}
    </div>
  );
}

/** One sentence, in the visitor's terms rather than the query string's. */
function describeForeign(foreign: ReturnType<typeof foreignParams>, mode: StudioMode): string {
  const first = foreign[0]!;
  const what =
    first.key === 'build'
      ? 'The build in the address bar'
      : first.key === 'plan'
        ? 'The plan in the address bar'
        : first.key === 'place'
          ? 'The build waiting to be placed'
          : first.key === 'world'
            ? 'The map in the address bar'
            : `“${first.key}” in the address bar`;
  const owner = MODE_SPECS[first.owner].label;
  if (mode === 'world' && first.key === 'build') {
    return 'This build is not on the map yet.';
  }
  const tail =
    first.owner === 'world' && first.key === 'place'
      ? ' — nothing is placed here.'
      : '.';
  return `${what} belongs to ${owner} and is not open here${tail}`;
}
