/**
 * The plan view: a top-down, block-ruled drawing surface.
 *
 * This is Architecture mode's equivalent of the level editor engine's orthographic viewport
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
  alignmentGuides,
  clampRectToSite,
  hitTest,
  itemFootprint,
  planFootprint,
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
import { selectionBounds } from './arrange.js';
import { Dimensions, SizeBadge } from './Dimensions.js';
import { furnishingById, furnishingFootprint } from './furniture.js';
import { createFurnish, floorHeight,
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
  type RoomItem,
  createPlace,
  placeFootprint,
} from './plan.js';
import type { LayoutToolId } from './toolset.js';

/** Zoom range, in screen pixels per block. Below 3 a wall is invisible; above 48 is a mosaic. */
const MIN_SCALE = 3;
const MAX_SCALE = 48;

/** A saved build chosen in the Components panel, ready to drop. */
export interface PlaceChoice {
  id: string;
  name: string;
  w: number;
  d: number;
  h: number;
}

export interface PlanCanvasProps {
  plan: LayoutPlan;
  floorIndex: number;
  tool: LayoutToolId;
  /**
   * Which saved build the Place tool will drop, or null when none is chosen.
   *
   * The tool refuses rather than guessing: a furnishing has an obvious default and a library
   * does not, and the wrong building appearing under the cursor is worse than being asked.
   */
  placeChoice?: PlaceChoice | null;
  /**
   * True footprints for placed builds whose blocks have arrived, by item id.
   *
   * A placement carries its own remembered size so the plan can be drawn the instant it is
   * restored; this supersedes it once the library has answered, which matters when a build has
   * been edited since it was placed.
   */
  placeSizes?: ReadonlyMap<string, { w: number; d: number }>;
  /**
   * Every selected item, in the order they were picked.
   *
   * A list rather than an id because aligning, spacing and moving things as a group is most
   * of what drafting a floorplan is, and none of it is expressible one item at a time. The
   * single-selection affordances that only make sense for one thing — the resize handles, the
   * inspector's fields — key off its length being exactly one rather than off a second prop
   * that could disagree with this one.
   */
  selectedIds: readonly string[];
  /** Rooms validation could not walk to, drawn hatched. */
  unreachable: ReadonlySet<string>;
  /** Draw the storey below in outline, so things can be lined up through the floor. */
  showBelow: boolean;
  /** `additive` is a shift-click: toggle this item's membership instead of replacing it. */
  onSelect: (id: string | null, additive?: boolean) => void;
  /** A marquee finished. Ids are everything it touched, already unioned with any shift-held set. */
  onSelectMany: (ids: string[]) => void;
  /** A gesture is starting: record the plan so the whole gesture is one undo. */
  onBeginGesture: () => void;
  onCreate: (item: PlanItem) => void;
  /** An intermediate frame of a drag — applied without touching history. */
  onPreview: (items: PlanItem[]) => void;
  onNotice: (message: string | null) => void;
  /** Reported so the page's readout can say what is under the pointer. */
  onHover?: (at: Point | null) => void;
  /**
   * Bumped by the page to re-frame the drawing — the same nonce convention the 3D canvas uses
   * for its view presets, because pressing "Fit" twice has to work and a boolean cannot say so.
   */
  fitNonce?: number;
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
  | { kind: 'move'; origins: PlanItem[]; from: Point; to: Point; marked: boolean }
  /** A rubber band over empty canvas. `additive` keeps whatever was already selected. */
  | { kind: 'marquee'; from: Point; to: Point; additive: boolean }
  | { kind: 'resize'; id: string; origin: Rect; corner: Corner; to: Point; marked: boolean }
  | { kind: 'pan'; fromClient: Point; view: { ox: number; oz: number } };

type Corner = 'nw' | 'ne' | 'sw' | 'se';

export function PlanCanvas({
  plan: wholePlan,
  floorIndex,
  tool,
  placeChoice = null,
  placeSizes,
  selectedIds,
  unreachable,
  showBelow,
  onSelect,
  onSelectMany,
  onBeginGesture,
  onCreate,
  onPreview,
  onNotice,
  onHover,
  fitNonce = 0,
}: PlanCanvasProps) {
  // Every geometric read below wants the ACTIVE storey's height — a stair on a 7-block
  // storey runs 7 treads, whatever the building default says. Folding the override into a
  // plan view once keeps the ten call sites honest, and it cannot leak back into the
  // document: this component only ever emits items, never a plan.
  const plan = useMemo(
    () => ({ ...wholePlan, storeyHeight: floorHeight(wholePlan, floorIndex) }),
    [wholePlan, floorIndex],
  );
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState(() => ({ scale: 14, ox: 0, oz: 0 }));
  const [drag, setDrag] = useState<Drag | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);

  /**
   * The selection when it is exactly one thing. Resize handles and the alignment guides both
   * need a subject rather than a set, and "the first of several" would be an arbitrary one.
   */
  const selectedId = selectedIds.length === 1 ? selectedIds[0]! : null;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

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

  /**
   * Frame a rectangle, with a margin, and centre it.
   *
   * `margin` is in blocks, so the padding grows with the drawing rather than with the zoom —
   * which is what stops a two-room cottage from ending up with the same slack as a 40-room
   * office block.
   */
  const fitTo = useCallback((rect: Rect, margin: number) => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return;
    const w = rect.w + margin * 2;
    const d = rect.d + margin * 2;
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(bounds.width / w, bounds.height / d)));
    setView({
      scale,
      ox: rect.x + rect.w / 2 - bounds.width / (2 * scale),
      oz: rect.z + rect.d / 2 - bounds.height / (2 * scale),
    });
  }, []);

  /**
   * Frame the drawing, or the site when there is nothing drawn yet.
   *
   * It used to always frame the site, which meant a cottage on a 48-block plot opened as a
   * postage stamp in a field of empty grid: the thing you came to work on was the smallest
   * feature on screen. A plot is only the subject before anything is on it.
   */
  const fitToContent = useCallback(() => {
    const drawn = planFootprint(plan);
    if (drawn) fitTo(drawn, Math.max(3, Math.round(Math.max(drawn.w, drawn.d) * 0.12)));
    else fitTo({ x: 0, z: 0, w: plan.site.x, d: plan.site.z }, 2);
  }, [plan, fitTo]);

  // Framed on mount and whenever the site changes shape — not on every edit, which would
  // yank the view out from under a drag. `planId` catches loading a different plan entirely.
  //
  // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  useEffect(fitToContent, [plan.id, plan.site.x, plan.site.z]);

  // The page asks for a re-frame by bumping a nonce, the same convention the 3D canvas uses
  // for its view presets: pressing "Fit" twice has to work, and a boolean cannot say that.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  useEffect(() => { if (fitNonce > 0) fitToContent(); }, [fitNonce]);

  const zoomBy = useCallback((factor: number) => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setView((prev) => {
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev.scale * factor));
      // About the middle of the viewport, which is where the eye is when a button is pressed.
      return {
        scale,
        ox: prev.ox + bounds.width / 2 / prev.scale - bounds.width / 2 / scale,
        oz: prev.oz + bounds.height / 2 / prev.scale - bounds.height / 2 / scale,
      };
    });
  }, []);

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
        const handle = handleUnder(items, selectedId, at, plan.wallThickness, plan.storeyHeight, view.scale);
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

        const additive = event.shiftKey;
        const hit = hitTest(items, at.x, at.z, plan.wallThickness, plan.storeyHeight);

        if (!hit) {
          // Empty canvas starts a rubber band rather than only clearing the selection: a
          // drag that begins on nothing has no other meaning, and marquee is the one way to
          // pick up a row of rooms without clicking each of them.
          setDrag({ kind: 'marquee', from: at, to: at, additive });
          if (!additive) onSelect(null);
          return;
        }

        // Dragging one member of a selection moves the whole selection. Re-selecting on
        // pointer-down instead would make "select three rooms, drag them" impossible: the
        // press would throw the other two away before the drag began.
        const moving = selectedSet.has(hit.id) && !additive
          ? items.filter((item) => selectedSet.has(item.id))
          : [hit];
        if (!selectedSet.has(hit.id) || additive) onSelect(hit.id, additive);
        setDrag({ kind: 'move', origins: moving, from: at, to: at, marked: false });
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

      if (drag.kind === 'draw' || drag.kind === 'marquee') {
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
        // Snapping is for a single item. Moving a group and snapping each member separately
        // would tear the group apart on the first neighbour any one of them passed.
        onPreview(
          drag.origins.length === 1
            ? [movedItem(drag.origins[0]!, dx, dz, plan, items)]
            : drag.origins.map((origin) => shifted(origin, dx, dz)),
        );
        return;
      }

      if (drag.kind === 'resize') {
        const item = items.find((entry) => entry.id === drag.id);
        if (!item || !hasRect(item)) return;
        const rect = clampRectToSite(resizeRect(drag.origin, drag.corner, at), plan.site);
        if (!drag.marked && sameRect(rect, item.rect)) return;
        if (!drag.marked) onBeginGesture();
        setDrag({ ...drag, to: at, marked: true });
        onPreview([{ ...item, rect } as PlanItem]);
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
      if (drag?.kind === 'marquee') {
        const band = rectFromPoints(drag.from, drag.to);
        // A band that never left its cell is a click on empty canvas, which already cleared
        // the selection on the way down; treating it as a marquee would select nothing twice.
        if (band.w > 0 || band.d > 0) {
          const caught = items
            .filter((item) => overlaps(band, itemFootprint(item, plan.wallThickness, plan.storeyHeight)))
            .map((item) => item.id);
          onSelectMany(drag.additive ? [...new Set([...selectedIds, ...caught])] : caught);
        }
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
      const snapped = draftFor('room', from, to, plan, items);
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
      return;
    }

    if (tool === 'furnish') {
      const item = createFurnish(at.x, at.z);
      onCreate(item);
      onSelect(item.id);
      onNotice('Placed. Pick the piece and turn it in the inspector.');
      return;
    }

    if (tool === 'place') {
      // Unlike a furnishing there is no sensible default to drop: "some build from your
      // library" is a guess, and the wrong building appearing under the cursor is worse than
      // being told to pick one.
      if (!placeChoice) {
        onNotice('Pick a saved build from the Components panel first.');
        return;
      }
      const item = createPlace(at.x, at.z, placeChoice);
      onCreate(item);
      onSelect(item.id);
      onNotice(`Placed "${placeChoice.name}". R turns it; it builds on this storey's floor.`);
    }
  }

  // --- rendering ---------------------------------------------------------

  const bounds = svgRef.current?.getBoundingClientRect();
  const viewWidth = (bounds?.width ?? 800) / view.scale;
  const viewHeight = (bounds?.height ?? 600) / view.scale;

  const draft = drag?.kind === 'draw' ? draftFor(tool, drag.from, drag.to, plan, items) : null;
  const band = drag?.kind === 'marquee' ? rectFromPoints(drag.from, drag.to) : null;
  const group =
    selectedIds.length > 1
      ? selectionBounds(items, selectedIds, plan.wallThickness, plan.storeyHeight)
      : null;
  const ghost = cursor && !drag ? ghostFor(tool, cursor, plan, runs, placeChoice) : null;

  const selectedItem = selectedId ? items.find((entry) => entry.id === selectedId) ?? null : null;

  /**
   * The rectangle the dimensions describe, and which of its edges are worth measuring.
   *
   * A dimensioned drawing is one where the figure you want is already on the paper, so this
   * follows the gesture: whatever is being drawn, then whatever is being dragged, and only
   * then the standing selection. Never more than one at a time — two sets of figures over the
   * same corner is worse than none.
   */
  const measured = draft
    ? { rect: draft, axes: draftAxes(tool, draft), live: true }
    : selectedItem
      ? { rect: itemFootprint(selectedItem, plan.wallThickness, plan.storeyHeight), axes: measuredAxes(selectedItem), live: drag !== null }
      : null;

  const badge = drag ? badgeFor(drag, items, plan, tool) : null;

  /**
   * Lines showing what the thing being dragged has lined up with.
   *
   * Only while a gesture is running — alignment is a fact about a move, and a plan that drew
   * every coincidence in a finished drawing would be unreadable. Compared against every other
   * item's footprint rather than only rooms, because a wall or a platform lined up with a room
   * edge is exactly the alignment you cannot check by eye.
   */
  const guides = useMemo(() => {
    if (!drag || drag.kind === 'pan') return [];
    // A group move has no single subject to guide against, and six sets of guides at once
    // is noise rather than help.
    const subject =
      drag.kind === 'draw'
        ? draftFor(tool, drag.from, drag.to, plan, items)
        : drag.kind === 'resize'
          ? items.find((entry) => entry.id === drag.id)
          : drag.kind === 'move' && drag.origins.length === 1
            ? items.find((entry) => entry.id === drag.origins[0]!.id)
            : undefined;
    if (!subject) return [];
    const rect = 'kind' in subject ? itemFootprint(subject, plan.wallThickness, plan.storeyHeight) : subject;
    const others = items
      .filter((entry) => !('kind' in subject) || entry.id !== subject.id)
      .map((entry) => itemFootprint(entry, plan.wallThickness, plan.storeyHeight));
    return alignmentGuides(rect, others);
  }, [drag, items, plan.site, plan.wallThickness]);

  return (
    <>
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
            <ItemShape key={`below-${item.id}`} item={item} plan={plan} placeSizes={placeSizes} faded />
          ))}

        {items.map((item) => (
          <ItemShape
            key={item.id}
            item={item}
            plan={plan}
            placeSizes={placeSizes}
            selected={selectedSet.has(item.id)}
            unreachable={unreachable.has(item.id)}
          />
        ))}

        {selectedId && <Handles items={items} selectedId={selectedId} plan={plan} scale={view.scale} />}

        {/* The box the selection sits in, so an alignment button's subject is visible before
            it is pressed rather than only inferable from which outlines are lit. */}
        {group && (
          <rect
            x={group.x}
            y={group.z}
            width={group.w}
            height={group.d}
            className="plan__group"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {band && (
          <rect
            x={band.x}
            y={band.z}
            width={band.w}
            height={band.d}
            className="plan__marquee"
            vectorEffect="non-scaling-stroke"
          />
        )}

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

        {guides.map((guide) => (
          <line
            key={`${guide.axis}${guide.at}`}
            x1={guide.axis === 'x' ? guide.at : guide.from}
            y1={guide.axis === 'x' ? guide.from : guide.at}
            x2={guide.axis === 'x' ? guide.at : guide.to}
            y2={guide.axis === 'x' ? guide.to : guide.at}
            className="plan__guide"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {measured && (
          <Dimensions rect={measured.rect} scale={view.scale} axes={measured.axes} live={measured.live} />
        )}

        {badge && cursor && <SizeBadge at={cursor} scale={view.scale} lines={badge} />}
      </g>
    </svg>

    {/* Outside the SVG rather than drawn into it: these are controls, and a control made of
        SVG has to reinvent focus rings, hover states and hit areas that a button already has.
        The plan panel is `position: relative`, so it floats over the corner of the drawing. */}
    <div className="plan-zoom">
      <button type="button" onClick={() => zoomBy(1 / 1.3)} title="Zoom out" aria-label="Zoom out">
        −
      </button>
      <span className="plan-zoom__level" title="Screen pixels per block">
        {Math.round(view.scale)} px/blk
      </span>
      <button type="button" onClick={() => zoomBy(1.3)} title="Zoom in" aria-label="Zoom in">
        +
      </button>
      <button type="button" className="plan-zoom__fit" onClick={fitToContent} title="Frame the drawing  (F)">
        Fit
      </button>
    </div>
    </>
  );
}

/**
 * Which edges of a draft to measure.
 *
 * A wall is drawn as a rectangle but is a *run*: measuring its one-block thickness while you
 * drag it out tells you nothing you did not already decide in the site panel, and the figure
 * competes with the length, which is the one you are actually setting.
 */
function draftAxes(tool: LayoutToolId, rect: Rect): 'both' | 'x' | 'z' {
  if (tool !== 'wall') return 'both';
  return rect.w >= rect.d ? 'x' : 'z';
}

/** Same rule for a standing selection, keyed off the item rather than the tool. */
function measuredAxes(item: PlanItem): 'both' | 'x' | 'z' {
  if (item.kind === 'wall' || item.kind === 'window') return item.axis === 'x' ? 'x' : 'z';
  if (item.kind === 'door' || item.kind === 'column') return 'both';
  return 'both';
}

/**
 * The lines of the pointer readout, for whatever gesture is running.
 *
 * Deliberately different per gesture, because the useful number is different: drawing a room
 * is about its area, moving one is about how far it has come, and resizing is about the size
 * it is heading for. A single "w × d" for all three would answer the question only once.
 */
function badgeFor(
  drag: Drag,
  items: readonly PlanItem[],
  plan: LayoutPlan,
  tool: LayoutToolId,
): string[] | null {
  if (drag.kind === 'draw') {
    // The snapped rect, like everything else that describes this gesture — the readout is
    // the most explicit of the four, so it is the one a wrong number is least forgivable in.
    const rect = draftFor(tool, drag.from, drag.to, plan, items);
    const inner = Math.max(0, rect.w - plan.wallThickness * 2) * Math.max(0, rect.d - plan.wallThickness * 2);
    return inner > 0
      ? [`${rect.w} × ${rect.d}`, `${inner} blocks inside`]
      : [`${rect.w} × ${rect.d}`];
  }

  if (drag.kind === 'move' && drag.marked) {
    const dx = drag.to.x - drag.from.x;
    const dz = drag.to.z - drag.from.z;
    if (dx === 0 && dz === 0) return null;
    const move = `${dx >= 0 ? '+' : ''}${dx} x, ${dz >= 0 ? '+' : ''}${dz} z`;
    return drag.origins.length > 1 ? [move, `${drag.origins.length} items`] : [move];
  }

  if (drag.kind === 'marquee') {
    const band = rectFromPoints(drag.from, drag.to);
    if (band.w === 0 && band.d === 0) return null;
    return [`${band.w} × ${band.d}`];
  }

  if (drag.kind === 'resize' && drag.marked) {
    const item = items.find((entry) => entry.id === drag.id);
    if (!item || !hasRect(item)) return null;
    return [`${item.rect.w} × ${item.rect.d}`];
  }

  return null;
}

/**
 * The rectangle a drag would actually produce, snapping included.
 *
 * Shared by the outline, the dimensions, the alignment guides and the commit, because they
 * used to disagree: the preview drew the raw drag while the commit ran the edge snap, so a
 * room dragged against a neighbour was previewed in one place and created in another — and
 * once the preview grew a dimension readout, it was confidently reporting a size that was
 * not the size you got.
 */
/** Do two plan rects share any cell? Touching edges do not count — a marquee has to enclose. */
function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < rectRight(b) && rectRight(a) > b.x && a.z < rectBottom(b) && rectBottom(a) > b.z
  );
}

/** Move an item bodily, with no snapping. The group-move counterpart of `movedItem`. */
function shifted(item: PlanItem, dx: number, dz: number): PlanItem {
  if (item.kind === 'room' || item.kind === 'opening' || item.kind === 'platform') {
    return { ...item, rect: { ...item.rect, x: item.rect.x + dx, z: item.rect.z + dz } };
  }
  return { ...item, x: item.x + dx, z: item.z + dz };
}

function draftFor(
  tool: LayoutToolId,
  from: Point,
  to: Point,
  plan: LayoutPlan,
  items: readonly PlanItem[],
): Rect {
  const clamped = clampRectToSite(rectFromPoints(from, to), plan.site);
  if (tool !== 'room') return clamped;
  return clampRectToSite(snapRoomRect(clamped, roomRects(items), plan.wallThickness, 'draw'), plan.site);
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
  storeyHeight: number,
  scale: number,
): HandleHit | null {
  if (!selectedId) return null;
  const item = items.find((entry) => entry.id === selectedId);
  if (!item || !hasRect(item)) return null;

  const rect = itemFootprint(item, wallThickness, storeyHeight);
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
  placeChoice: PlaceChoice | null,
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
  if (tool === 'furnish') return furnishingFootprint(furnishingById('chair'), at.x, at.z, 'south');
  // The real footprint of the build that is about to be dropped — this is the one ghost that
  // is worth being exact, because a saved building can be twenty blocks across and "where
  // will it actually reach" is the whole question being asked before the click.
  if (tool === 'place' && placeChoice) {
    return { x: at.x, z: at.z, w: placeChoice.w, d: placeChoice.d };
  }
  return null;
}

/** One item, drawn the way a floorplan draws it. */
function ItemShape({
  item,
  plan,
  placeSizes,
  selected = false,
  faded = false,
  unreachable = false,
}: {
  item: PlanItem;
  plan: LayoutPlan;
  placeSizes?: ReadonlyMap<string, { w: number; d: number }>;
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
          {!faded && rect.w >= 5 && rect.d >= 3 && <RoomLabel item={item} rect={rect} wall={wall} />}
        </g>
      );
    }

    case 'wall': {
      const rect = itemFootprint(item, t, plan.storeyHeight);
      return (
        <rect x={rect.x} y={rect.z} width={rect.w} height={rect.d} className={`${className} plan__wall`} />
      );
    }

    case 'door': {
      const rect = itemFootprint(item, t, plan.storeyHeight);
      return (
        <g className={className}>
          <rect x={rect.x} y={rect.z} width={rect.w} height={rect.d} className="plan__door" />
          <path d={swingPath(item.x, item.z, item.facing, item.width, t)} className="plan__swing" vectorEffect="non-scaling-stroke" />
        </g>
      );
    }

    case 'window': {
      const rect = itemFootprint(item, t, plan.storeyHeight);
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

    case 'place': {
      // Drawn as an outlined footprint with the build's name and a corner mark for which way
      // it faces. Deliberately not a preview of its blocks: a floorplan is a drawing, the 3D
      // model beside it is the render, and a thumbnail here would be unreadable at the size a
      // 4-block shed occupies on screen.
      const size = placeSizes?.get(item.id);
      const rect = placeFootprint(item, size);
      const cx = rect.x + rect.w / 2;
      const cz = rect.z + rect.d / 2;
      // The corner the build's own origin sits in, after the turn. It is the one visual cue
      // that says which way round a symmetric-looking footprint has been turned.
      const mark = [
        { x: rect.x, z: rect.z },
        { x: rect.x + rect.w, z: rect.z },
        { x: rect.x + rect.w, z: rect.z + rect.d },
        { x: rect.x, z: rect.z + rect.d },
      ][item.turns]!;

      return (
        <g>
          <rect
            x={rect.x + 0.15}
            y={rect.z + 0.15}
            width={Math.max(0.1, rect.w - 0.3)}
            height={Math.max(0.1, rect.d - 0.3)}
            rx={0.3}
            className={`${className} plan__place`}
            data-loaded={size ? 'true' : 'false'}
          />
          <circle cx={mark.x} cy={mark.z} r={0.45} className="plan__place-mark" />
          <text
            x={cx}
            y={cz}
            className="plan__place-label"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={Math.max(0.8, Math.min(1.4, Math.min(rect.w, rect.d) * 0.22))}
          >
            {item.name}
          </text>
        </g>
      );
    }

    case 'furnish': {
      // A furnishing draws as its footprint with the piece's initial letter and a facing
      // tick — enough to read the room without pretending the plan is a render.
      const piece = furnishingById(item.itemId);
      const rect = furnishingFootprint(piece, item.x, item.z, item.facing);
      const cx = rect.x + rect.w / 2;
      const cz = rect.z + rect.d / 2;
      return (
        <g>
          <rect
            x={rect.x + 0.1}
            y={rect.z + 0.1}
            width={rect.w - 0.2}
            height={rect.d - 0.2}
            rx={0.15}
            className={`${className} plan__furnish`}
          />
          <text x={cx} y={cz} className="plan__furnish-glyph" textAnchor="middle" dominantBaseline="central" fontSize={Math.min(rect.w, rect.d) * 0.6}>
            {piece.label[0]}
          </text>
        </g>
      );
    }
  }
}

/**
 * A room's name, with its inside measurement under it.
 *
 * The size line is the reason this is a component rather than a `<text>`. Dimension lines
 * appear on selection and during a drag, which is right — a drawing with every edge dimensioned
 * at once is unreadable — but it left the resting state of the plan with no numbers on it at
 * all, and "how big is that room" is the question you ask about a room you are *not* currently
 * touching. Two lines in the middle of the room answer it permanently and cost no clutter,
 * because the space was empty anyway.
 *
 * Interior, not the outer rect: it is the floor you can stand on, and it is the number the
 * schedule in the panel reports, so the two must not disagree.
 */
function RoomLabel({ item, rect, wall }: { item: RoomItem; rect: Rect; wall: number }) {
  const name = item.label.trim();
  const inner = { w: rect.w - wall * 2, d: rect.d - wall * 2 };
  const size = inner.w > 0 && inner.d > 0 ? `${inner.w} × ${inner.d}` : null;

  // Sized against whichever string is longer, so neither line spills across the wall into the
  // neighbouring room.
  const scale = labelSize(name.length >= (size?.length ?? 0) ? name || 'Room' : size ?? 'Room', rect);
  const gap = scale * 0.75;
  const cx = rect.x + rect.w / 2;
  const cz = rect.z + rect.d / 2;

  // One line when there is only one thing to say, and it goes on the centre line. Two lines
  // straddle it, or the pair sits low in the room and reads as belonging to the wall below.
  if (!name || !size) {
    return (
      <text x={cx} y={cz} className="plan__label" textAnchor="middle" dominantBaseline="middle" fontSize={scale}>
        {name || size}
      </text>
    );
  }

  return (
    <>
      <text x={cx} y={cz - gap / 2} className="plan__label" textAnchor="middle" dominantBaseline="middle" fontSize={scale}>
        {name}
      </text>
      <text
        x={cx}
        y={cz + gap}
        className="plan__label plan__label--size"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={scale * 0.66}
      >
        {size}
      </text>
    </>
  );
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
  // A third of the depth rather than half: the label is two lines now, and the pair has to sit
  // inside the room without the descenders of the first touching the second.
  const byHeight = (rect.d - 2) * 0.3;
  // The cap came down from 2.2 blocks with the fit-to-drawing change. Framing the site made
  // every plan small on screen, which hid how large the ceiling was; framing the drawing made
  // a name in a big room render at forty pixels and read as a heading rather than a label.
  return Math.max(0.7, Math.min(1.4, byWidth, byHeight));
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
