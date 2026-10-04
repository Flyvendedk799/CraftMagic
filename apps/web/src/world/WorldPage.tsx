/**
 * World mode: the third tier, where saved builds become the parts of something much larger.
 *
 * Build makes a structure. Architecture makes what is inside one. World is where both arrive
 * as components and stand on ground you sculpt — a spawn hub, a map, an environment.
 *
 * The layout is a split, and the split is the design. Terrain is sculpted from above, in the
 * map, because a brush in perspective paints an ellipse that changes size with distance and
 * hides whatever is behind the hill you are raising. The result is checked in 3D, in the same
 * renderer the editor uses. That is the same division of labour Architecture mode draws
 * between its plan and its model, and for the same reason.
 *
 * What the 3D shows is an *area* — a rectangle of regions, of which one region is the ordinary
 * case. A region is the unit a world is delivered in, which is a fact about the engine's block
 * cap and not about what anyone wants to look at: the seam between two regions is exactly
 * where a hub's big builds fall, so a view that could only ever hold one was a view in which a
 * boundary could never be checked. `materializeArea` builds the union in one pass, so a
 * building on a seam is drawn once and whole rather than twice and clipped, and the navigator
 * over the map is how you say which rectangle. Delivery is untouched: the send run still walks
 * `regionsOf` one region at a time and knows nothing about any of this.
 *
 * A world can never be one `VoxelGrid` — 1024×160×1024 is 320 MB and 40,960 mesh chunks — so
 * what this page edits is a *description*: a heightfield, a sparse overlay for the caves and
 * overhangs a heightfield cannot express, and a list of placements. `materializeArea` turns
 * any piece of it into an ordinary grid on demand, which is both what the preview renders and
 * what the mod will be sent. That same arithmetic is why the viewer has a cell budget rather
 * than a region limit: the y extent of an area is the union of its parts', so one spire makes
 * a whole rectangle tall, and four flat regions genuinely are cheaper than one containing it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useReportPresence } from '../studio/presence.js';
import { useRegisterWorkbench } from '../studio/workbench.js';
import { composeMap, openInBuild, libRef, openMap, openPlan } from '../studio/handoff.js';
import {
  OVERLAY_AIR,
  createWorld,
  decodeOverlayChunk,
  encodeOverlayChunk,
  emptyOverlayChunk,
  normalizeWorld,
  overlayCellIndex,
  overlayChunkFor,
  overlayChunkKey,
  areaCount,
  areaLabel,
  clampArea,
  materializeArea,
  regionCount,
  regionStats,
  regionsOf,
  resizeWorld,
  spanFrom,
  worldId,
  type Overlay,
  type Prefab,
  type Region,
  type RegionArea,
  type TerrainBrush,
  type WorldPlacement,
} from '@craftmagic/core';
import { AppNav } from '../shell/AppNav.js';
import { useAuth } from '../library/auth.js';
import { useComponents, type ShelfEntry } from '../library/components.js';
import { pathToRoad } from './guides.js';
import { offerPlot, plotFromView } from './plotContext.js';
import { localStore, remoteStore } from './api.js';
import { RegionNavigator, type RegionCell } from './RegionNavigator.js';
import { areaHolds, coverArea, fitArea, regionOfColumn, spanOf } from './viewArea.js';
import { useAgents } from '../agent/useAgents.js';
import { runOf, sendRegion, waitForJob } from './send.js';
import { WorldMap } from './WorldMap.js';
import { WorldPreview } from './WorldPreview.js';
import { TerrainPanel } from './TerrainPanel.js';
import { PlacementsPanel } from './PlacementsPanel.js';
import { WorldPanel } from './WorldPanel.js';
import { useRegionGrid } from './useRegionGrid.js';
import { useWorldSession } from './useWorldSession.js';
import { ExportBar } from '../editor/ExportBar.js';
import { registerImportedBuild } from '../editor/builds.js';
import { openGuide } from '../studio/handoff.js';
import { isTextEntry } from '../studio/undoKeys.js';
import { useZoomUndo } from '../studio/useZoomUndo.js';
import { WORLD_SHORTCUTS } from './shortcuts.js';
import { ShortcutHelp } from '../editor/ShortcutHelp.js';
import { WORLD_TOOLS, dropCorner, placementFootprint, turnedAboutCentre, type WorldTool } from './toolset.js';
import './world.css';

export function WorldPage() {
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const worldParam = searchParams.get('world');
  const [openingWorld, setOpeningWorld] = useState(false);
  const [worldOpenError, setWorldOpenError] = useState<string | null>(null);
  const [worldOpenAttempt, setWorldOpenAttempt] = useState(0);
  // Signed in, worlds live on the account and open from any machine; signed out they stay
  // in this browser. Memoised on the status alone so a re-render does not look like a
  // different store and re-list on every keystroke.
  const store = useMemo(
    () => (auth.status === 'signedIn' ? remoteStore : localStore),
    [auth.status],
  );
  const historyId = `/studio?mode=world${worldParam ? `&world=${encodeURIComponent(worldParam)}` : ''}`;
  const session = useWorldSession(undefined, store, historyId);
  const { doc } = session;
  const mapHasSavedRow = session.saved.some((entry) => entry.id === doc.id);
  const canSaveMap = !openingWorld && !worldOpenError && (!worldParam || doc.id === worldParam) && (session.dirty || !mapHasSavedRow);
  const navigate = useNavigate();
  useReportPresence({
    mode: 'world',
    project: doc.name || 'Map',
    structure: null,
    structureRowId: null,
    hasPlan: false,
    plan: false,
    dirty: session.dirty,
    dirtyLabel: 'the map',
  });

  const [tool, setTool] = useState<WorldTool>('raise');
  const [brush, setBrush] = useState<TerrainBrush>({ radius: 12, strength: 2, falloff: 'smooth' });
  const [stratum, setStratum] = useState(0);
  const [targetY, setTargetY] = useState(doc.settings.seaLevel);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; z: number; height: number; stratum: number } | null>(null);
  /**
   * Which regions the 3D check shows.
   *
   * A rectangle, not a region. A region is the unit a world is *delivered* in — a size the
   * block cap decides — and the seam between two of them is exactly where a hub's big builds
   * fall, so a view that could only ever hold one was a view that could never show a boundary
   * being got right. `materializeArea` builds the union in one pass, which is what makes a
   * building on a seam draw once and whole rather than twice and clipped.
   *
   * It follows the work by default. Sculpting at the middle of a 512² map while the viewport
   * renders the corner region is exactly the disconnection this mode exists to avoid — you get
   * a 3D view that is technically correct and never shows what you just did. Naming an area in
   * the navigator stops the following, because at that point the user has said which one they
   * mean.
   */
  const [requestedView, setRequestedView] = useState<RegionArea>({ rx0: 0, rz0: 0, rx1: 0, rz1: 0 });
  const [pinned, setPinned] = useState(false);
  const [showRegions, setShowRegions] = useState(true);
  const [showPreview, setShowPreview] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const worldOpenEpoch = useRef(0);
  const saveMap = useCallback(async () => {
    const ok = await session.save();
    setNotice(ok ? 'Map saved.' : 'Could not save map. Please try again.');
    return ok;
  }, [session]);
  const newWorld = useCallback(() => {
    if (session.dirty && !window.confirm('Start a new map? Unsaved changes in this map will be replaced.')) return;
    worldOpenEpoch.current++;
    session.open(createWorld());
    navigate(composeMap(), { replace: true });
  }, [session, navigate]);
  useRegisterWorkbench('world', {
    commands: WORLD_TOOLS.map(spec=>({id:`tool-${spec.id}`,label:`Tool: ${spec.label}`,hint:spec.hint,category:'Tools',shortcut:spec.key,checked:tool===spec.id,run:()=>setTool(spec.id)})),
    saveLabel: 'Save map',
    saving: session.saving,
    saveError: session.saveError,
    save: async () => { if (!await saveMap()) throw new Error('Could not save this map. Your changes are still here; retry when storage or the connection is available.'); },
    canSave: !session.loading && !session.saving && canSaveMap,
    saveHint: 'Save this named map to your account, or to this browser while signed out.',
    create: newWorld,
  });
  const [help, setHelp] = useState(false);
  const [sending, setSending] = useState(false);
  /**
   * True while a terrain gesture is in flight, and the 3D view watches it.
   *
   * `revision` bumps on every pointer move — that is how an in-place terrain write reaches
   * React at all — so without this the preview re-materialises the whole region, two million
   * cells of it, sixty times a second for the length of a drag. The map stays live because
   * repainting the heightfield is one pass over the columns; the 3D catches up on release,
   * which is when you look at it.
   */
  const [sculpting, setSculpting] = useState(false);
  /**
   * The component the Place tool will drop next.
   *
   * Picking one from the shelf arms it and switches to Place, so putting forty lamps down a
   * street is forty clicks rather than forty round trips to the shelf. It stays armed until
   * something else is picked, which is what makes a hub buildable at all.
   */
  const [armed, setArmed] = useState<ShelfEntry | null>(null);
  /** Which way the armed component will face when it lands — R turns it before the drop. */
  const [armedTurns, setArmedTurns] = useState<WorldPlacement['turns']>(0);
  const agents = useAgents();

  /**
   * Notices clear themselves.
   *
   * They used to stay until the next one replaced them, so "Opened “Hub”." sat in the stage bar
   * for the rest of the session and a fresh notice was indistinguishable from a stale one.
   * Long ones — a send in progress, an error — get longer, and a send keeps its notice until
   * it is done, because that one is a progress bar.
   */
  useEffect(() => {
    if (!notice || sending) return;
    const timer = setTimeout(() => setNotice(null), Math.min(14_000, 4_000 + notice.length * 60));
    return () => clearTimeout(timer);
  }, [notice, sending]);

  /**
   * Which builds the map needs blocks for.
   *
   * Memoised on the placement ids rather than on the placements, so dragging a building across
   * the map does not look like a reason to re-fetch every component on it.
   */
  const referenced = useMemo(
    () => doc.placements.map((placement) => placement.buildId),
    // `revision` is the honest dependency: the document is mutated in place, so its identity
    // does not change when a placement is added.
    [doc, session.revision],
  );
  const library = useComponents(referenced);

  // Keep the denormalised name and footprint on each placement in step with the library. They
  // exist so a restored world can draw before the network answers; leaving them stale after it
  // does would make the map disagree with the 3D view about how big a building is.
  useEffect(() => {
    if (library.catalogue.size === 0) return;
    let changed = false;
    const next = doc.placements.map((placement) => {
      const component = library.catalogue.get(placement.buildId);
      if (!component) return placement;
      const { x, y, z } = component.size;
      if (placement.w === x && placement.h === y && placement.d === z && placement.name === component.name) {
        return placement;
      }
      changed = true;
      return { ...placement, w: x, h: y, d: z, name: component.name };
    });
    // Assigned rather than committed: refreshing a cached footprint is not an edit the user
    // made, and it must not land on the undo stack between two things they did.
    if (changed) {
      doc.placements = next;
      session.touch();
    }
  }, [library.catalogue, doc, session]);

  useZoomUndo('world', session.historyId, session.undo, session.redo, !session.loading && !openingWorld && !worldOpenError);

  // The keyboard, through a ref so the listener is bound once and always sees this render's
  // selection and tool. Ignored while a text field has focus, or typing a world's name would
  // silently change the tool. Suppressed under the shortcut sheet, which has its own Escape.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (help) return;
      keys.current(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [help]);

  /** Drop a component, centred on a column. */
  const placeAt = useCallback(
    (entry: ShelfEntry, cx: number, cz: number) => {
      // The same corner the ghost on the map was drawn at, turned the way it was drawn.
      const turned = armedTurns === 1 || armedTurns === 3;
      const footprint = turned ? { w: entry.d, d: entry.w } : { w: entry.w, d: entry.d };
      const corner = dropCorner(cx, cz, footprint, doc.settings.size);
      const placement: WorldPlacement = {
        id: worldId('p'),
        buildId: entry.id,
        x: corner.x,
        z: corner.z,
        y: doc.settings.seaLevel,
        anchor: 'surface',
        turns: armedTurns,
        name: entry.name,
        w: entry.w,
        h: entry.h,
        d: entry.d,
      };
      session.commitPlacements([...doc.placements, placement]);
      setSelected(placement.id);
      void library.load(entry.id);
    },
    [doc, session, library, armedTurns],
  );

  /** Picking from the shelf arms the component and hands the pointer the Place tool. */
  const armComponent = useCallback((entry: ShelfEntry) => {
    setArmed(entry);
    setArmedTurns(0);
    setTool('place');
  }, []);

  /**
   * The two ways in from elsewhere: `?world=<id>` opens a named map, `?place=<row>` arms a
   * saved build in the Place tool. Both are how the dashboard, the library and the other two
   * modes hand work to this one — see `studio/handoff.ts`. A named map stays in the address
   * bar so a refresh and a copied link reopen the same document; the local draft is preferred
   * when it is already that map and may contain newer edits.
   */
  const placeParam = searchParams.get('place');
  const plotParam = searchParams.get('plot');
  // Dashboard's launcher carries the typed prompt through World into Build. Kept until a
  // building is opened — dropping it on arrival would lose the text before the editor seeds.
  const promptParam = searchParams.get('prompt');

  const dropParam = useCallback(
    (key: string) => {
      setSearchParams(
        (params) => {
          params.delete(key);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const openBuild = useCallback(
    (buildId: string) => {
      const href = openInBuild(libRef(buildId));
      if (!promptParam) {
        navigate(href);
        return;
      }
      const url = new URL(href, window.location.origin);
      url.searchParams.set('prompt', promptParam);
      dropParam('prompt');
      navigate(`${url.pathname}?${url.searchParams.toString()}`);
    },
    [navigate, promptParam, dropParam],
  );

  useEffect(() => {
    if (plotParam !== '1' || session.loading) return;
    // Frame the centre of the map — the 3D view defaults to region 0,0 at the corner, and
    // the notice claimed a central plot was selected without ever moving there.
    const counts = regionCount(doc.settings);
    const rx = Math.floor((counts.x - 1) / 2);
    const rz = Math.floor((counts.z - 1) / 2);
    setPinned(true);
    setRequestedView(spanFrom(doc.settings, rx, rz, 1));
    setNotice(`One plot is selected in the middle of ${doc.name}. Place a build, or open one and draw its plan.`);
    dropParam('plot');
  }, [plotParam, session.loading, doc.name, doc.settings, dropParam]);

  useEffect(() => {
    // Not before the draft has been read: `useWorldSession` assigns the stored draft over the
    // live document when it lands, and a map opened a moment earlier would be overwritten.
    // Not before auth has settled either, or the store is the wrong one.
    if (!worldParam || session.loading || auth.status === 'loading' || doc.id === worldParam) return;
    let live = true;
    const epoch = ++worldOpenEpoch.current;
    setOpeningWorld(true); setWorldOpenError(null);
    void store.load(worldParam).then((opened) => {
      if (!live || epoch !== worldOpenEpoch.current) return;
      setOpeningWorld(false);
      if (opened) {
        session.open(opened);
        setNotice(`Opened “${opened.name}”.`);
      } else {
        setWorldOpenError('This map could not be opened. It may have been deleted or belong to another account.');
        setNotice(
          auth.status === 'signedIn'
            ? 'That map could not be opened — it may have been deleted, or belong to another account.'
            : 'That map is on an account. Sign in to open it; the draft in this browser is shown instead.',
        );
      }
    }).catch((error: unknown) => {
      if (live && epoch === worldOpenEpoch.current) setWorldOpenError(error instanceof Error ? error.message : 'Could not open this world.');
    }).finally(() => { if (live && epoch === worldOpenEpoch.current) setOpeningWorld(false); });
    return () => { live = false; };
    // `session` is memoised on every change; only the id, the store and the loading flag decide
    // whether an open is due.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldParam, store, session.loading, auth.status, doc.id, worldOpenAttempt]);

  // A first save may mint a server id. Give that named map a durable address immediately;
  // the open effect above sees it is already on screen and does not reload over live edits.
  useEffect(() => {
    if (session.loading || !mapHasSavedRow || worldParam || !doc.id) return;
    setSearchParams((params) => {
      params.set('world', doc.id);
      return params;
    }, { replace: true });
  }, [session.loading, mapHasSavedRow, worldParam, doc.id, setSearchParams]);

  useEffect(() => {
    if (!placeParam) return;
    if (library.status === 'loading') return;
    if (library.status === 'signedOut') {
      setNotice('Sign in to place saved builds on the map. The terrain tools work without an account.');
      dropParam('place');
      return;
    }
    if (library.status === 'error') {
      setNotice('Your library could not be reached, so nothing was armed to place.');
      dropParam('place');
      return;
    }
    const entry = library.shelf.find((candidate) => candidate.id === placeParam);
    if (entry) {
      armComponent(entry);
      void library.load(entry.id);
      setNotice(`“${entry.name}” is armed — click the map to drop it.`);
    } else {
      setNotice('That build is not in your library, so it cannot be placed here.');
    }
    dropParam('place');
    // `library` is a fresh object every render; the shelf and its status are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeParam, library.status, library.shelf, armComponent, dropParam]);

  const updatePlacement = useCallback(
    (id: string, patch: Partial<WorldPlacement>) => {
      session.commitPlacements(
        doc.placements.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
      );
    },
    [doc, session],
  );

  const removePlacement = useCallback(
    (id: string) => {
      const target = doc.placements.find((entry) => entry.id === id);
      session.commitPlacements(doc.placements.filter((entry) => entry.id !== id));
      setSelected(null);
      if (target) setNotice(`Removed “${target.name || 'the building'}” — Ctrl+Z puts it back.`);
    },
    [doc, session],
  );

  const duplicatePlacement = useCallback(
    (id: string) => {
      const source = doc.placements.find((entry) => entry.id === id);
      if (!source) return;
      // Offset by its own width, so the copy is visibly a second building rather than one
      // sitting exactly on top of the first.
      const box = placementFootprint(source);
      const x = Math.min(doc.settings.size.x - 1, source.x + box.w + 2);
      const copy = { ...source, id: worldId('p'), x };
      session.commitPlacements([...doc.placements, copy]);
      setSelected(copy.id);
    },
    [doc, session],
  );

  const rotatePlacement = useCallback(
    (id: string, by: 1 | -1 = 1) => {
      const placement = doc.placements.find((entry) => entry.id === id);
      if (!placement) return;
      updatePlacement(id, turnedAboutCentre(placement, by));
    },
    [doc, updatePlacement],
  );

  /**
   * The document's keys.
   *
   * World had digits and `?` and nothing else, so every verb on a selected building was a
   * trip to the bottom of the right-hand dock — there was no way to delete one from the
   * keyboard, turn it, or nudge it a block. These are the bindings every other editor in the
   * studio, and every map editor outside it, has taught people to expect. The map owns the
   * view's keys (Space, F, + and −); this owns the ones that change the document.
   */
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = (event: KeyboardEvent) => {
    if (isTextEntry(event.target)) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;

    if (mod && !event.altKey) {
      const lower = key.toLowerCase();
      if (lower === 's') {
        // Without this the browser offers to save the page as HTML.
        event.preventDefault();
        if (canSaveMap) {
          void saveMap();
        } else {
          setNotice('Nothing to save — every change is already kept.');
        }
      } else if (lower === 'd' && selected) {
        event.preventDefault();
        duplicatePlacement(selected);
      }
      return;
    }
    if (event.altKey) return;

    if (key === '?') {
      event.preventDefault();
      setHelp(true);
      return;
    }
    if (key === 'Escape') {
      // One step back at a time: a disarmed Place tool first, then the selection.
      if (armed) {
        setArmed(null);
        setTool('select');
      } else if (selected) {
        setSelected(null);
      }
      return;
    }
    if ((key === 'Delete' || key === 'Backspace') && selected) {
      event.preventDefault();
      removePlacement(selected);
      return;
    }
    if (key === 'r' || key === 'R') {
      const by = event.shiftKey ? -1 : 1;
      // The thing about to be dropped turns first: with Place armed, the ghost is what you
      // are looking at.
      if (tool === 'place' && armed) {
        setArmedTurns((turns) => ((((turns + by) % 4) + 4) % 4) as WorldPlacement['turns']);
      } else if (selected) {
        rotatePlacement(selected, by);
      }
      event.preventDefault();
      return;
    }
    if (key.startsWith('Arrow') && selected) {
      // Not when a control that owns the arrows has focus — the navigator's grid walks its
      // cells with them and says so by preventing the default.
      if (event.defaultPrevented || event.target instanceof HTMLInputElement) return;
      const placement = doc.placements.find((entry) => entry.id === selected);
      if (!placement) return;
      event.preventDefault();
      const step = event.shiftKey ? 8 : 1;
      const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
      const dz = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      updatePlacement(selected, {
        x: Math.max(0, Math.min(doc.settings.size.x - 1, placement.x + dx)),
        z: Math.max(0, Math.min(doc.settings.size.z - 1, placement.z + dz)),
      });
      return;
    }
    // Brush size and strength, without leaving the map. `{` and `}` are what Shift turns the
    // brackets into on most layouts; the code check covers the ones where it does not.
    if (event.code === 'BracketLeft' || event.code === 'BracketRight' || key === '[' || key === ']' || key === '{' || key === '}') {
      event.preventDefault();
      const up = event.code === 'BracketRight' || key === ']' || key === '}';
      if (event.shiftKey || key === '{' || key === '}') {
        setBrush((current) => ({
          ...current,
          strength: Math.round(Math.max(0.1, Math.min(16, current.strength + (up ? 0.5 : -0.5))) * 10) / 10,
        }));
      } else {
        setBrush((current) => {
          const step = Math.max(1, Math.round(current.radius * 0.2));
          return { ...current, radius: Math.max(0, Math.min(128, current.radius + (up ? step : -step))) };
        });
      }
      return;
    }
    const match = WORLD_TOOLS.find((entry) => entry.key === key);
    if (match) {
      event.preventDefault();
      setTool(match.id);
    }
  };

  /**
   * A live drag of a placement.
   *
   * Written straight into the array rather than committed, so a drag across the map is one
   * undo instead of one per pointer move. `onCommitPlacements` from the map closes it.
   */
  const movePlacement = useCallback(
    (id: string, x: number, z: number, free: boolean) => {
      const placement = doc.placements.find((entry) => entry.id === id);
      if (!placement) return;
      // Snap to a 4-block grid so two buildings can share a spacing without typing it. Alt
      // lets go of the grid for the one that has to sit against something that is not on it.
      const step = free ? 1 : 4;
      const snap = (value: number, limit: number) => Math.max(0, Math.min(limit, Math.round(value / step) * step));
      placement.x = snap(x, doc.settings.size.x - 1);
      placement.z = snap(z, doc.settings.size.z - 1);
      setSculpting(true);
      session.touch();
    },
    [doc, session],
  );

  /**
   * Cut air into the overlay along a stroke.
   *
   * This is the tool that makes the terrain more than a lumpy field. A heightfield cannot say
   * "solid here, hollow beneath" — so a tunnel, a cave mouth or an overhang lives in the
   * sparse 16³ overlay, where cell state is tri-state and forced air is a first-class answer
   * rather than the absence of one.
   *
   * Whole chunks are snapshotted for undo rather than cells. A carve writes dense runs through
   * a handful of chunks and each one RLE-encodes to a few bytes, so the snapshot is smaller
   * than the cells it stands for — and immune to the ordering questions two overlapping
   * strokes would otherwise raise.
   */
  const carve = useCallback(
    (columns: Array<{ x: number; z: number }>, top: number, depth: number) => {
      if (columns.length === 0) return;
      const touched = new Set<string>();
      const before: Overlay = {};
      const hot = new Map<string, Uint16Array>();

      const cellsFor = (key: string) => {
        let cells = hot.get(key);
        if (cells) return cells;
        const existing = doc.overlay[key];
        if (!touched.has(key)) {
          touched.add(key);
          if (existing) before[key] = existing;
        }
        cells = existing ? decodeOverlayChunk(existing) : new Uint16Array(16 * 16 * 16);
        hot.set(key, cells);
        return cells;
      };

      for (const { x, z } of columns) {
        for (let y = top; y > top - depth; y--) {
          const chunk = overlayChunkFor(x, y, z);
          const key = overlayChunkKey(chunk.cx, chunk.cy, chunk.cz);
          // World coordinates: `overlayCellIndex` takes the modulo itself, and doing it here
          // as well would fold a negative y onto the wrong cell of the right chunk.
          cellsFor(key)[overlayCellIndex(x, y, z)] = OVERLAY_AIR;
        }
      }

      const after: Overlay = {};
      for (const [key, cells] of hot) {
        const encoded = encodeOverlayChunk(cells, emptyOverlayChunk().palette);
        doc.overlay[key] = encoded;
        after[key] = encoded;
      }

      session.commitCarve(before, after, [...touched]);
    },
    [doc, session],
  );

  /**
   * Materialise one region and hand it to the mod.
   *
   * The run has an order that only the server can enforce: region 0 is placed by the player
   * and reports where it landed, and every region after it is measured from that report — so
   * a send that is not the first will be refused until the first has finished. That refusal
   * is surfaced as the server words it rather than flattened into "could not send", because
   * "place the first region and I will line the rest up behind it" is a thing the user can
   * act on.
   */
  /** The paired world to build into, or a sentence saying why there is not one. */
  const onlineAgent = useCallback(() => {
    const online = agents.agents.find((agent) => agent.online);
    if (online) return online;
    setNotice(
      agents.needsAccount
        ? 'Sign in and pair a Minecraft world to send regions to it.'
        : 'No paired Minecraft world is online. Open the Minecraft mod page to pair one.',
    );
    return null;
  }, [agents]);

  const send = useCallback(
    async (region: Region) => {
      const online = onlineAgent();
      if (!online) return;

      const run = runOf(doc);
      const index = run.findIndex((entry) => entry.key === region.key);
      if (index < 0) return;

      setSending(true);
      setNotice(`Materialising region ${region.rx},${region.rz}…`);
      try {
        const { blocks } = await sendRegion(doc, region, index, run.length, online.id, library.catalogue);
        setNotice(
          index === 0
            ? `Region ${region.rx},${region.rz} is on its way — ${blocks.toLocaleString()} blocks. ` +
              'Place it in game; where it lands is where the rest of the map is measured from.'
            : `Region ${region.rx},${region.rz} queued — ${blocks.toLocaleString()} blocks.`,
        );
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      } finally {
        setSending(false);
      }
    },
    [doc, onlineAgent, library.catalogue],
  );

  /**
   * Send the whole map, one region at a time, waiting for each.
   *
   * This is the thing the module header claimed to do and did not: `runOf` existed, nothing
   * ever walked it, and the user had to watch game chat for a region to finish and then come
   * back and click the next one. Sequential is not a choice — an agent takes one job at a
   * time, and the server refuses region *n* until region 0 has reported where it landed — so
   * the loop is mostly waiting, and what it is really for is doing the waiting for you.
   *
   * A failure stops the run. Carrying on past a region that did not land would leave a hole
   * in the middle of a map and keep going as though nothing had happened.
   */
  const sendAll = useCallback(async () => {
    const online = onlineAgent();
    if (!online) return;

    const run = runOf(doc);
    if (run.length > 1) {
      const go = window.confirm(
        `Send all ${run.length} regions? The first one is placed by hand in Minecraft, and the rest queue behind it. A full map can take hours. Cancel to send only the region on screen instead.`,
      );
      if (!go) return;
    }
    setSending(true);
    try {
      for (let index = 0; index < run.length; index++) {
        const region = run[index]!;
        setNotice(`Region ${index + 1} of ${run.length} — materialising ${region.rx},${region.rz}…`);
        const { jobId, blocks } = await sendRegion(doc, region, index, run.length, online.id, library.catalogue);

        if (index === 0) {
          setNotice(
            `Region 1 of ${run.length} sent — ${blocks.toLocaleString()} blocks. Place it in game: ` +
              'where it lands is where the rest of the map is measured from.',
          );
        }

        const outcome = await waitForJob(jobId, (placed, total) => {
          setNotice(
            `Region ${index + 1} of ${run.length} — ${placed.toLocaleString()} of ${total.toLocaleString()} blocks`,
          );
        });

        if (!outcome.ok) {
          setNotice(
            `Stopped at region ${index + 1} of ${run.length}: ${outcome.error ?? outcome.status}.`,
          );
          return;
        }
      }
      setNotice(`All ${run.length} regions built.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }, [doc, onlineAgent, library.catalogue]);

  const resize = useCallback(
    (size: { x: number; z: number }) => {
      session.commitSettings((current) => resizeWorld(current, size).world);
      setNotice(`Resized to ${size.x}×${size.z}.`);
    },
    [session],
  );

  const patchSettings = useCallback(
    (patch: { seaLevel?: number; minY?: number; maxY?: number; regionSize?: number }) => {
      session.commitSettings((current) =>
        normalizeWorld({ ...current, settings: { ...current.settings, ...patch } }),
      );
    },
    [session],
  );

  /**
   * Every region's own reading, computed once for the two panels that want it.
   *
   * The navigator shades its cells by block count and marks the ones past a cap; the Regions
   * list prints the same numbers as rows. They used to be two walks over the same map, which
   * on a 1024² world is two passes over a million columns per revision.
   */
  const regions = useMemo(() => regionsOf(doc.settings), [doc.settings, session.revision]);
  const regionTable = useMemo(
    () => regions.map((entry) => regionStats(doc, entry.rx, entry.rz, entry)),
    // The document is mutated in place, so `revision` is the honest dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, session.revision, regions],
  );

  /**
   * The same numbers folded down to one per region *column*.
   *
   * A world taller than a build is cut into stacked y-slabs, so `regionsOf` returns two or
   * more entries for every `rx,rz` — which the delivery run needs and a grid of cells does
   * not. Reading the first of them would shade a region by its bottom 160 blocks and miss
   * whatever stands in the slab above, so the slabs are summed and the caps OR-ed.
   */
  const regionCells = useMemo<RegionCell[]>(() => {
    const byColumn = new Map<string, RegionCell>();
    for (const entry of regionTable) {
      const key = `${entry.rx},${entry.rz}`;
      const cell = byColumn.get(key);
      const over = !entry.withinSizeCap || !entry.withinBlockCap;
      if (cell) {
        cell.blocks += entry.blocks;
        cell.placements = Math.max(cell.placements, entry.placements);
        cell.overCap ||= over;
      } else {
        byColumn.set(key, {
          rx: entry.rx,
          rz: entry.rz,
          blocks: entry.blocks,
          placements: entry.placements,
          overCap: over,
        });
      }
    }
    return [...byColumn.values()];
  }, [regionTable]);

  /**
   * The area on screen, materialised once and shared.
   *
   * Two areas, not one, and the difference is the whole of the budget. `requestedView` is the
   * rectangle the user asked for; `view` is what fits. A 3×3 of tall regions is 40 million
   * cells and an 80 MB allocation, so a request that big is answered with the largest
   * rectangle inside it that fits rather than with an error — and the navigator marks the
   * regions that were dropped, so the panel never silently disagrees with the button just
   * pressed.
   *
   * World had no export at all before this grid existed: `materializeRegion` could turn any
   * part of a map into an ordinary grid, and `send.ts` proved it, but the only way to reach
   * that grid was the send path — which returns early unless a paired Minecraft world is
   * online. So a world was the one thing in the studio you could not get blocks out of without
   * a running game server.
   */
  const windows = useMemo(
    () => coverArea(doc, requestedView),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, session.revision, requestedView],
  );
  const [windowIndex, setWindowIndex] = useState(0);
  const shownIndex = Math.min(windowIndex, Math.max(0, windows.length - 1));
  useEffect(() => {
    setWindowIndex(0);
  }, [requestedView]);
  useEffect(() => {
    if (windows.length < 2) return;
    const timer = setInterval(() => {
      setWindowIndex((current) => (current + 1) % windows.length);
    }, 2500);
    return () => clearInterval(timer);
  }, [windows]);
  const view = windows[shownIndex] ?? fitArea(doc, requestedView).area;
  const inViewCount = areaCount(view);

  const built = useRegionGrid({
    doc,
    revision: session.revision,
    area: view,
    catalogue: library.catalogue,
    live: !sculpting,
  });

  /**
   * Name an area and stop following.
   *
   * Every way into the view goes through here — the navigator, a placement's Find, a region's
   * Find, a Send. Clamped rather than trusted: a resize can leave a stored rectangle hanging
   * off the edge of a map that just got smaller.
   */
  const showArea = useCallback(
    (area: RegionArea) => {
      setPinned(true);
      setRequestedView(clampArea(doc.settings, area));
    },
    [doc.settings],
  );

  /**
   * Pull the request back onto the map when the map gets smaller.
   *
   * `fitArea` clamps what is *shown*, so the 3D view is never wrong — but the request is what
   * the navigator draws its anchor from and what the span buttons grow from, and a shrink from
   * 1024² to 256² leaves a rectangle sitting off the edge of a grid that no longer has those
   * cells. Corrected here rather than inside the clamp, because the request is state and the
   * fit is a derivation of it.
   */
  useEffect(() => {
    const clamped = clampArea(doc.settings, requestedView);
    if (
      clamped.rx0 !== requestedView.rx0 || clamped.rz0 !== requestedView.rz0 ||
      clamped.rx1 !== requestedView.rx1 || clamped.rz1 !== requestedView.rz1
    ) {
      setRequestedView(clamped);
    }
  }, [doc.settings, session.revision, requestedView]);

  /**
   * What the export controls say they cover.
   *
   * Three separate facts, and leaving any of them out has bitten before: which regions, that
   * it is not the whole map, and whether the result is small enough to be a legal build. The
   * last one is not hypothetical even for a single region — a full 128² region of ordinary
   * ground is over half a million blocks, which is already past the cap.
   */
  const exportName = `${doc.name} — region${inViewCount === 1 ? '' : 's'} ${areaLabel(view)}`;
  const scopeNote =
    `Covers the ${inViewCount === 1 ? 'region' : `${inViewCount} regions`} on screen ` +
    `(${areaLabel(view)}) — not the whole map. ` +
    (built.stats.withinSizeCap && built.stats.withinBlockCap
      ? ''
      : 'This area is past what one build may hold, so a schematic or a send may be refused; ' +
        'view a single region to export it on its own. ') +
    'To deliver every region in order, use “Send the whole map” under Regions.';

  /** Frame one region, keeping whatever span is in use. */
  const showRegion = useCallback(
    (rx: number, rz: number) => showArea(spanFrom(doc.settings, rx, rz, spanOf(requestedView))),
    [showArea, doc.settings, requestedView],
  );

  return (
    /* The `data-` attributes are the same affordance `.editor` uses for `data-remaining`: a
       headless driver has no way to read React state, and asserting on rendered numbers means
       asserting on wording. These are the facts a test needs and a human never sees. */
    <div
      className="world"
      data-columns={doc.settings.size.x * doc.settings.size.z}
      data-placements={doc.placements.length}
      data-history={session.historyDepth}
      data-revision={session.revision}
      data-draft={session.draftRevision}
      data-dirty={session.dirty}
      data-tool={tool}
      data-view={areaLabel(view)}
      data-view-regions={inViewCount}
      data-hover-x={hover?.x}
      data-hover-z={hover?.z}
      data-hover-height={hover?.height}
      data-hover-stratum={hover?.stratum}
    >
      <AppNav current="world" />
      {worldParam && (worldOpenError || doc.id !== worldParam) && <div className="workspace-document-state" role={worldOpenError ? 'alert' : 'status'}>
        <h2>{worldOpenError ? 'This world could not be opened' : 'Opening world…'}</h2>
        <p>{worldOpenError ?? 'Loading the saved terrain and placements.'}</p>
        {worldOpenError && <div><button onClick={() => setWorldOpenAttempt(value => value + 1)}>Retry opening world</button><button onClick={() => navigate(composeMap())}>Open browser draft</button></div>}
      </div>}

      <div className="world__body">
        {/* Two docks, each a card with its own sticky title. They used to be bare columns of
            sections sitting straight on the page background, which is what made this mode
            read as a different application from the two it shares a switcher with — every
            other surface in the studio puts its controls on a panel. */}
        <aside className="world__dock world__dock--left">
          <header className="world__dock-head">
            <span className="studio__eyebrow">WORLD / TOOLS</span>
            <h1 className="ui-dock__title">World</h1>
            <p className="ui-dock__sub">Sculpt the ground, then place what you have built</p>
          </header>
          <div className="world__dock-body">
          <TerrainPanel
            settings={doc.settings}
            tool={tool}
            onTool={setTool}
            brush={brush}
            onBrush={setBrush}
            stratum={stratum}
            onStratum={setStratum}
            targetY={targetY}
            onTargetY={setTargetY}
            onShowHelp={() => setHelp(true)}
          />
          </div>
        </aside>

        <main className="world__stage">
          {/* The stage's own strip of chrome. One `ui-bar` group rather than five loose
              controls wearing whatever the global button rule gave them: history, then what
              the map draws, then what the 3D view is following. The notice is a chip beside
              them rather than a run of text in the middle of the row, because it comes and
              goes and a row that reflows every time something is saved is unusable. */}
          <div className="world__stage-bar">
            <div className="ui-bar">
              <label className="ui-check" title="Draw the region grid the map ships in">
                <input type="checkbox" checked={showRegions} onChange={(e) => setShowRegions(e.target.checked)} />
                Regions
              </label>
              <label className="ui-check" title="Check the region you are working in, in 3D">
                <input type="checkbox" checked={showPreview} onChange={(e) => setShowPreview(e.target.checked)} />
                3D
              </label>
              {pinned && (
                <>
                  <span className="ui-bar__sep" aria-hidden="true" />
                  <button
                    type="button"
                    className="ui-btn"
                    onClick={() => setPinned(false)}
                    title="Let the 3D view follow where you are working again"
                  >
                    Following off · {areaLabel(view)}
                  </button>
                </>
              )}
            </div>

            {notice && (
              <button
                type="button"
                className="world__notice"
                role="status"
                title={`${notice} — click to dismiss`}
                onClick={() => setNotice(null)}
              >
                {notice}
              </button>
            )}
            {session.saveError && <span className="world__save-error" role="alert">{session.saveError}</span>}

            <span className="world__stage-spacer" />
            <span className="world__stage-size" title="Map extent, in blocks">
              {doc.settings.size.x}×{doc.settings.size.z}
            </span>
          </div>

          <div className="world__split" data-preview={showPreview ? 'true' : 'false'}>
            {/* The map and the navigator share a positioning context, because the navigator is
                anchored to the map's own top-right corner and not to the stage's. */}
            <div className="world__mapwrap">
            <WorldMap
              doc={doc}
              revision={session.revision}
              tool={tool}
              brush={brush}
              stratum={stratum}
              targetY={targetY}
              showRegions={showRegions}
              showPlacements
              selected={selected}
              onSelect={setSelected}
              onOpen={(placement) => openBuild(placement.buildId)}
              onRotate={(placement) => rotatePlacement(placement.id)}
              onDuplicate={(placement) => duplicatePlacement(placement.id)}
              onRemove={(placement) => removePlacement(placement.id)}
              armed={armed ? { name: armed.name, w: armed.w, d: armed.d, turns: armedTurns } : null}
              onPickHeight={(y) => {
                setTargetY(y);
                setNotice(`${tool === 'carve' ? 'Ceiling' : 'Target height'} set to y ${y}.`);
              }}
              onPickStratum={(index) => {
                setStratum(index);
                setNotice(`Painting ${doc.settings.strata[index]?.label ?? 'that ground'}.`);
              }}
              onMovePlacement={movePlacement}
              onCommitPlacements={() => {
                setSculpting(false);
                session.commitPlacements([...doc.placements]);
              }}
              onBeginStroke={() => {
                setSculpting(true);
                return session.beginStroke();
              }}
              onEndStroke={(stroke) => {
                setSculpting(false);
                session.endStroke(stroke);
              }}
              onTouch={session.touch}
              onCarve={carve}
              onPlaceAt={(x, z) => {
                if (armed) placeAt(armed, x, z);
                else setNotice('Pick a component on the right, then click the map to drop it.');
              }}
              onEdited={(x, z) => {
                if (pinned) return;
                const at = regionOfColumn(doc.settings.regionSize, x, z);
                // Only when the work has left the rectangle. Re-anchoring on every stroke would
                // make a 2×2 view slide sideways the moment a brush crossed a boundary, which
                // is the opposite of what viewing regions together is for.
                if (areaHolds(requestedView, at.rx, at.rz)) return;
                setRequestedView(spanFrom(doc.settings, at.rx, at.rz, spanOf(requestedView)));
              }}
              onHover={setHover}
              view={view}
            />

            {/* Over the map rather than over the 3D view, because the cells *are* the map: a
                navigator beside the thing it indexes is a legend, and one floating on the
                render it drives is a remote control for a screen you cannot see. */}
            <RegionNavigator
              settings={doc.settings}
              cells={regionCells}
              view={view}
              requested={requestedView}
              onView={showArea}
              following={!pinned}
              onFollowing={(follow) => setPinned(!follow)}
            />
            </div>

            {showPreview && (
              <WorldPreview
                built={built}
                area={view}
                stream={{ index: shownIndex, total: windows.length }}
              />
            )}
          </div>
        </main>

        <aside className="world__dock world__dock--right">
          <header className="world__dock-head">
            <span className="studio__eyebrow">WORLD / PROJECT</span>
            <h2 className="ui-dock__title">Contents</h2>
            <p className="ui-dock__sub">What stands on the map, and how it reaches the game</p>
          </header>
          <div className="world__dock-body">
          <PlacementsPanel
            doc={doc}
            library={library}
            selected={selected}
            onSelect={setSelected}
            onAdd={armComponent}
            // Only while Place is the tool: an armed component under Select said "click the map to
            // drop it" over a map where a click would select instead.
            armed={tool === 'place' ? armed?.id ?? null : null}
            onUpdate={updatePlacement}
            onRemove={removePlacement}
            onDuplicate={duplicatePlacement}
            onRotate={(id, by) => rotatePlacement(id, by)}
            onFrame={(placement) => {
              const at = regionOfColumn(doc.settings.regionSize, placement.x, placement.z);
              showRegion(at.rx, at.rz);
              setSelected(placement.id);
            }}
            onOpenBuild={(placement) => openBuild(placement.buildId)}
            onDrawPlan={(placement) => {
              // Snapshot the window that holds this building, not whichever window the 3D
              // view happens to be cycling through — otherwise its plot falls outside the
              // grid and the plan preview cannot replace it or show its surroundings.
              const at = regionOfColumn(doc.settings.regionSize, placement.x, placement.z);
              const target =
                windows.find((entry) => areaHolds(entry, at.rx, at.rz)) ??
                fitArea(doc, { rx0: at.rx, rz0: at.rz, rx1: at.rx, rz1: at.rz }).area;
              const prefabs = new Map<string, Prefab>();
              for (const [id, component] of library.catalogue) prefabs.set(id, component.prefab);
              const snapshot = materializeArea(doc, target, prefabs);
              offerPlot(plotFromView(snapshot.grid, target, doc.settings.regionSize, placement));
              // Always open this build's plan link — Architecture creates a blank layout on
              // the same row when none is saved yet, instead of an untitled disconnected draft.
              navigate(openPlan(placement.buildId));
            }}
            onPathToRoad={(placement) => {
              const path = doc.settings.strata.findIndex((entry) => entry.id === 'path');
              if (path < 0) {
                setNotice('This map has no path ground to paint.');
                return;
              }
              const stroke = session.beginStroke();
              const cells = pathToRoad(doc, placement);
              const width = doc.settings.size.x;
              for (const cell of cells) {
                const index = cell.z * width + cell.x;
                if (index < 0 || index >= doc.terrain.strata.length) continue;
                stroke.note(doc.terrain, index);
                doc.terrain.strata[index] = path;
              }
              session.endStroke(stroke);
              setNotice(`A path runs from the door of ${placement.name || 'the building'} toward the road.`);
            }}
          />

          <WorldPanel
            doc={doc}
            revision={session.revision}
            regions={regions}
            stats={regionTable}
            view={view}
            saved={session.saved}
            dirty={session.dirty}
            onRename={session.rename}
            onResize={resize}
            onSettings={patchSettings}
            onOpen={(id) => {
              if (session.dirty && !window.confirm('Open another map? Unsaved changes in this map will be replaced.')) return;
              worldOpenEpoch.current++;
              navigate(openMap(id));
            }}
            onRemove={(id) => {
              if (!window.confirm('Delete this saved map? This cannot be undone.')) return;
              void session.remove(id).then((ok) => {
                if (ok && doc.id === id) {
                  worldOpenEpoch.current++;
                  session.open(createWorld());
                  navigate(composeMap(), { replace: true });
                }
                setNotice(ok ? 'Map deleted.' : 'Could not delete that map.');
              });
            }}
            onNew={newWorld}
            onFrameRegion={(rx, rz) => showRegion(rx, rz)}
            onSendRegion={(region) => {
              // Named exactly, not framed with whatever span is in use: a send is about one
              // region, and the list row you pressed is the one it is about.
              showArea({ rx0: region.rx, rz0: region.rz, rx1: region.rx, rz1: region.rz });
              void send(region);
            }}
            onSendAll={() => void sendAll()}
            sending={sending}
          />

          {/* The same export bar Build and Architecture use, over exactly what is on screen.

              A world had no way out except a paired, online Minecraft server — the one thing in
              the studio you could not get blocks out of. It is scoped to what the 3D view shows
              rather than to the whole map on purpose: that grid *is* an ordinary build, which is
              why the schematic writer, the guide and the library all take one without knowing
              worlds exist, and a whole map is not a thing any of those formats can hold.

              What you see is what you get, spans included: exporting the view rather than a
              region means a 2×2 downloads as the quad you were looking at, seams and all. The
              note says which regions that is, and says so again when the area is past what a
              single build may hold — the same warning the Regions list already gives a region
              that is too big on its own. */}
          <ExportBar
            grid={built.grid}
            program={built.program}
            name={exportName}
            detached={false}
            // The guide is reached by URL and rebuilt from a build id, and a materialised area
            // has none until asked for. Asking registers its blocks the way an opened `.schem`
            // is registered — a voxel build this browser remembers — and opens the guide on that
            // id. Done on click rather than on every stroke, or the store would fill with
            // drafts of the same hill.
            guideHref={null}
            onGuide={() => {
              const id = registerImportedBuild(exportName, built.grid, 'region');
              window.open(openGuide(id), '_blank', 'noreferrer');
            }}
            scopeNote={scopeNote}
            sendTitle={inViewCount === 1 ? 'Send this region to game' : 'Send this view to game'}
            blockCount={built.stats.blocks}
          />
          </div>
        </aside>
      </div>

      {help && (
        <ShortcutHelp
          groups={WORLD_SHORTCUTS}
          foot="Sculpt from above; the 3D view beside the map is where you check it."
          onClose={() => setHelp(false)}
        />
      )}
    </div>
  );
}

/** Kept for the studio shell's mount table, which imports pages by name. */
export default WorldPage;
