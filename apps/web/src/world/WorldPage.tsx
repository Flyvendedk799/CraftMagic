/**
 * World mode: the third tier, where saved builds become the parts of something much larger.
 *
 * Build makes a structure. Architecture makes what is inside one. World is where both arrive
 * as components and stand on ground you sculpt — a spawn hub, a map, an environment.
 *
 * The layout is a split, and the split is the design. Terrain is sculpted from above, in the
 * map, because a brush in perspective paints an ellipse that changes size with distance and
 * hides whatever is behind the hill you are raising. The result is checked in 3D, in the same
 * renderer the editor uses, one region at a time. That is the same division of labour
 * Architecture mode draws between its plan and its model, and for the same reason.
 *
 * A world can never be one `VoxelGrid` — 1024×160×1024 is 320 MB and 40,960 mesh chunks — so
 * what this page edits is a *description*: a heightfield, a sparse overlay for the caves and
 * overhangs a heightfield cannot express, and a list of placements. `materializeRegion` turns
 * any piece of it into an ordinary grid on demand, which is both what the preview renders and
 * what the mod will be sent.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  regionCount,
  resizeWorld,
  worldId,
  type Overlay,
  type TerrainBrush,
  type WorldPlacement,
} from '@craftmagic/core';
import { AppNav } from '../shell/AppNav.js';
import { useAuth } from '../library/auth.js';
import { useComponents, type ShelfEntry } from '../library/components.js';
import { localStore, remoteStore } from './api.js';
import { useAgents } from '../agent/useAgents.js';
import { runOf, sendRegion } from './send.js';
import { WorldMap } from './WorldMap.js';
import { WorldPreview } from './WorldPreview.js';
import { TerrainPanel } from './TerrainPanel.js';
import { PlacementsPanel } from './PlacementsPanel.js';
import { WorldPanel } from './WorldPanel.js';
import { useWorldSession } from './useWorldSession.js';
import { WORLD_TOOLS, type WorldTool } from './toolset.js';
import './world.css';

export function WorldPage() {
  const auth = useAuth();
  // Signed in, worlds live on the account and open from any machine; signed out they stay
  // in this browser. Memoised on the status alone so a re-render does not look like a
  // different store and re-list on every keystroke.
  const store = useMemo(
    () => (auth.status === 'signedIn' ? remoteStore : localStore),
    [auth.status],
  );
  const session = useWorldSession(undefined, store);
  const { doc } = session;

  const [tool, setTool] = useState<WorldTool>('raise');
  const [brush, setBrush] = useState<TerrainBrush>({ radius: 12, strength: 2, falloff: 'smooth' });
  const [stratum, setStratum] = useState(0);
  const [targetY, setTargetY] = useState(doc.settings.seaLevel);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; z: number; height: number; stratum: number } | null>(null);
  /**
   * Which region the 3D check shows.
   *
   * It follows the work by default. Sculpting at the middle of a 512² map while the viewport
   * renders the corner region is exactly the disconnection this mode exists to avoid — you get
   * a 3D view that is technically correct and never shows what you just did. Choosing a region
   * from the list pins it, because at that point the user has said which one they mean.
   */
  const [region, setRegion] = useState({ rx: 0, rz: 0 });
  const [pinned, setPinned] = useState(false);
  const [showRegions, setShowRegions] = useState(true);
  const [showPreview, setShowPreview] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
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
  const agents = useAgents();

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

  // Number-row tool shortcuts, matching the editor and Architecture. Ignored while a text
  // field has focus, or typing a world's name would silently change the tool.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          if (event.shiftKey) session.redo();
          else session.undo();
        }
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const match = WORLD_TOOLS.find((entry) => entry.key === event.key);
      if (match) {
        event.preventDefault();
        setTool(match.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [session]);

  /** Drop a component, centred on a column. */
  const placeAt = useCallback(
    (entry: ShelfEntry, cx: number, cz: number) => {
      const placement: WorldPlacement = {
        id: worldId('p'),
        buildId: entry.id,
        // Centred on the point rather than cornered at it: you aim a building at where you
        // want it to stand, not at where its north-west corner should go.
        x: Math.max(0, Math.min(doc.settings.size.x - 1, Math.round(cx - entry.w / 2))),
        z: Math.max(0, Math.min(doc.settings.size.z - 1, Math.round(cz - entry.d / 2))),
        y: doc.settings.seaLevel,
        anchor: 'surface',
        turns: 0,
        name: entry.name,
        w: entry.w,
        h: entry.h,
        d: entry.d,
      };
      session.commitPlacements([...doc.placements, placement]);
      setSelected(placement.id);
      void library.load(entry.id);
    },
    [doc, session, library],
  );

  /** Picking from the shelf arms the component and hands the pointer the Place tool. */
  const armComponent = useCallback((entry: ShelfEntry) => {
    setArmed(entry);
    setTool('place');
  }, []);

  const updatePlacement = useCallback(
    (id: string, patch: Partial<WorldPlacement>) => {
      session.commitPlacements(
        doc.placements.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
      );
    },
    [doc, session],
  );

  /**
   * A live drag of a placement.
   *
   * Written straight into the array rather than committed, so a drag across the map is one
   * undo instead of one per pointer move. `onCommitPlacements` from the map closes it.
   */
  const movePlacement = useCallback(
    (id: string, x: number, z: number) => {
      const placement = doc.placements.find((entry) => entry.id === id);
      if (!placement) return;
      placement.x = Math.max(0, Math.min(doc.settings.size.x - 1, x));
      placement.z = Math.max(0, Math.min(doc.settings.size.z - 1, z));
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
  const send = useCallback(
    async (rx: number, rz: number) => {
      const online = agents.agents.find((agent) => agent.online);
      if (!online) {
        setNotice(
          agents.needsAccount
            ? 'Sign in and pair a Minecraft world to send regions to it.'
            : 'No paired Minecraft world is online. Open the Minecraft mod page to pair one.',
        );
        return;
      }

      const run = runOf(doc);
      const step = run.find((entry) => entry.rx === rx && entry.rz === rz);
      if (!step) return;

      setSending(true);
      setNotice(`Materialising region ${rx},${rz}…`);
      try {
        const { blocks } = await sendRegion(
          doc, rx, rz, step.index, step.total, online.id, library.catalogue,
        );
        setNotice(
          step.index === 0
            ? `Region ${rx},${rz} is on its way — ${blocks.toLocaleString()} blocks. Place it in game; ` +
              'where it lands is where the rest of the map is measured from.'
            : `Region ${rx},${rz} queued — ${blocks.toLocaleString()} blocks.`,
        );
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      } finally {
        setSending(false);
      }
    },
    [doc, agents, library.catalogue],
  );

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

  const counts = regionCount(doc.settings);
  const clampedRegion = {
    rx: Math.min(region.rx, counts.x - 1),
    rz: Math.min(region.rz, counts.z - 1),
  };

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
      data-tool={tool}
      data-hover-x={hover?.x}
      data-hover-z={hover?.z}
      data-hover-height={hover?.height}
      data-hover-stratum={hover?.stratum}
    >
      <AppNav current="world" />

      <div className="world__body">
        <aside className="world__dock world__dock--left">
          <header className="world__dock-head">
            <h1 className="hud__title">World</h1>
            <p className="hud__sub">Sculpt the ground, then place what you have built</p>
          </header>
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
            hover={hover}
          />
        </aside>

        <main className="world__stage">
          <div className="world__stage-bar">
            <button type="button" className="world__mini" onClick={session.undo} disabled={!session.canUndo}>
              Undo
            </button>
            <button type="button" className="world__mini" onClick={session.redo} disabled={!session.canRedo}>
              Redo
            </button>
            <label className="world__toggle">
              <input type="checkbox" checked={showRegions} onChange={(e) => setShowRegions(e.target.checked)} />
              Regions
            </label>
            <label className="world__toggle">
              <input type="checkbox" checked={showPreview} onChange={(e) => setShowPreview(e.target.checked)} />
              3D
            </label>
            {pinned && (
              <button type="button" className="world__mini" onClick={() => setPinned(false)} title="Let the 3D view follow where you are working">
                Unpin region {region.rx},{region.rz}
              </button>
            )}
            <span className="world__stage-spacer" />
            {notice && <span className="world__notice">{notice}</span>}
            <span className="world__stage-size">
              {doc.settings.size.x}×{doc.settings.size.z}
            </span>
          </div>

          <div className="world__split" data-preview={showPreview ? 'true' : 'false'}>
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
                setRegion({
                  rx: Math.floor(x / doc.settings.regionSize),
                  rz: Math.floor(z / doc.settings.regionSize),
                });
              }}
              onHover={setHover}
            />

            {showPreview && (
              <WorldPreview
                doc={doc}
                revision={session.revision}
                region={clampedRegion}
                catalogue={library.catalogue}
                live={!sculpting}
              />
            )}
          </div>
        </main>

        <aside className="world__dock world__dock--right">
          <PlacementsPanel
            doc={doc}
            library={library}
            selected={selected}
            onSelect={setSelected}
            onAdd={armComponent}
            armed={armed?.id ?? null}
            onUpdate={updatePlacement}
            onRemove={(id) => {
              session.commitPlacements(doc.placements.filter((entry) => entry.id !== id));
              setSelected(null);
            }}
            onDuplicate={(id) => {
              const source = doc.placements.find((entry) => entry.id === id);
              if (!source) return;
              // Offset by its own width, so the copy is visibly a second building rather than
              // one sitting exactly on top of the first.
              const copy = { ...source, id: worldId('p'), x: source.x + source.w + 2 };
              session.commitPlacements([...doc.placements, copy]);
              setSelected(copy.id);
            }}
            onFrame={(placement) => {
              setPinned(true);
              setRegion({
                rx: Math.floor(placement.x / doc.settings.regionSize),
                rz: Math.floor(placement.z / doc.settings.regionSize),
              });
              setSelected(placement.id);
            }}
          />

          <WorldPanel
            doc={doc}
            revision={session.revision}
            saved={session.saved}
            dirty={session.dirty}
            onRename={session.rename}
            onResize={resize}
            onSettings={patchSettings}
            onSave={session.save}
            onOpen={(id) => {
              void store.load(id).then((opened) => {
                if (opened) session.open(opened);
              });
            }}
            onRemove={session.remove}
            onNew={() => session.open(createWorld())}
            onFrameRegion={(rx, rz) => {
              setPinned(true);
              setRegion({ rx, rz });
            }}
            onSendRegion={(rx, rz) => {
              setPinned(true);
              setRegion({ rx, rz });
              void send(rx, rz);
            }}
            sending={sending}
          />
        </aside>
      </div>
    </div>
  );
}

/** Kept for the studio shell's mount table, which imports pages by name. */
export default WorldPage;
