/**
 * The planner: several saved builds arranged on one plot.
 *
 * Same frame as the editor — title bar, two docks, viewport, status bar — because it is the
 * same studio doing a different job. Left is where components come from (your library);
 * right is what you do to them and where the result goes. The composed plan is an ordinary
 * `VoxelGrid`, so the viewport, the layer range, the schematic export, "save to library" and
 * "send to game" are all literally the same components the editor uses.
 *
 * ## Dragging
 *
 * Pressing on a building selects it and starts a drag; the *outline* follows the cursor and
 * the composition is rebuilt once, on release. Composing walks every voxel of every component
 * and changes the grid's identity, which re-meshes the scene — doing that per frame is
 * unusable past a shed. The outline is what you are aiming with anyway.
 *
 * The drag runs on the ground plane at y=0 even for a placement that has been raised, so a
 * stacked building tracks the ground beneath it rather than the air it sits in. That is the
 * conventional behaviour for a ground gizmo and it stays predictable; following the cursor at
 * height would mean picking a different plane per placement mid-gesture.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PLAN_SIZE, placementBox } from '@craftmagic/core';
import { EditorCanvas, type Ground } from '../editor/EditorCanvas.js';
import { ExportBar } from '../editor/ExportBar.js';
import { Section } from '../editor/Section.js';
import { Shortcuts, PLAN_KEYS } from '../editor/Shortcuts.js';
import { Dimensions, StudioBar, StudioName } from '../editor/StudioBar.js';
import { ViewBar } from '../editor/ViewBar.js';
import { chunkCounts } from '../editor/mesher.js';
import { isWholeBuild, readLayerRange, type LayerRange } from '../editor/viewport.js';
import { useStudioChrome } from '../editor/useStudioChrome.js';
import type { VoxelHit } from '../editor/raycast.js';
import { useAuth } from '../library/auth.js';
import { listBuilds, type LibraryBuild } from '../library/library.js';
import { ComponentShelf } from './ComponentShelf.js';
import { PlacementList } from './PlacementList.js';
import { usePlan } from './usePlan.js';
import '../editor/editor.css';
import './plan.css';

export function PlanPage() {
  const auth = useAuth();
  const chrome = useStudioChrome();
  const plan = usePlan();

  const [hover, setHover] = useState<VoxelHit | null>(null);
  const [remaining, setRemaining] = useState(-1);
  const [layer, setLayer] = useState<LayerRange | null>(null);
  /**
   * The provisional position of the placement being dragged, in plan space.
   *
   * Mirrored into a ref because the gesture's end has to *read* it and then start a different
   * state update. Reading it inside a `setDragging` updater looked tidier and was wrong:
   * an updater must be pure, React runs it twice under StrictMode, and committing the move
   * from inside one is a state update during another component's render.
   */
  const [dragging, setDragging] = useState<{ id: string; at: { x: number; z: number } } | null>(null);
  const draggingRef = useRef<{ id: string; at: { x: number; z: number } } | null>(null);
  draggingRef.current = dragging;

  const { composed, selected } = plan;
  const grid = composed.grid;
  const topLayer = grid.size.y - 1;

  // --- the library, as a shelf of components ------------------------------

  const [library, setLibrary] = useState<{
    status: 'loading' | 'ready' | 'error';
    builds: LibraryBuild[];
  }>({ status: 'loading', builds: [] });

  useEffect(() => {
    if (auth.status === 'loading') return;
    if (auth.status === 'anonymous') {
      setLibrary({ status: 'ready', builds: [] });
      return;
    }
    let cancelled = false;
    listBuilds()
      .then((builds) => !cancelled && setLibrary({ status: 'ready', builds }))
      .catch(() => !cancelled && setLibrary({ status: 'error', builds: [] }));
    return () => {
      cancelled = true;
    };
  }, [auth.status]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const placement of plan.placements) {
      map.set(placement.sourceId, (map.get(placement.sourceId) ?? 0) + 1);
    }
    return map;
  }, [plan.placements]);

  // --- viewport bookkeeping ------------------------------------------------

  const effectiveClip = isWholeBuild(layer, topLayer) ? null : layer;

  const totalChunks = useMemo(() => {
    const counted = chunkCounts(grid.size);
    return counted.x * counted.y * counted.z;
  }, [grid.size]);

  /**
   * The selection outline, in *composed grid* coordinates.
   *
   * Plan space and grid space differ by `composed.offset` — compose trims the plot down to
   * what is occupied — so every box has to be shifted before it can be drawn. While a drag is
   * in flight the offset is frozen (nothing recomposes until release), which is what lets the
   * outline track the cursor without the ground sliding underneath it.
   */
  const region = useMemo(() => {
    if (!selected) return null;
    const box = plan.boxOf(selected);
    if (!box) return null;

    const at = dragging?.id === selected
      ? { x: dragging.at.x, y: box.min.y, z: dragging.at.z }
      : box.min;
    const size = {
      x: box.max.x - box.min.x,
      y: box.max.y - box.min.y,
      z: box.max.z - box.min.z,
    };

    return {
      min: {
        x: at.x - composed.offset.x,
        y: at.y - composed.offset.y,
        z: at.z - composed.offset.z,
      },
      max: {
        x: at.x - composed.offset.x + size.x,
        y: at.y - composed.offset.y + size.y,
        z: at.z - composed.offset.z + size.z,
      },
    };
  }, [selected, plan, dragging, composed.offset]);

  // --- the drag gesture ----------------------------------------------------

  /**
   * Which placement a picked voxel belongs to.
   *
   * Searched from the top of the stack down, because that is the order compose stamped them
   * in: where two overlap, the block you can see is the later one's, and clicking it has to
   * select the building you are looking at.
   */
  const placementAt = useCallback(
    (hit: VoxelHit): string | null => {
      const x = hit.x + composed.offset.x;
      const y = hit.y + composed.offset.y;
      const z = hit.z + composed.offset.z;

      for (let i = plan.placements.length - 1; i >= 0; i--) {
        const placement = plan.placements[i]!;
        const component = plan.components.get(placement.sourceId);
        if (!component) continue;
        const box = placementBox(placement, component);
        if (
          x >= box.min.x && x <= box.max.x &&
          y >= box.min.y && y <= box.max.y &&
          z >= box.min.z && z <= box.max.z
        ) {
          return placement.id;
        }
      }
      return null;
    },
    [plan.placements, plan.components, composed.offset],
  );

  /** Where the cursor sat inside the placement when the drag began, so it does not jump. */
  const [grab, setGrab] = useState<{ x: number; z: number }>({ x: 0, z: 0 });

  const onPress = useCallback(
    (hit: VoxelHit | null, ground: Ground) => {
      if (!hit) {
        // Pressing empty space deselects. It also must *not* take the gesture, or the camera
        // would stop orbiting anywhere off the build.
        plan.select(null);
        return false;
      }

      const id = placementAt(hit);
      if (!id) return false;

      plan.select(id);
      const box = plan.boxOf(id);
      if (!box) return false;

      setGrab({
        x: ground.x + composed.offset.x - box.min.x,
        z: ground.z + composed.offset.z - box.min.z,
      });
      setDragging({ id, at: { x: box.min.x, z: box.min.z } });
      return true;
    },
    [plan, placementAt, composed.offset],
  );

  const onDragMove = useCallback(
    (ground: Ground) => {
      setDragging((current) =>
        current
          ? {
              ...current,
              at: {
                x: Math.round(ground.x + composed.offset.x - grab.x),
                z: Math.round(ground.z + composed.offset.z - grab.z),
              },
            }
          : null,
      );
    },
    [grab, composed.offset],
  );

  const onDragEnd = useCallback(() => {
    const current = draggingRef.current;
    setDragging(null);
    if (!current) return;
    const box = plan.boxOf(current.id);
    // The only compose of the whole gesture.
    if (box) plan.moveTo(current.id, { x: current.at.x, y: box.min.y, z: current.at.z });
  }, [plan]);

  // --- keyboard ------------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;

      // Ctrl+D duplicates. Everything else here is unmodified, so a browser shortcut is
      // never swallowed by accident.
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === 'd' && selected) {
          event.preventDefault();
          plan.duplicate(selected);
        }
        return;
      }
      if (event.altKey) return;

      const step = event.shiftKey ? 5 : 1;

      switch (event.key) {
        case 'ArrowLeft':
          if (!selected) return;
          event.preventDefault();
          plan.nudge(selected, { x: -step });
          return;
        case 'ArrowRight':
          if (!selected) return;
          event.preventDefault();
          plan.nudge(selected, { x: step });
          return;
        case 'ArrowUp':
          if (!selected) return;
          event.preventDefault();
          plan.nudge(selected, { z: -step });
          return;
        case 'ArrowDown':
          if (!selected) return;
          event.preventDefault();
          plan.nudge(selected, { z: step });
          return;
        case 'PageUp':
          if (!selected) return;
          event.preventDefault();
          plan.nudge(selected, { y: step });
          return;
        case 'PageDown':
          if (!selected) return;
          event.preventDefault();
          plan.nudge(selected, { y: -step });
          return;
        case 'r':
        case 'R':
          if (!selected) return;
          event.preventDefault();
          plan.turn(selected, 1);
          return;
        case 'Delete':
        case 'Backspace':
          if (!selected) return;
          event.preventDefault();
          plan.remove(selected);
          return;
        case 'Escape':
          plan.select(null);
          return;
        case 'f':
        case 'F':
          event.preventDefault();
          chrome.sendView('frame');
          return;
        case 'g':
        case 'G':
          event.preventDefault();
          chrome.setDisplay({ ...chrome.display, grid: !chrome.display.grid });
          return;
        case '\\':
          event.preventDefault();
          setLayer(null);
          return;
        case '?':
          event.preventDefault();
          chrome.setShortcuts(!chrome.shortcuts);
          return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [plan, selected, chrome]);

  // A layer range written for a tall plan must not survive into a short one.
  useEffect(() => {
    setLayer((current) => readLayerRange(
      current === null ? null : String(current.max),
      current === null ? null : String(current.min),
      topLayer,
    ));
  }, [topLayer]);

  const empty = plan.placements.length === 0;
  const missing = plan.composed.errors.length;

  return (
    <div
      className="editor plan"
      data-remaining={remaining}
      data-placements={plan.placements.length}
      data-left={chrome.docks.left}
      data-right={chrome.docks.right}
    >
      <StudioBar
        identity={
          <>
            <StudioName name={plan.name} onRename={plan.rename} />
            <span className="badge badge--plan">Plan</span>
            <span className="badge">
              {plan.placements.length} placed
            </span>
            <Dimensions size={grid.size} blockCount={composed.blockCount} />
          </>
        }
        leftOpen={chrome.docks.left}
        rightOpen={chrome.docks.right}
        leftLabel="Components"
        rightLabel="Plan"
        onToggleLeft={() => chrome.toggleDock('left')}
        onToggleRight={() => chrome.toggleDock('right')}
        onShowShortcuts={() => chrome.setShortcuts(true)}
      />

      <aside className="hud dock dock--left" aria-label="Components" hidden={!chrome.docks.left}>
        <Section id="plan-shelf" title="Components" summary={`${library.builds.length}`}>
          <ComponentShelf
            builds={library.builds}
            counts={counts}
            loading={plan.loading}
            failed={plan.failed}
            onPlace={plan.add}
            signedIn={auth.status === 'signedIn'}
            status={library.status}
          />
        </Section>

        <p className="plan__hint">
          Every build you save to your library is a component. Place it as many times as you
          like — drag it on the plot, <kbd>R</kbd> to turn it, arrows to nudge.
        </p>
      </aside>

      <main className="viewport">
        <EditorCanvas
          grid={grid}
          paletteColors={plan.colors}
          paletteFlags={plan.flags}
          layerClip={effectiveClip}
          display={chrome.display}
          view={chrome.view}
          region={region}
          onHover={setHover}
          onPress={onPress}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onProgress={setRemaining}
        />

        {empty && (
          <div className="viewport__empty">
            <p className="viewport__empty-title">An empty plot</p>
            <p className="viewport__empty-body">
              {auth.status === 'signedIn'
                ? 'Pick a component on the left to place it here.'
                : 'Sign in to use your saved builds as components.'}
            </p>
          </div>
        )}

        {dragging && (
          <div className="plan__drag" aria-live="off">
            {dragging.at.x}, {dragging.at.z}
          </div>
        )}
      </main>

      <aside className="hud dock dock--right" aria-label="Plan" hidden={!chrome.docks.right}>
        <Section
          id="plan-placements"
          title="Placed"
          summary={`${plan.placements.length}`}
        >
          <PlacementList
            placements={plan.placements}
            components={plan.components}
            selected={selected}
            onSelect={plan.select}
            onMove={plan.moveTo}
            onTurn={plan.turn}
            onDuplicate={plan.duplicate}
            onRemove={plan.remove}
          />
          {plan.placements.length > 0 && (
            <button type="button" className="plan__clear" onClick={plan.clear}>
              Clear the plot
            </button>
          )}
        </Section>

        <Section
          id="plan-stats"
          title="Details"
          summary={`${grid.size.x}×${grid.size.y}×${grid.size.z} · ${composed.blockCount.toLocaleString()}`}
          defaultOpen={false}
        >
          <dl className="hud__stats">
            <dt>Plan</dt>
            <dd>{plan.name}</dd>
            <dt>Size</dt>
            <dd>
              {grid.size.x}×{grid.size.y}×{grid.size.z}
            </dd>
            <dt>Blocks</dt>
            <dd>{composed.blockCount.toLocaleString()}</dd>
            <dt>Palette</dt>
            <dd>{grid.palette.length}</dd>
            <dt>Placed</dt>
            <dd>{plan.placements.length}</dd>
            <dt>Components</dt>
            <dd>{counts.size}</dd>
            <dt>Overlaps</dt>
            <dd>{composed.overlaps.toLocaleString()}</dd>
            <dt>Plot</dt>
            <dd>
              {PLAN_SIZE.x}×{PLAN_SIZE.y}×{PLAN_SIZE.z}
            </dd>
          </dl>

          {composed.overlaps > 0 && (
            <p className="plan__note">
              Overlapping is allowed — a later placement wins where it has a block. This number
              is here because it is also what an accident looks like.
            </p>
          )}
        </Section>

        {missing > 0 && (
          <ul className="hud__issues">
            {composed.errors.map((error) => (
              <li key={error} className="issue--error">
                {error}
              </li>
            ))}
          </ul>
        )}

        <ExportBar
          grid={grid}
          program={null}
          programHint="A plan is an arrangement of finished builds, so no single program describes it."
          name={plan.name}
          detached
          guideHref={null}
          blockCount={composed.blockCount}
        />

        <p className="plan__note">
          Saving a plan puts it in your library as one build — which makes it a component you
          can place inside another plan. <Link to="/library">Library →</Link>
        </p>
      </aside>

      <ViewBar
        topLayer={topLayer}
        range={layer}
        onRange={setLayer}
        display={chrome.display}
        onDisplay={chrome.setDisplay}
        onView={chrome.sendView}
        hover={hover}
        hoverBlock={hover ? hoverName(plan, composed.offset, hover) : null}
        toolVerb="select"
        remaining={remaining}
        totalChunks={totalChunks}
      />

      {chrome.shortcuts && (
        <Shortcuts groups={PLAN_KEYS} onClose={() => chrome.setShortcuts(false)} />
      )}
    </div>
  );
}

/**
 * What the hover readout says on this surface.
 *
 * The editor names the block; here the useful answer is *which building* you are pointing at,
 * because that is what a click is about to select and a drag is about to move.
 */
function hoverName(
  plan: ReturnType<typeof usePlan>,
  offset: { x: number; y: number; z: number },
  hit: VoxelHit,
): string {
  const x = hit.x + offset.x;
  const y = hit.y + offset.y;
  const z = hit.z + offset.z;

  for (let i = plan.placements.length - 1; i >= 0; i--) {
    const placement = plan.placements[i]!;
    const component = plan.components.get(placement.sourceId);
    if (!component) continue;
    const box = placementBox(placement, component);
    if (
      x >= box.min.x && x <= box.max.x &&
      y >= box.min.y && y <= box.max.y &&
      z >= box.min.z && z <= box.max.z
    ) {
      return component.name;
    }
  }
  return 'Ground';
}
