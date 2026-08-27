/**
 * The plan view: a top-down, block-ruled drawing surface.
 *
 * This is the layouter's equivalent of the level editor engine's orthographic viewport
 * (`initViewport`/`renderViewport`/`hitTest` in `src/customMaps/levelEditor.js`), rebuilt as
 * SVG rather than a Three.js ortho camera. The engine's *behaviour* is what was worth porting
 * — snap every gesture to the grid, hit-test small things before big ones, draw the ghost of
 * what the next click would make — and none of that needs a GPU. SVG buys crisp lines at any
 * zoom, real text for room labels, and hit testing that costs nothing because we do it
 * ourselves against the plan rather than against a scene graph.
 *
 * The 3D preview lives next door and is deliberately not this. A plan is the view you *draw*
 * in, because it is the only one where two walls a storey apart are unambiguous; the model is
 * the view you check in. Trying to do both in one viewport is what makes most voxel tools
 * exhausting for interiors.
 *
 * All drawing happens in plan units inside one transformed group, so zoom and pan are two
 * numbers rather than a coordinate conversion at every call site. Strokes carry
 * `vector-effect="non-scaling-stroke"` so a wall stays legible at 4px per block and does not
 * become a slab at 40 — with one exception: the grid patterns measure their strokes in blocks,
 * because a non-scaling stroke inside a `<pattern>` resolves against the pattern tile and
 * renders the one-block grid as a field of dots.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Face } from '@craftmagic/core';
import {
  clampRectToSite,
  hitTest,
  itemFootprint,
  rectBottom,
  rectFromPoints,
  rectRight,
  roomRects,
  snapAperture,
  snapRoomRect,
  stairFootprint,
  wallRuns,
  type Point,
} from './geometry.js';
import {
  createColumn,
  createDoor,
  createOpening,
  createPlatform,
  createRoom,
  createStair,
  createWall,
  createWindow,
  type LayoutPlan,
  type PlanItem,
  type Rect,
} from './plan.js';
import type { LayoutToolId } from './toolset.js';

/** Zoom range, in screen pixels per block. Below 3 a wall is invisible; above 48 is a mosaic. */
const MIN_SCALE = 3;
const MAX_SCALE = 48;

export interface PlanCanvasProps {
  plan: LayoutPlan;
  floorIndex: number;
  tool: LayoutToolId;
  selectedId: string | null;
  /** Rooms validation could not walk to, drawn hatched. */
  unreachable: ReadonlySet<string>;
  /** Draw the storey below in outline, so things can be lined up through the floor. */
  showBelow: boolean;
  onSelect: (id: string | null) => void;
  /** A gesture is starting: record the plan so the whole gesture is one undo. */
  onBeginGesture: () => void;
  onCreate: (item: PlanItem) => void;
  /** An intermediate frame of a drag — applied without touching history. */
  onPreview: (item: PlanItem) => void;
  onNotice: (message: string | null) => void;
  /** Reported so the page's readout can say what is under the pointer. */
  onHover?: (at: Point | null) => void;
}

type Drag =
  | { kind: 'draw'; from: Point; to: Point }
  /**
   * `marked` is whether this gesture has claimed its undo entry yet.
   *
   * Claiming it on pointer-down would be simpler and is what the engine this is ported from
   * does, but it makes *selecting* something undoable: click a room to look at it, and the
   * next Ctrl+Z spends itself restoring a state identical to the one on screen. So the entry
   * is taken at the first movement that actually changes the plan, which still gives one undo
   * per gesture and gives none to a gesture that changed nothing.
   */
  | { kind: 'move'; id: string; origin: PlanItem; from: Point; to: Point; marked: boolean }
  | { kind: 'resize'; id: string; origin: Rect; corner: Corner; to: Point; marked: boolean }
  | { kind: 'pan'; fromClient: Point; view: { ox: number; oz: number } };

type Corner = 'nw' | 'ne' | 'sw' | 'se';

export function PlanCanvas({
  plan,
  floorIndex,
  tool,
  selectedId,
  unreachable,
  showBelow,
  onSelect,
  onBeginGesture,
  onCreate,
  onPreview,
  onNotice,
  onHover,
}: PlanCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState(() => ({ scale: 14, ox: 0, oz: 0 }));
  const [drag, setDrag] = useState<Drag | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);

  const floor = plan.floors[floorIndex];
  const items = useMemo(() => floor?.items ?? [], [floor]);
  const below = floorIndex > 0 ? plan.floors[floorIndex - 1]?.items ?? [] : [];
  const runs = useMemo(() => wallRuns(items, plan.wallThickness), [items, plan.wallThickness]);

  /** Screen point → plan cell. The one place pixels become blocks. */
  const toPlan = useCallback(
    (clientX: number, clientY: number): Point => {
      const bounds = svgRef.current?.getBoundingClientRect();
      if (!bounds) return { x: 0, z: 0 };
      return {
        x: Math.floor((clientX - bounds.left) / view.scale + view.ox),
        z: Math.floor((clientY - bounds.top) / view.scale + view.oz),
      };
    },
    [view],
  );

  // Fit the site into the viewport once, and again whenever the site itself changes. Opening
  // on a corner of a 48-block plot at whatever zoom was left over is disorienting; opening on
  // the whole plot is the only framing that needs no explanation.
  useEffect(() => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return;
    const scale = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, Math.min(bounds.width / (plan.site.x + 4), bounds.height / (plan.site.z + 4))),
    );
    setView({
      scale,
      ox: plan.site.x / 2 - bounds.width / (2 * scale),
      oz: plan.site.z / 2 - bounds.height / (2 * scale),
    });
  }, [plan.site.x, plan.site.z]);

  const onWheel = useCallback((event: React.WheelEvent<SVGSVGElement>) => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const px = event.clientX - bounds.left;
    const py = event.clientY - bounds.top;

    setView((prev) => {
      const factor = Math.exp(-event.deltaY * 0.0015);
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev.scale * factor));
      // Zoom about the pointer: the block under it must not move.
      return {
        scale,
        ox: prev.ox + px / prev.scale - px / scale,
        oz: prev.oz + py / prev.scale - py / scale,
      };
    });
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      // Middle button and space-less right-drag pan, matching every other plan tool. Panning
      // with a modifier only would make a 192-block site unusable on a trackpad.
      if (event.button === 1 || event.button === 2) {
        event.preventDefault();
        setDrag({
          kind: 'pan',
          fromClient: { x: event.clientX, z: event.clientY },
          view: { ox: view.ox, oz: view.oz },
        });
        (event.target as Element).setPointerCapture?.(event.pointerId);
        return;
      }
      if (event.button !== 0) return;

      const at = toPlan(event.clientX, event.clientY);
      (event.currentTarget as Element).setPointerCapture(event.pointerId);

      if (tool === 'select') {
        const handle = handleUnder(items, selectedId, at, plan.wallThickness, view.scale);
        if (handle) {
          setDrag({
            kind: 'resize',
            id: handle.id,
            origin: handle.rect,
            corner: handle.corner,
            to: at,
            marked: false,
          });
          return;
        }

        const hit = hitTest(items, at.x, at.z, plan.wallThickness);
        onSelect(hit?.id ?? null);
        if (hit) setDrag({ kind: 'move', id: hit.id, origin: hit, from: at, to: at, marked: false });
        return;
      }

      if (isDragTool(tool)) {
        setDrag({ kind: 'draw', from: at, to: at });
        return;
      }

      // Click-to-place tools commit immediately: there is nothing to drag out.
      placeAt(at);
    },
    // `placeAt` is defined below and stable enough for this to be honest; see the note there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, items, selectedId, plan.wallThickness, view, toPlan, onSelect, onBeginGesture],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const at = toPlan(event.clientX, event.clientY);
      setCursor(at);
      onHover?.(at);

      if (!drag) return;

      if (drag.kind === 'pan') {
        const dx = (event.clientX - drag.fromClient.x) / view.scale;
        const dz = (event.clientY - drag.fromClient.z) / view.scale;
        setView((prev) => ({ ...prev, ox: drag.view.ox - dx, oz: drag.view.oz - dz }));
        return;
      }

      if (drag.kind === 'draw') {
        setDrag({ ...drag, to: at });
        return;
      }

      if (drag.kind === 'move') {
        const dx = at.x - drag.from.x;
        const dz = at.z - drag.from.z;
        // A click that never left its cell is a selection, not a move.
        if (dx === 0 && dz === 0 && !drag.marked) return;
        if (!drag.marked) onBeginGesture();
        setDrag({ ...drag, to: at, marked: true });
        onPreview(movedItem(drag.origin, dx, dz, plan, items));
        return;
      }

      if (drag.kind === 'resize') {
        const item = items.find((entry) => entry.id === drag.id);
        if (!item || !hasRect(item)) return;
        const rect = clampRectToSite(resizeRect(drag.origin, drag.corner, at), plan.site);
        if (!drag.marked && sameRect(rect, item.rect)) return;
        if (!drag.marked) onBeginGesture();
        setDrag({ ...drag, to: at, marked: true });
        onPreview({ ...item, rect } as PlanItem);
      }
    },
    [drag, view.scale, items, plan, toPlan, onPreview, onBeginGesture, onHover],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);

      if (drag?.kind === 'draw') {
        const rect = rectFromPoints(drag.from, drag.to);
        finishDraw(rect, drag.from, drag.to);
      }
      setDrag(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drag, tool, plan, items],
  );

  /**
   * Turn a completed drag into an item.
   *
   * Rooms snap their edges to their neighbours (see `snapRoomRect`), walls straighten to the
   * axis they were dragged furthest along, and everything else takes the rectangle as drawn.
   */
  function finishDraw(rect: Rect, from: Point, to: Point): void {
    const clamped = clampRectToSite(rect, plan.site);

    if (tool === 'room') {
      const snapped = clampRectToSite(
        snapRoomRect(clamped, roomRects(items), plan.wallThickness, 'draw'),
        plan.site,
      );
      if (snapped.w < 3 || snapped.d < 3) {
        onNotice('A room needs to be at least 3×3 — anything smaller has no inside once its walls are built.');
        return;
      }
      onCreate(createRoom(snapped));
      onNotice(null);
      return;
    }

    if (tool === 'wall') {
      const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.z - from.z);
      const length = horizontal ? clamped.w : clamped.d;
      if (length < 2) {
        onNotice('Drag further — a wall shorter than two blocks is a column.');
        return;
      }
      onCreate(
        createWall(horizontal ? 'x' : 'z', clamped.x, clamped.z, length),
      );
      onNotice(null);
      return;
    }

    if (tool === 'opening') {
      onCreate(createOpening(clamped));
      onNotice(null);
      return;
    }

    if (tool === 'platform') {
      onCreate(createPlatform(clamped));
      onNotice(null);
    }
  }

  /**
   * Drop a click-to-place item.
   *
   * Doors and windows go through `snapAperture` first, which is the behaviour ported from the
   * engine's wall-insert snapping: an aperture that is not in a wall is a hole in mid-air, so
   * it is better to refuse the placement and say why than to build one.
   */
  function placeAt(at: Point): void {
    if (tool === 'door' || tool === 'window') {
      const span = tool === 'door' ? 1 : 2;
      const snapped = snapAperture(runs, at.x, at.z, span);
      if (!snapped) {
        onNotice(`Put the ${tool} on a wall — click within a few blocks of one.`);
        return;
      }
      const item =
        tool === 'door'
          ? createDoor(snapped.x, snapped.z, snapped.facing)
          : createWindow(snapped.axis, snapped.x, snapped.z, { length: span });
      onCreate(item);
      onSelect(item.id);
      onNotice(null);
      return;
    }

    if (tool === 'stair') {
      const item = createStair(at.x, at.z, 'south');
      onCreate(item);
      onSelect(item.id);
      onNotice('Stair placed. It climbs one storey and cuts its own well — turn it in the inspector.');
      return;
    }

    if (tool === 'column') {
      const item = createColumn(at.x, at.z);
      onCreate(item);
      onSelect(item.id);
      onNotice(null);
    }
  }

  // --- rendering ---------------------------------------------------------

  const bounds = svgRef.current?.getBoundingClientRect();
  const viewWidth = (bounds?.width ?? 800) / view.scale;
  const viewHeight = (bounds?.height ?? 600) / view.scale;

  const draft = drag?.kind === 'draw' ? clampRectToSite(rectFromPoints(drag.from, drag.to), plan.site) : null;
  const ghost = cursor && !drag ? ghostFor(tool, cursor, plan, runs) : null;

  return (
    <svg
      ref={svgRef}
      className="plan"
      data-tool={tool}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        setCursor(null);
        onHover?.(null);
      }}
      onContextMenu={(event) => event.preventDefault()}
      role="application"
      aria-label="Floor plan"
    >
      <defs>
        <pattern id="plan-grid" width={1} height={1} patternUnits="userSpaceOnUse">
          <path d="M 1 0 L 0 0 0 1" className="plan__grid-line" />
        </pattern>
        <pattern id="plan-grid-major" width={8} height={8} patternUnits="userSpaceOnUse">
          <path d="M 8 0 L 0 0 0 8" className="plan__grid-line plan__grid-line--major" />
        </pattern>
        <pattern id="plan-void" width={2} height={2} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1={0} y1={0} x2={0} y2={2} className="plan__hatch" vectorEffect="non-scaling-stroke" />
        </pattern>
        <pattern id="plan-unreachable" width={3} height={3} patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <line x1={0} y1={0} x2={0} y2={3} className="plan__hatch plan__hatch--warn" vectorEffect="non-scaling-stroke" />
        </pattern>
      </defs>

      <g transform={`scale(${view.scale}) translate(${-view.ox} ${-view.oz})`}>
        {/* The site: everything outside it cannot be built, so it is drawn as a real edge
            rather than left to the viewport to imply. */}
        <rect x={0} y={0} width={plan.site.x} height={plan.site.z} className="plan__site" vectorEffect="non-scaling-stroke" />
        <rect
          x={Math.max(0, view.ox)}
          y={Math.max(0, view.oz)}
          width={Math.min(plan.site.x, viewWidth + 2)}
          height={Math.min(plan.site.z, viewHeight + 2)}
          fill="url(#plan-grid)"
          pointerEvents="none"
        />
        <rect
          x={Math.max(0, view.ox)}
          y={Math.max(0, view.oz)}
          width={Math.min(plan.site.x, viewWidth + 8)}
          height={Math.min(plan.site.z, viewHeight + 8)}
          fill="url(#plan-grid-major)"
          pointerEvents="none"
        />

        {showBelow &&
          below.map((item) => (
            <ItemShape key={`below-${item.id}`} item={item} plan={plan} faded />
          ))}

        {items.map((item) => (
          <ItemShape
            key={item.id}
            item={item}
            plan={plan}
            selected={item.id === selectedId}
            unreachable={unreachable.has(item.id)}
          />
        ))}

        {selectedId && <Handles items={items} selectedId={selectedId} plan={plan} scale={view.scale} />}

        {draft && (
          <rect
            x={draft.x}
            y={draft.z}
            width={draft.w}
            height={draft.d}
            className="plan__draft"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {ghost && (
          <rect
            x={ghost.x}
            y={ghost.z}
            width={ghost.w}
            height={ghost.d}
            className="plan__ghost"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </g>
    </svg>
  );
}

function isDragTool(tool: LayoutToolId): boolean {
  return tool === 'room' || tool === 'wall' || tool === 'opening' || tool === 'platform';
}

function hasRect(item: PlanItem): item is Extract<PlanItem, { rect: Rect }> {
  return item.kind === 'room' || item.kind === 'opening' || item.kind === 'platform';
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.z === b.z && a.w === b.w && a.d === b.d;
}

/**
 * Move an item, snapping a room's edges onto its neighbours on the way.
 *
 * The snap runs on *move* as well as on draw, because "drag this room against that one" is how
 * a plan gets rearranged, and a room that only snapped when first drawn would lose the shared
 * wall the moment it was nudged.
 */
function movedItem(origin: PlanItem, dx: number, dz: number, plan: LayoutPlan, items: readonly PlanItem[]): PlanItem {
  if (hasRect(origin)) {
    const moved = { ...origin.rect, x: origin.rect.x + dx, z: origin.rect.z + dz };
    const rect =
      origin.kind === 'room'
        ? snapRoomRect(moved, roomRects(items, origin.id), plan.wallThickness, 'move')
        : moved;
    return { ...origin, rect: clampRectToSite(rect, plan.site) } as PlanItem;
  }
  return {
    ...origin,
    x: Math.max(0, Math.min(plan.site.x - 1, origin.x + dx)),
    z: Math.max(0, Math.min(plan.site.z - 1, origin.z + dz)),
  } as PlanItem;
}

function resizeRect(origin: Rect, corner: Corner, to: Point): Rect {
  const west = corner === 'nw' || corner === 'sw';
  const north = corner === 'nw' || corner === 'ne';
  const anchor: Point = {
    x: west ? rectRight(origin) - 1 : origin.x,
    z: north ? rectBottom(origin) - 1 : origin.z,
  };
  return rectFromPoints(anchor, to);
}

interface HandleHit {
  id: string;
  rect: Rect;
  corner: Corner;
}

/**
 * The resize handle under the pointer, if any.
 *
 * The catch radius is in *screen* pixels converted back to blocks, so a handle stays grabbable
 * when zoomed out to 4px per block — where a one-block hit box would be a two-pixel target.
 */
function handleUnder(
  items: readonly PlanItem[],
  selectedId: string | null,
  at: Point,
  wallThickness: number,
  scale: number,
): HandleHit | null {
  if (!selectedId) return null;
  const item = items.find((entry) => entry.id === selectedId);
  if (!item || !hasRect(item)) return null;

  const rect = itemFootprint(item, wallThickness);
  const reach = Math.max(1, Math.round(8 / scale));
  const corners: [Corner, Point][] = [
    ['nw', { x: rect.x, z: rect.z }],
    ['ne', { x: rectRight(rect) - 1, z: rect.z }],
    ['sw', { x: rect.x, z: rectBottom(rect) - 1 }],
    ['se', { x: rectRight(rect) - 1, z: rectBottom(rect) - 1 }],
  ];

  for (const [corner, point] of corners) {
    if (Math.abs(at.x - point.x) <= reach && Math.abs(at.z - point.z) <= reach) {
      return { id: item.id, rect: item.rect, corner };
    }
  }
  return null;
}

function Handles({
  items,
  selectedId,
  plan,
  scale,
}: {
  items: readonly PlanItem[];
  selectedId: string;
  plan: LayoutPlan;
  scale: number;
}) {
  const item = items.find((entry) => entry.id === selectedId);
  if (!item || !hasRect(item)) return null;
  const rect = item.rect;
  const size = Math.max(0.6, 7 / scale);

  const corners: Point[] = [
    { x: rect.x, z: rect.z },
    { x: rectRight(rect), z: rect.z },
    { x: rect.x, z: rectBottom(rect) },
    { x: rectRight(rect), z: rectBottom(rect) },
  ];

  return (
    <g pointerEvents="none">
      {corners.map((corner, index) => (
        <rect
          key={index}
          x={corner.x - size / 2}
          y={corner.z - size / 2}
          width={size}
          height={size}
          className="plan__handle"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}

/** What the next click or drag would produce, drawn faintly under the pointer. */
function ghostFor(
  tool: LayoutToolId,
  at: Point,
  plan: LayoutPlan,
  runs: ReturnType<typeof wallRuns>,
): Rect | null {
  if (tool === 'door' || tool === 'window') {
    const span = tool === 'door' ? 1 : 2;
    const snapped = snapAperture(runs, at.x, at.z, span);
    if (!snapped) return null;
    return snapped.axis === 'x'
      ? { x: snapped.x, z: snapped.z, w: span, d: plan.wallThickness }
      : { x: snapped.x, z: snapped.z, w: plan.wallThickness, d: span };
  }
  if (tool === 'stair') return stairFootprint(at.x, at.z, 'south', 2, plan.storeyHeight);
  if (tool === 'column') return { x: at.x, z: at.z, w: 1, d: 1 };
  return null;
}

/** One item, drawn the way a floorplan draws it. */
function ItemShape({
  item,
  plan,
  selected = false,
  faded = false,
  unreachable = false,
}: {
  item: PlanItem;
  plan: LayoutPlan;
  selected?: boolean;
  faded?: boolean;
  unreachable?: boolean;
}) {
  const t = plan.wallThickness;
  const className = [
    'plan__item',
    `plan__item--${item.kind}`,
    selected ? 'is-selected' : '',
    faded ? 'is-below' : '',
  ]
    .filter(Boolean)
    .join(' ');

  switch (item.kind) {
    case 'room': {
      const { rect } = item;
      const wall = Math.max(1, Math.min(t, Math.floor(Math.min(rect.w, rect.d) / 2) || 1));
      return (
        <g className={className}>
          <rect x={rect.x} y={rect.z} width={rect.w} height={rect.d} className="plan__room-fill" />
          {unreachable && (
            <rect x={rect.x} y={rect.z} width={rect.w} height={rect.d} fill="url(#plan-unreachable)" />
          )}
          {/* The wall ring drawn as four bars rather than a thick stroke: a stroke straddles
              the edge, and a wall that is half outside the room it belongs to lines up with
              nothing. */}
          <rect x={rect.x} y={rect.z} width={rect.w} height={wall} className="plan__wall" />
          <rect x={rect.x} y={rectBottom(rect) - wall} width={rect.w} height={wall} className="plan__wall" />
          <rect x={rect.x} y={rect.z} width={wall} height={rect.d} className="plan__wall" />
          <rect x={rectRight(rect) - wall} y={rect.z} width={wall} height={rect.d} className="plan__wall" />
          {!faded && rect.w >= 5 && rect.d >= 3 && (
            <text
              x={rect.x + rect.w / 2}
              y={rect.z + rect.d / 2}
              className="plan__label"
              textAnchor="middle"
              dominantBaseline="middle"
              // Sized to the room rather than fixed, so a long name in a small room shrinks to
              // fit instead of spilling across the wall into its neighbour.
              fontSize={labelSize(item.label || `${rect.w}×${rect.d}`, rect)}
            >
              {item.label || `${rect.w}×${rect.d}`}
            </text>
          )}
        </g>
      );
    }

    case 'wall': {
      const rect = itemFootprint(item, t);
      return (
        <rect x={rect.x} y={rect.z} width={rect.w} height={rect.d} className={`${className} plan__wall`} />
      );
    }

    case 'door': {
      const rect = itemFootprint(item, t);
      return (
        <g className={className}>
          <rect x={rect.x} y={rect.z} width={rect.w} height={rect.d} className="plan__door" />
          <path d={swingPath(item.x, item.z, item.facing, item.width, t)} className="plan__swing" vectorEffect="non-scaling-stroke" />
        </g>
      );
    }

    case 'window': {
      const rect = itemFootprint(item, t);
      return (
        <rect x={rect.x} y={rect.z} width={rect.w} height={rect.d} className={`${className} plan__window`} />
      );
    }

    case 'stair': {
      const run = stairFootprint(item.x, item.z, item.facing, item.width, plan.storeyHeight);
      const along = item.facing === 'north' || item.facing === 'south' ? 'z' : 'x';
      const treads = along === 'z' ? run.d : run.w;
      return (
        <g className={className}>
          <rect x={run.x} y={run.z} width={run.w} height={run.d} className="plan__stair" vectorEffect="non-scaling-stroke" />
          {Array.from({ length: Math.max(0, treads - 1) }, (_, i) =>
            along === 'z' ? (
              <line
                key={i}
                x1={run.x}
                y1={run.z + i + 1}
                x2={rectRight(run)}
                y2={run.z + i + 1}
                className="plan__tread"
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <line
                key={i}
                x1={run.x + i + 1}
                y1={run.z}
                x2={run.x + i + 1}
                y2={rectBottom(run)}
                className="plan__tread"
                vectorEffect="non-scaling-stroke"
              />
            ),
          )}
          {/* The up-arrow is the convention every floorplan uses, and without it a run of
              treads says nothing about which way it climbs. */}
          <path d={arrowPath(run, item.facing)} className="plan__arrow" vectorEffect="non-scaling-stroke" />
        </g>
      );
    }

    case 'opening': {
      const { rect } = item;
      return (
        <g className={className}>
          <rect x={rect.x} y={rect.z} width={rect.w} height={rect.d} fill="url(#plan-void)" />
          <rect x={rect.x} y={rect.z} width={rect.w} height={rect.d} className="plan__void" vectorEffect="non-scaling-stroke" />
        </g>
      );
    }

    case 'platform': {
      const { rect } = item;
      return (
        <rect x={rect.x} y={rect.z} width={rect.w} height={rect.d} className={`${className} plan__platform`} vectorEffect="non-scaling-stroke" />
      );
    }

    case 'column':
      return (
        <rect x={item.x} y={item.z} width={item.size} height={item.size} className={`${className} plan__column`} />
      );
  }
}

/**
 * A label size, in blocks, that keeps the text inside the room it names.
 *
 * A glyph in the display face averages about 0.6 of its height in width — measured off a
 * rendered label rather than assumed — so a name of `n` characters needs roughly
 * `0.62 × size × n`, with a little to spare. Solving that against the room's width, less a
 * block of margin each side, gives the first cap; the second keeps a name in a long, thin
 * corridor from being taller than the corridor.
 *
 * The result is set as a presentation attribute, which means `.plan__label` must not declare a
 * `font-size`: CSS beats a presentation attribute, and a stylesheet rule here would quietly
 * throw all of this away.
 */
const GLYPH_ASPECT = 0.62;

function labelSize(text: string, rect: Rect): number {
  const byWidth = (rect.w - 2) / (Math.max(1, text.length) * GLYPH_ASPECT);
  const byHeight = (rect.d - 2) * 0.5;
  return Math.max(0.8, Math.min(2.2, byWidth, byHeight));
}

/** The quarter-circle a door leaf sweeps — the symbol, not the geometry. */
function swingPath(x: number, z: number, facing: Face, width: number, thickness: number): string {
  const r = Math.max(1.5, width + 1);
  switch (facing) {
    case 'south':
      return `M ${x} ${z + thickness} L ${x} ${z + thickness + r} A ${r} ${r} 0 0 0 ${x + r} ${z + thickness}`;
    case 'north':
      return `M ${x} ${z} L ${x} ${z - r} A ${r} ${r} 0 0 1 ${x + r} ${z}`;
    case 'east':
      return `M ${x + thickness} ${z} L ${x + thickness + r} ${z} A ${r} ${r} 0 0 1 ${x + thickness} ${z + r}`;
    case 'west':
      return `M ${x} ${z} L ${x - r} ${z} A ${r} ${r} 0 0 0 ${x} ${z + r}`;
  }
}

function arrowPath(run: Rect, facing: Face): string {
  const cx = run.x + run.w / 2;
  const cz = run.z + run.d / 2;
  const head = 1.2;
  switch (facing) {
    case 'south':
      return `M ${cx} ${run.z + 0.5} L ${cx} ${rectBottom(run) - 0.5} M ${cx - head / 2} ${rectBottom(run) - 0.5 - head} L ${cx} ${rectBottom(run) - 0.5} L ${cx + head / 2} ${rectBottom(run) - 0.5 - head}`;
    case 'north':
      return `M ${cx} ${rectBottom(run) - 0.5} L ${cx} ${run.z + 0.5} M ${cx - head / 2} ${run.z + 0.5 + head} L ${cx} ${run.z + 0.5} L ${cx + head / 2} ${run.z + 0.5 + head}`;
    case 'east':
      return `M ${run.x + 0.5} ${cz} L ${rectRight(run) - 0.5} ${cz} M ${rectRight(run) - 0.5 - head} ${cz - head / 2} L ${rectRight(run) - 0.5} ${cz} L ${rectRight(run) - 0.5 - head} ${cz + head / 2}`;
    case 'west':
      return `M ${rectRight(run) - 0.5} ${cz} L ${run.x + 0.5} ${cz} M ${run.x + 0.5 + head} ${cz - head / 2} L ${run.x + 0.5} ${cz} L ${run.x + 0.5 + head} ${cz + head / 2}`;
  }
}
