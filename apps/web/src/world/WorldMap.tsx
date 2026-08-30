/**
 * The map: a top-down view of the terrain you sculpt in.
 *
 * Architecture mode draws its plan as SVG, and that is right for a few hundred rooms. A world
 * is a raster problem — 1024² is a million columns, and a million SVG rects is not a slow page,
 * it is a dead one. So the ground is drawn into an `ImageData` the size of the map in columns
 * and blitted with smoothing off, which costs one pass over the heightfield and scales to any
 * zoom because the browser does the scaling. Everything you can *point at* — placements, the
 * region grid, the brush ring — stays SVG on top, where hit-testing and crisp strokes are free.
 *
 * Sculpting in a top-down view rather than in the 3D viewport is a deliberate choice and the
 * one every serious terrain tool makes. A brush in perspective paints an ellipse that changes
 * size with distance and hides everything behind the hill you are raising; from above, the
 * brush is the circle it claims to be. The 3D view next door is where you check the result,
 * exactly as the plan and the model split the work in Architecture mode.
 *
 * Shading is a hillshade, not a height ramp. A ramp tells you a column's altitude and nothing
 * about its shape, so a hill and a plateau at the same height look identical and you cannot
 * see what your own brush just did. Lighting the slope is what makes the ground read.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  columnIndex,
  isEmptyColumn,
  levelDisc,
  paintDisc,
  profileAt,
  profileColor,
  raiseDisc,
  regionCount,
  stampDisc,
  type TerrainBrush,
  type WorldDoc,
  type WorldPlacement,
} from '@craftmagic/core';
import { interpolate, type TerrainStroke } from './stroke.js';
import { placementFootprint, type WorldTool } from './toolset.js';

export interface WorldMapProps {
  doc: WorldDoc;
  /** Changes whenever the terrain does — the document's identity deliberately does not. */
  revision: number;
  tool: WorldTool;
  brush: TerrainBrush;
  /** Index into `settings.strata`, for the Terrainer. */
  stratum: number;
  /** Target height for the Leveler, and the y a Carve stroke cuts at. */
  targetY: number;
  showRegions: boolean;
  showPlacements: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** A drag on a placement, live; committed by the page on release. */
  onMovePlacement: (id: string, x: number, z: number) => void;
  onCommitPlacements: () => void;
  onBeginStroke: () => TerrainStroke;
  onEndStroke: (stroke: TerrainStroke) => void;
  onTouch: () => void;
  onCarve: (columns: Array<{ x: number; z: number }>, top: number, depth: number) => void;
  /** Where an edit gesture landed, so the 3D check can follow the work. */
  onEdited: (x: number, z: number) => void;
  /** A click with the Place tool, in world columns. */
  onPlaceAt: (x: number, z: number) => void;
  /** Reported on hover so the page can show a readout instead of putting one in the canvas. */
  onHover: (info: { x: number; z: number; height: number; stratum: number } | null) => void;
}

/** Pixels per block. Below this the map is unreadable; above it, one column fills the screen. */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;

export function WorldMap(props: WorldMapProps) {
  const { doc, revision, tool, brush, stratum, targetY, selected } = props;
  const { settings } = doc;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** The terrain raster at one pixel per column, scaled up on draw. */
  const rasterRef = useRef<HTMLCanvasElement | null>(null);

  const [view, setView] = useState({ zoom: 1, x: 0, z: 0 });
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [cursor, setCursor] = useState<{ x: number; z: number } | null>(null);

  /**
   * Live gesture state, in a ref rather than in state.
   *
   * A drag updates this on every pointer move, and routing that through React would re-render
   * the whole map sixty times a second to move a circle. The terrain writes are what the user
   * sees, and those go through `onTouch`.
   */
  const drag = useRef<
    | { kind: 'pan'; startX: number; startY: number; fromX: number; fromZ: number }
    | { kind: 'terrain'; stroke: TerrainStroke; lastX: number; lastZ: number }
    | { kind: 'carve'; cells: Array<{ x: number; z: number }>; lastX: number; lastZ: number }
    | { kind: 'move'; id: string; grabX: number; grabZ: number; originX: number; originZ: number; lastX: number; lastZ: number }
    | null
  >(null);

  // Fit the canvas to its box and to the device's pixel ratio. A canvas sized only in CSS is
  // drawn at one device pixel per CSS pixel and looks soft on every laptop made since 2016.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const rect = host.getBoundingClientRect();
      setSize({ w: Math.max(1, Math.round(rect.width)), h: Math.max(1, Math.round(rect.height)) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  /** Screen pixels per block. */
  const scale = view.zoom;

  const toWorld = useCallback(
    (px: number, pz: number) => ({
      x: Math.floor((px - view.x) / scale),
      z: Math.floor((pz - view.z) / scale),
    }),
    [view.x, view.z, scale],
  );

  // Centre the map the first time it is measured, and whenever the plot changes size — an
  // opened world whose camera sits off its own corner reads as an empty map.
  useEffect(() => {
    setView((current) => {
      const fit = Math.min(size.w / settings.size.x, size.h / settings.size.z) * 0.9;
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fit));
      return {
        zoom,
        x: (size.w - settings.size.x * zoom) / 2,
        z: (size.h - settings.size.z * zoom) / 2,
      };
    });
    // Deliberately not `current.zoom`: this is the reset, and it runs only on these three.
  }, [settings.size.x, settings.size.z, size.w, size.h]);

  /**
   * Repaint the terrain raster.
   *
   * One `ImageData` the size of the map in columns, so the cost is the column count and not
   * the pixel count — zooming in costs nothing, which is the property that makes this viable
   * at 2048². The hillshade compares each column to its west and north neighbours, which is
   * the cheapest gradient that still shows a slope's direction rather than only its steepness.
   */
  useEffect(() => {
    const { x: sx, z: sz } = settings.size;
    let raster = rasterRef.current;
    if (!raster || raster.width !== sx || raster.height !== sz) {
      raster = document.createElement('canvas');
      raster.width = sx;
      raster.height = sz;
      rasterRef.current = raster;
    }
    const context = raster.getContext('2d');
    if (!context) return;

    const image = context.createImageData(sx, sz);
    const pixels = image.data;
    const { height, strata } = doc.terrain;

    // Cached per stratum: `profileColor` parses a block ref, and doing that a million times is
    // the difference between a repaint you cannot see and one you can.
    const swatches = settings.strata.map((profile) => profileColor(profile));
    const water = [58, 104, 162] as const;

    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const index = z * sx + x;
        const y = height[index] ?? settings.minY;
        const offset = index * 4;

        if (isEmptyColumn(settings, y)) {
          // A hole through to the void. Rendered as the page's own ground rather than as a
          // colour of its own, so it reads as absence and not as a material.
          pixels[offset] = 24;
          pixels[offset + 1] = 26;
          pixels[offset + 2] = 32;
          pixels[offset + 3] = 255;
          continue;
        }

        const under = y < settings.seaLevel;
        const base = under ? water : (swatches[strata[index] ?? 0] ?? swatches[0] ?? [128, 128, 128]);

        const west = x > 0 ? (height[index - 1] ?? y) : y;
        const north = z > 0 ? (height[index - sx] ?? y) : y;
        // Clamped hard: a cliff is a 200-block step, and an unbounded gradient would make the
        // whole map either black or white the moment one appears.
        const slope = Math.max(-8, Math.min(8, (y - west) + (y - north)));
        let light = 1 + slope * 0.06;
        if (under) {
          // Deeper water reads darker, which is what makes a coastline legible at a glance.
          light *= Math.max(0.45, 1 - (settings.seaLevel - y) * 0.03);
        }

        pixels[offset] = clampByte(base[0] * light);
        pixels[offset + 1] = clampByte(base[1] * light);
        pixels[offset + 2] = clampByte(base[2] * light);
        pixels[offset + 3] = 255;
      }
    }

    context.putImageData(image, 0, 0);

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.w * ratio);
    canvas.height = Math.round(size.h * ratio);
    const out = canvas.getContext('2d');
    if (!out) return;
    out.setTransform(ratio, 0, 0, ratio, 0, 0);
    out.clearRect(0, 0, size.w, size.h);
    // Smoothing off: at high zoom a column is a square of ground, and interpolating between
    // them turns a painted edge into a gradient that does not exist in the world.
    out.imageSmoothingEnabled = false;
    out.drawImage(raster, view.x, view.z, sx * scale, sz * scale);
  }, [doc, revision, settings, size.w, size.h, view.x, view.z, scale]);

  /** Which columns a stroke should touch between two samples, brush applied at each. */
  const applyTerrain = useCallback(
    (stroke: TerrainStroke, fromX: number, fromZ: number, toX: number, toZ: number) => {
      const { terrain } = doc;
      interpolate(fromX, fromZ, toX, toZ, (x, z) => {
        // Note before writing: the recorder keeps the value from the column's *first* touch,
        // and a brush dragged in a circle crosses its own path constantly.
        stampDisc(terrain, settings, x, z, brush, (column) => stroke.note(terrain, column.index));
        if (tool === 'raise') raiseDisc(terrain, settings, x, z, brush);
        else if (tool === 'lower') raiseDisc(terrain, settings, x, z, { ...brush, strength: -brush.strength });
        else if (tool === 'level') levelDisc(terrain, settings, x, z, brush, targetY);
        else if (tool === 'smooth') smoothDisc(doc, x, z, brush);
        else if (tool === 'paint') paintDisc(terrain, settings, x, z, brush, stratum);
      });
    },
    [doc, settings, brush, tool, targetY, stratum],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const host = hostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const pz = event.clientY - rect.top;
      const world = toWorld(px, pz);

      // Middle button and space-drag pan regardless of tool, so a sculpting session never has
      // to leave the brush to look somewhere else.
      if (event.button === 1 || event.shiftKey || tool === 'pan') {
        drag.current = { kind: 'pan', startX: px, startY: pz, fromX: view.x, fromZ: view.z };
        capture(host, event.pointerId);
        return;
      }
      if (event.button !== 0) return;

      if (tool === 'select') {
        const hit = hitPlacement(doc, world.x, world.z);
        props.onSelect(hit?.id ?? null);
        if (hit) {
          drag.current = {
            kind: 'move', id: hit.id,
            grabX: world.x, grabZ: world.z, originX: hit.x, originZ: hit.z,
            lastX: world.x, lastZ: world.z,
          };
          capture(host, event.pointerId);
        }
        return;
      }

      if (tool === 'place') {
        // A click, not a drag: a building is dropped where you point rather than painted along
        // a stroke. Falling through to the terrain path — which is what happened before this
        // branch existed — ran a brush whose tool matched none of the write cases, so Place
        // noted a few hundred columns, changed nothing, and discarded the empty stroke. It
        // looked exactly like a dead button, which it was.
        props.onPlaceAt(world.x, world.z);
        return;
      }

      if (tool === 'carve') {
        drag.current = { kind: 'carve', cells: [world], lastX: world.x, lastZ: world.z };
        capture(host, event.pointerId);
        return;
      }

      const stroke = props.onBeginStroke();
      applyTerrain(stroke, world.x, world.z, world.x, world.z);
      drag.current = { kind: 'terrain', stroke, lastX: world.x, lastZ: world.z };
      capture(host, event.pointerId);
      props.onTouch();
    },
    [doc, tool, view.x, view.z, toWorld, applyTerrain, props],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const host = hostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const pz = event.clientY - rect.top;
      const world = toWorld(px, pz);
      setCursor(world);

      const active = drag.current;
      if (!active) {
        const index = columnIndex(settings, world.x, world.z);
        props.onHover(
          index < 0
            ? null
            : {
                x: world.x, z: world.z,
                height: doc.terrain.height[index] ?? settings.minY,
                stratum: doc.terrain.strata[index] ?? 0,
              },
        );
        return;
      }

      if (active.kind === 'pan') {
        setView((current) => ({
          ...current,
          x: active.fromX + (px - active.startX),
          z: active.fromZ + (pz - active.startY),
        }));
        return;
      }

      if (active.kind === 'move') {
        active.lastX = world.x;
        active.lastZ = world.z;
        props.onMovePlacement(
          active.id,
          active.originX + (world.x - active.grabX),
          active.originZ + (world.z - active.grabZ),
        );
        return;
      }

      if (active.kind === 'carve') {
        interpolate(active.lastX, active.lastZ, world.x, world.z, (x, z) => {
          stampDisc(doc.terrain, settings, x, z, brush, (column) => {
            active.cells.push({ x: column.x, z: column.z });
          });
        });
        active.lastX = world.x;
        active.lastZ = world.z;
        return;
      }

      applyTerrain(active.stroke, active.lastX, active.lastZ, world.x, world.z);
      active.lastX = world.x;
      active.lastZ = world.z;
      props.onTouch();
    },
    [doc, settings, brush, toWorld, applyTerrain, props],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const active = drag.current;
      drag.current = null;
      try {
        hostRef.current?.releasePointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone. Releasing a capture that no longer exists throws, and
        // letting that escape would abandon the stroke without ever recording its undo entry.
      }
      if (!active) return;
      if (active.kind === 'terrain') props.onEndStroke(active.stroke);
      else if (active.kind === 'move') props.onCommitPlacements();
      else if (active.kind === 'carve') props.onCarve(active.cells, targetY, Math.max(1, Math.round(brush.strength)));
      if (active.kind !== 'pan') props.onEdited(active.lastX ?? 0, active.lastZ ?? 0);
    },
    [props, targetY, brush.strength],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const host = hostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const pz = event.clientY - rect.top;
      setView((current) => {
        const factor = Math.exp(-event.deltaY * 0.0015);
        const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom * factor));
        // Keep the column under the pointer under the pointer. Zooming to the centre instead
        // means every zoom is followed by a pan to find what you were looking at.
        const k = zoom / current.zoom;
        return { zoom, x: px - (px - current.x) * k, z: pz - (pz - current.z) * k };
      });
    },
    [],
  );

  const regions = useMemo(() => (props.showRegions ? regionCount(settings) : null), [props.showRegions, settings]);

  const placements = props.showPlacements ? doc.placements : [];

  return (
    <div
      ref={hostRef}
      className="worldmap"
      data-tool={tool}
      data-columns={settings.size.x * settings.size.z}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        setCursor(null);
        props.onHover(null);
      }}
      onWheel={onWheel}
    >
      <canvas ref={canvasRef} style={{ width: size.w, height: size.h }} />

      <svg className="worldmap__overlay" width={size.w} height={size.h}>
        <g transform={`translate(${view.x} ${view.z}) scale(${scale})`}>
          <rect
            className="worldmap__bounds"
            x={0} y={0}
            width={settings.size.x} height={settings.size.z}
            vectorEffect="non-scaling-stroke"
          />

          {regions && (
            <g className="worldmap__regions">
              {range(regions.x + 1).map((i) => (
                <line
                  key={`v${i}`}
                  x1={Math.min(i * settings.regionSize, settings.size.x)} y1={0}
                  x2={Math.min(i * settings.regionSize, settings.size.x)} y2={settings.size.z}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {range(regions.z + 1).map((i) => (
                <line
                  key={`h${i}`}
                  x1={0} y1={Math.min(i * settings.regionSize, settings.size.z)}
                  x2={settings.size.x} y2={Math.min(i * settings.regionSize, settings.size.z)}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          )}

          {placements.map((placement) => {
            const box = placementFootprint(placement);
            return (
              <g
                key={placement.id}
                className="worldmap__place"
                data-selected={placement.id === selected ? 'true' : undefined}
              >
                <rect
                  x={box.x} y={box.z} width={box.w} height={box.d}
                  vectorEffect="non-scaling-stroke"
                />
                {scale >= 0.5 && (
                  <text x={box.x + box.w / 2} y={box.z + box.d / 2} fontSize={Math.min(box.d / 2, 12 / scale)}>
                    {placement.name}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {cursor && isBrushTool(tool) && (
          <circle
            className="worldmap__brush"
            cx={view.x + (cursor.x + 0.5) * scale}
            cy={view.z + (cursor.z + 0.5) * scale}
            r={Math.max(3, brush.radius * scale)}
          />
        )}
      </svg>
    </div>
  );
}

/**
 * Claim the pointer for the rest of the gesture.
 *
 * Guarded because `setPointerCapture` throws on a pointer the browser no longer considers
 * active — which happens for real when a device is unplugged mid-drag, and when a synthetic
 * event is dispatched by a test. Neither is a reason to abandon the stroke: capture is an
 * optimisation that keeps the drag alive outside the element, not a precondition for it.
 */
function capture(host: HTMLElement, pointerId: number): void {
  try {
    host.setPointerCapture(pointerId);
  } catch {
    // Without capture the drag ends when the pointer leaves the map, which is survivable.
  }
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value | 0;
}

function range(n: number): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => i);
}

function isBrushTool(tool: WorldTool): boolean {
  return tool !== 'select' && tool !== 'pan' && tool !== 'place';
}

/**
 * Average a disc towards its own neighbourhood.
 *
 * Not in core with the other brushes because it is the one that has to read the heightfield
 * while writing it, and doing that in place makes the result depend on iteration order — drag
 * left and you get a different hill than dragging right. Sampling into a buffer first is what
 * makes a smoothed slope symmetric, and it is cheap: the buffer is the disc, not the map.
 */
function smoothDisc(doc: WorldDoc, cx: number, cz: number, brush: TerrainBrush): void {
  const { terrain, settings } = doc;
  const sampled: Array<{ index: number; x: number; z: number; weight: number }> = [];
  stampDisc(terrain, settings, cx, cz, brush, (column, weight) => {
    sampled.push({ index: column.index, x: column.x, z: column.z, weight });
  });

  const width = settings.size.x;
  for (const { index, x, z, weight } of sampled) {
    let total = 0;
    let count = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= width || nz >= settings.size.z) continue;
        total += terrain.height[nz * width + nx] ?? 0;
        count++;
      }
    }
    if (count === 0) continue;
    const current = terrain.height[index] ?? 0;
    const blend = Math.max(0, Math.min(1, weight));
    terrain.height[index] = Math.round(current + (total / count - current) * blend);
  }
}

/** The topmost placement covering a column, so a building on a plaza selects before the plaza. */
function hitPlacement(doc: WorldDoc, x: number, z: number): WorldPlacement | null {
  for (let i = doc.placements.length - 1; i >= 0; i--) {
    const placement = doc.placements[i]!;
    const box = placementFootprint(placement);
    if (x >= box.x && z >= box.z && x < box.x + box.w && z < box.z + box.d) return placement;
  }
  return null;
}
