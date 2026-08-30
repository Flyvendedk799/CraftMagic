/**
 * The editor page.
 *
 * Three features are on show and they pull in different directions, which is why they are
 * implemented differently. The **layer slider** must never re-mesh — it is a clipping plane,
 * so scrubbing a 200k-block build costs one uniform. The **param slider** must re-expand:
 * that is the whole point of the IR, and re-running `expand()` is what keeps walls on the
 * walls instead of stretching them. **Manual edits** are the awkward third: they write
 * straight to the voxels, so they are exactly what re-expanding destroys. That conflict is
 * settled here — the page holds the confirmation, `useEditSession` holds the evidence.
 *
 * View state lives in the query string (`?build=tower&p.height=24&layer=6&only=1`). It costs
 * nothing, makes a view linkable, and lets a headless screenshot reach any of these states
 * without a driver. Edits deliberately do not: a URL that claimed to describe an edited
 * build would be a lie the moment it was shared.
 *
 * The tools themselves are pure functions in `tools/`, and this file is the only place that
 * knows a pointer exists. Every branch of `onCanvasClick` does the same three things —
 * resolve a palette slot, ask a tool for an op, hand the op to the session — which is what
 * lets a new tool be a new function and a row in `toolset.ts` rather than a new subsystem.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AIR_BLOCK,
  displayName,
  expand,
  labelParts,
  paletteColors,
  paletteFlags,
  readSchematic,
  STYLE_PACKS,
  voxelIndex,
  type Vec3,
} from '@craftmagic/core';
import { Outliner, type OutlinePart } from './Outliner.js';
import { EditorCanvas, type ViewKind, type ViewRequest } from './EditorCanvas.js';
import { chunkCounts } from './mesher.js';
import {
  BLANK_BUILD,
  BUILD_IDS,
  expandBuild,
  generatedBuilds,
  importedBuilds,
  isBuildId,
  muralBuilds,
  paramsOf,
  previewScale,
  baseSize,
  programScale,
  NO_SCALE,
  type ScalePercent,
  registerGeneratedBuild,
  registerImportedBuild,
} from './builds.js';
import { useLibraryBuild } from '../library/useLibraryBuild.js';
import {
  carrySettings,
  parseScale,
  scaleKey as readScaleKey,
  writeScale,
  PARAM_PREFIX,
  SCALE_PREFIX,
  STYLE_PARAM,
} from './urlState.js';
import { ExportBar } from './ExportBar.js';
import { ScalePanel } from './ScalePanel.js';
import { Section } from './Section.js';
import { ShortcutHelp } from './ShortcutHelp.js';
import { EDITOR_SHORTCUTS, EDITOR_SHORTCUT_FOOT } from './shortcuts.js';
import { ToolPalette, type RegionAction } from './ToolPalette.js';
import { toolForKey, TOOL_BY_ID, type ToolId } from './toolset.js';
import { previewFor } from './preview.js';
import { useAssembly } from './useAssembly.js';
import { useEditSession } from './useEditSession.js';
import { TOOL_IMPL, type EditorTool, type ToolCtx, type ToolResult } from './tools/registry.js';
import { withMirror } from './tools/symmetry.js';
import { pickBlock } from './tools/pick.js';
import { boxBounds, boxEdit, moveEdit, type BoxCorner } from './tools/boxSelect.js';
import { MAX_BRUSH_RADIUS, type BrushShape } from './tools/brush.js';
import {
  ClipTooLargeError,
  copyRegion,
  mirrorClip,
  rotateClip,
  stampBounds,
  stampEdit,
  type Clip,
  type StampMode,
} from './tools/clipboard.js';
import { PromptPanel } from '../generate/PromptPanel.js';
import { ImagePanel } from '../image/ImagePanel.js';
import { useGeneration, type GenerationResult } from '../generate/useGeneration.js';
import { AccountPanel } from '../library/AccountPanel.js';
import { useAuth } from '../library/auth.js';
import { AppNav } from '../shell/AppNav.js';
import type { VoxelHit } from './raycast.js';
import './editor.css';
import '../image/image.css';

/**
 * A first visit opens on an empty plot, not on somebody else's cottage.
 *
 * Landing on a finished sample made the product read as a gallery: the thing the visitor came
 * to do — describe a build — was the least prominent element on screen, and every sample they
 * saw was already made. The samples are still one click away in the picker.
 */
const DEFAULT_BUILD = BLANK_BUILD;

/** Common enough to be a sane starting block, and present in most sample palettes. */
const DEFAULT_BLOCK = 'minecraft:oak_planks';

/** Where the Classic/Enhanced choice lives between visits. */
const RENDER_STYLE_KEY = 'craftmagic.renderStyle';

/** While the ghost build is showing, the session must not be handed the ghost's world. */
const noopWorld = () => {};

/** Provenance bounds are Vec3 tuples; the camera and outlines speak {x,y,z}. */
function partBounds(part: { min?: Vec3; max?: Vec3 }): { min: BoxCorner; max: BoxCorner } | null {
  if (!part.min || !part.max) return null;
  return {
    min: { x: part.min[0], y: part.min[1], z: part.min[2] },
    max: { x: part.max[0], y: part.max[1], z: part.max[2] },
  };
}

const BUILD_LABELS: Record<string, string> = {
  blank: 'Empty',
  cottage: 'Cottage',
  tower: 'Tower',
  pavilion: 'Pavilion',
  field: 'Stress test',
};

const VIEWS: readonly { kind: ViewKind; label: string }[] = [
  { kind: 'iso', label: 'Iso' },
  { kind: 'top', label: 'Top' },
  { kind: 'front', label: 'Front' },
  { kind: 'side', label: 'Side' },
];

/** A navigation that would re-expand the program, held back until the user confirms. */
type PendingNav =
  | { kind: 'build'; build: string }
  | { kind: 'param'; name: string; value: number }
  | { kind: 'scale'; scale: ScalePercent }
  | { kind: 'style'; style: string | null };

export function EditorPage() {
  const [params, setParams] = useSearchParams();
  const [hover, setHover] = useState<VoxelHit | null>(null);
  // -1 until the first frame reports, so `data-remaining="0"` unambiguously means "meshed".
  const [remaining, setRemaining] = useState(-1);

  // A prompt handed over by the dashboard's launcher: read once, then removed from the URL.
  // It seeds the prompt box and nothing else. Left in the query it would put a half-written
  // sentence into every link copied out of the editor, and would re-seed the box over whatever
  // had been typed since on any reload — the rule here is that the query describes the build on
  // screen, and a prompt is not one.
  const [seededPrompt] = useState(() => params.get('prompt') ?? '');

  useEffect(() => {
    if (!params.has('prompt')) return;
    setParams(
      (prev) => {
        const search = new URLSearchParams(prev);
        search.delete('prompt');
        return search;
      },
      { replace: true },
    );
  }, [params, setParams]);

  const rawBuild = params.get('build');

  // A library build lives in the database rather than in the bundle, so `?build=lib:<id>`
  // has to be fetched before it can be expanded. Fetching on demand rather than caching it in
  // the browser is what makes the deep link survive a reload and, more importantly, what stops
  // it from ever showing a stale copy of a build that was renamed or deleted elsewhere.
  //
  // Shared with the guide, which needs the same build from the same URL — see
  // `useLibraryBuild` for why that must not be two copies of the same rule.
  const fetching = useLibraryBuild(rawBuild);

  const buildId = isBuildId(rawBuild) ? rawBuild : DEFAULT_BUILD;

  // Only param values may re-expand. Keying the memo on a string of just those keeps the
  // layer slider — which lives in the same query string — from rebuilding the world.
  const overrideKey = paramsOf(buildId)
    .map((spec) => `${spec.name}=${params.get(PARAM_PREFIX + spec.name) ?? ''}`)
    .join('&');

  // Scale keyed as a string for the same reason as params: the memo must not re-run because
  // an object literal is a new object every render.
  const scaleKey = readScaleKey(params);
  const scale = useMemo(() => parseScale(scaleKey), [scaleKey]);
  const styleId = params.get(STYLE_PARAM);

  // Components hidden through the outliner. View state, not program state: kept per build id
  // and reset on switch, because `components[3]` means something different in every program.
  const [hidden, setHidden] = useState<{ id: string; paths: readonly string[] }>({
    id: buildId,
    paths: [],
  });
  const hiddenPaths = hidden.id === buildId ? hidden.paths : [];
  const hiddenKey = hiddenPaths.join('|');

  const build = useMemo(
    () =>
      expandBuild(buildId, {
        params: parseOverrides(overrideKey),
        scale: parseScale(scaleKey),
        style: styleId,
        hide: hiddenPaths,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hiddenPaths is keyed by hiddenKey
    [buildId, overrideKey, scaleKey, styleId, hiddenKey],
  );
  const session = useEditSession(build);
  // The opening reveal. It owns the canvas's grid and world handle while it runs; the
  // session takes over the moment it finishes, through the same remount the canvas would
  // have done anyway. Any click during the reveal skips to the finished build.
  const assembly = useAssembly(build);

  /**
   * The outliner's part list, from a provenance expansion of the FULL program — hidden
   * components included, or their rows would vanish and nothing could bring them back.
   *
   * Computed a beat after the build settles rather than inline: provenance costs a parallel
   * array plus a measuring pass, and the main expansion runs on every frame of a slider
   * drag. The delay means a drag re-schedules instead of paying that price per frame.
   */
  const [outline, setOutline] = useState<{ key: string; parts: OutlinePart[] } | null>(null);
  const outlineKey = `${buildId}|${overrideKey}|${scaleKey}|${styleId ?? ''}`;
  useEffect(() => {
    if (!build.program) {
      setOutline(null);
      return;
    }
    const timer = setTimeout(() => {
      const full = expandBuild(
        buildId,
        { params: parseOverrides(overrideKey), scale: parseScale(scaleKey), style: styleId },
        { provenance: true },
      );
      setOutline({ key: outlineKey, parts: labelParts(full.parts, full.grid.size) });
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- outlineKey carries the inputs
  }, [outlineKey, build.program === null]);
  const outlineParts = outline?.key === outlineKey ? outline.parts : null;

  /** The part outlined in the canvas while the pointer rests on its outliner row. */
  const [partHighlight, setPartHighlight] = useState<{ min: BoxCorner; max: BoxCorner } | null>(null);

  const onPartToggle = useCallback(
    (path: string) => {
      setPartHighlight(null);
      setHidden((prev) => {
        const paths = prev.id === buildId ? prev.paths : [];
        return {
          id: buildId,
          paths: paths.includes(path) ? paths.filter((p) => p !== path) : [...paths, path],
        };
      });
    },
    [buildId],
  );
  const onPartSolo = useCallback(
    (path: string) => {
      setPartHighlight(null);
      setHidden({
        id: buildId,
        paths: (outlineParts ?? []).map((part) => part.path).filter((p) => p !== path),
      });
    },
    [buildId, outlineParts],
  );
  const onPartsShowAll = useCallback(() => setHidden({ id: buildId, paths: [] }), [buildId]);
  const onPartFocus = useCallback((part: { min?: Vec3; max?: Vec3 }) => {
    const bounds = partBounds(part);
    if (!bounds) return;
    setView((prev) => ({ kind: 'iso', nonce: (prev?.nonce ?? 0) + 1, focus: bounds }));
  }, []);
  const onPartHighlight = useCallback((part: { min?: Vec3; max?: Vec3 } | null) => {
    setPartHighlight(part ? partBounds(part) : null);
  }, []);

  const { grid, name } = build;

  const scalePreview = useMemo(() => previewScale(buildId, scale), [buildId, scale]);
  const scaleBase = useMemo(() => baseSize(buildId), [buildId]);

  /**
   * The program a refine would edit, or null when refining makes no sense.
   *
   * Null for the empty plot (nothing to change) and for voxel-only builds (murals, old
   * detached saves — no program to send). Hand edits no longer disable refine: they live in
   * the overlay, the model refines the *program*, and the edits composite back over the
   * refined expansion when it lands.
   */
  const refineTarget = buildId !== BLANK_BUILD ? build.program : null;
  const topLayer = grid.size.y - 1;
  const layer = readLayer(params.get('layer'), topLayer);
  // Isolate is meaningless without a cut, so it follows the layer rather than standing alone.
  const isolate = layer !== null && params.get('only') === '1';

  const totalChunks = useMemo(() => {
    const counts = chunkCounts(grid.size);
    return counts.x * counts.y * counts.z;
  }, [grid.size]);

  // The guide reads the same query convention as the editor, so it renders exactly the
  // build on screen — including whatever the param sliders are currently set to.
  //
  // Offered for library builds too, now that the guide fetches one itself. It used
  // to be withheld for them because the guide could only resolve ids already in the bundle,
  // and `/guide?build=lib:<id>` opened on the default build and printed the wrong thing.
  const guideHref = useMemo(() => {
    const search = new URLSearchParams();
    search.set('build', buildId);
    // Params *and* scale: the guide prints the build on screen, and a resized one is a
    // different build to put together block by block.
    carrySettings(params, search);
    return `/guide?${search.toString()}`;
  }, [buildId, params]);

  /**
   * Write view state to the query string.
   *
   * Seeded from `window.location.search` rather than from the `prev` React Router hands
   * over, and the stepping and toggling forms (`layerStep`, `toggleIsolate`) are resolved
   * there rather than against this render's values. Both are the same fix for the same bug:
   * `useSearchParams` closes its setter over the params of the render it came from, and a
   * navigation updates the URL synchronously but only re-renders later. On a 200k-block
   * build that gap is long enough to press two keys in, and pressing `[` then `I` quickly
   * left the second one looking at a query string with no `layer` in it, so isolate did
   * nothing at all. The location is always at least as fresh as `prev`, never less.
   */
  const update = useCallback(
    (next: {
      build?: string;
      layer?: number | null;
      /** Move the cut by this many layers, from wherever it currently is. */
      layerStep?: number;
      only?: boolean;
      /** Flip isolate, when there is a cut to isolate. */
      toggleIsolate?: boolean;
      param?: { name: string; value: number };
      scale?: ScalePercent | null;
      style?: string | null;
    }) => {
      setParams(
        () => {
          const search = new URLSearchParams(window.location.search);
          if (next.build !== undefined) {
            search.set('build', next.build);
            // Layers, params and the restyle are per-build; carrying any across is meaningless.
            search.delete('layer');
            search.delete('only');
            search.delete(STYLE_PARAM);
            for (const key of [...search.keys()]) {
              if (key.startsWith(PARAM_PREFIX) || key.startsWith(SCALE_PREFIX)) search.delete(key);
            }
          }
          if (next.param) search.set(PARAM_PREFIX + next.param.name, String(next.param.value));
          if (next.scale !== undefined) writeScale(search, next.scale);
          if (next.style !== undefined) {
            if (next.style === null) search.delete(STYLE_PARAM);
            else search.set(STYLE_PARAM, next.style);
          }
          if (next.layer !== undefined) {
            if (next.layer === null) {
              search.delete('layer');
              // Nothing to isolate once the whole build is showing again.
              search.delete('only');
            } else search.set('layer', String(next.layer));
          }
          if (next.layerStep !== undefined) {
            const current = readLayer(search.get('layer'), topLayer) ?? topLayer;
            search.set('layer', String(Math.max(0, Math.min(topLayer, current + next.layerStep))));
          }
          if (next.only !== undefined) {
            if (next.only) search.set('only', '1');
            else search.delete('only');
          }
          if (next.toggleIsolate && search.has('layer')) {
            if (search.get('only') === '1') search.delete('only');
            else search.set('only', '1');
          }
          return search;
        },
        { replace: true },
      );
      if (next.build !== undefined) setHover(null);
    },
    [setParams, topLayer],
  );

  // --- editing ------------------------------------------------------------

  const [tool, setTool] = useState<ToolId>('place');
  const [block, setBlock] = useState<string>(DEFAULT_BLOCK);
  /**
   * The box the Box tool has standing, if any.
   *
   * Kept as corners rather than as normalised bounds: it is nudged and grown, and re-clamping
   * against the grid on every read is what stops a box that was pushed against an edge from
   * quietly staying there when it is pushed back.
   */
  const [region, setRegion] = useState<{ min: BoxCorner; max: BoxCorner } | null>(null);
  const [familyMode, setFamilyMode] = useState(false);
  const [anchor, setAnchor] = useState<BoxCorner | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [brushRadius, setBrushRadius] = useState(0);
  const [brushShape, setBrushShape] = useState<BrushShape>('ball');
  const [clip, setClip] = useState<Clip | null>(null);
  const [stampMode, setStampMode] = useState<StampMode>('merge');
  /** Symmetry mode: drawing tools land twice, mirrored across the build's X midplane. */
  const [symmetry, setSymmetry] = useState(false);
  const [help, setHelp] = useState(false);
  const [view, setView] = useState<ViewRequest | null>(null);
  // Enhanced is the default — the lit, grained, sky-lit look is the product's face now.
  // Classic remains one click away, persisted, for anyone (or any GPU) that prefers flat.
  const [enhanced, setEnhanced] = useState(() => {
    try {
      return localStorage.getItem(RENDER_STYLE_KEY) !== 'classic';
    } catch {
      return true;
    }
  });
  const toggleEnhanced = useCallback(() => {
    setEnhanced((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(RENDER_STYLE_KEY, next ? 'enhanced' : 'classic');
      } catch {
        // Storage blocked — the choice still applies to this page view.
      }
      return next;
    });
  }, []);
  // Deliberately not persisted: orthographic is a working view you reach for, not a home.
  const [ortho, setOrtho] = useState(false);

  const onTool = useCallback((next: ToolId) => {
    setTool(next);
    setAnchor(null);
    setNotice(null);
    // The box belongs to the Box tool. Leaving it drawn behind a brush would be a selection
    // nothing on screen could act on.
    if (next !== 'select') setRegion(null);
  }, []);

  // The screenshot-taker the canvas hands over on mount. A ref, not state: nothing renders
  // differently for having it, and it changes on every canvas remount.
  const snapshotRef = useRef<(() => string) | null>(null);
  const registerSnapshot = useCallback((take: (() => string) | null) => {
    snapshotRef.current = take;
  }, []);
  const takeScreenshot = useCallback(() => {
    const dataUrl = snapshotRef.current?.();
    if (!dataUrl) return;
    const anchor = document.createElement('a');
    anchor.href = dataUrl;
    anchor.download = `${name.replace(/[^\w\- ]+/g, '').trim() || 'build'}.png`;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [name]);

  const setViewKind = useCallback((kind: ViewKind) => {
    // A new nonce every time, so pressing the same preset twice really does re-frame — the
    // whole reason to reach for it is usually that the camera has wandered.
    setView((prev) => ({ kind, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const stepBrush = useCallback((delta: number) => {
    setBrushRadius((prev) => Math.max(0, Math.min(MAX_BRUSH_RADIUS, prev + delta)));
  }, []);

  const stepLayer = useCallback((delta: number) => update({ layerStep: delta }), [update]);

  const rotateClipboard = useCallback(() => {
    setClip((prev) => (prev ? rotateClip(prev, 1) : prev));
    setNotice('Clipboard rotated 90°.');
  }, []);

  const mirrorClipboard = useCallback((axis: 'x' | 'z' = 'x') => {
    setClip((prev) => (prev ? mirrorClip(prev, axis) : prev));
    setNotice(`Clipboard mirrored ${axis === 'x' ? 'east–west' : 'north–south'}.`);
  }, []);

  /** Non-air blocks inside the standing box, so Clear and Copy are not blind. */
  const regionFilled = useMemo(() => {
    if (!region) return 0;
    const { min, max } = boxBounds(grid, region.min, region.max);
    let count = 0;
    for (let y = min.y; y <= max.y; y++) {
      for (let z = min.z; z <= max.z; z++) {
        for (let x = min.x; x <= max.x; x++) {
          if (grid.voxels[voxelIndex(grid.size, x, y, z)] !== 0) count++;
        }
      }
    }
    return count;
  }, [region, grid, session.edits]);

  const regionAction = useCallback(
    (action: RegionAction) => {
      if (!region) return;
      const bounds = boxBounds(grid, region.min, region.max);
      const extent = `${bounds.max.x - bounds.min.x + 1}×${bounds.max.y - bounds.min.y + 1}×${
        bounds.max.z - bounds.min.z + 1
      }`;

      if (action === 'copy' || action === 'cut') {
        try {
          const copied = copyRegion(grid, region.min, region.max);
          setClip(copied);
          // Straight to the tool that uses it: copying is never the goal, and the box is left
          // standing so coming back to it costs nothing.
          setTool('stamp');
          if (action === 'cut') {
            session.apply(boxEdit(grid, region.min, region.max, 'clear', 0));
          }
          setNotice(
            `${action === 'cut' ? 'Cut' : 'Copied'} ${extent} — ${copied.blocks.toLocaleString()} blocks. Click to stamp it; R rotates.`,
          );
        } catch (err) {
          setNotice(err instanceof ClipTooLargeError ? err.message : String(err));
        }
        return;
      }

      if (action === 'rotate' || action === 'mirrorX' || action === 'mirrorZ') {
        // In-place transform = copy → clear → stamp back, recentred about the box's own
        // middle so a rotated wing pivots where it stands instead of walking to a corner.
        // Two ops on the undo stack (the clear and the stamp), which is honest: undo once
        // and the transformed copy lifts off, undo twice and the original is back.
        try {
          const copied = copyRegion(grid, region.min, region.max);
          const transformed =
            action === 'rotate'
              ? rotateClip(copied, 1)
              : mirrorClip(copied, action === 'mirrorX' ? 'x' : 'z');
          session.apply(boxEdit(grid, region.min, region.max, 'clear', 0));
          const at = {
            x: Math.max(0, Math.round((bounds.min.x + bounds.max.x) / 2 - (transformed.size.x - 1) / 2)),
            y: bounds.min.y,
            z: Math.max(0, Math.round((bounds.min.z + bounds.max.z) / 2 - (transformed.size.z - 1) / 2)),
          };
          const result = stampEdit(grid, transformed, at, session.resolveBlock, 'merge');
          session.apply(result.op);
          const landed = stampBounds(transformed, at);
          setRegion({ min: landed.min, max: landed.max });
          setNotice(
            action === 'rotate'
              ? `Rotated ${extent} in place — the box follows the new footprint.`
              : `Flipped ${extent} in place.`,
          );
        } catch (err) {
          setNotice(err instanceof ClipTooLargeError ? err.message : String(err));
        }
        return;
      }

      const index = action === 'clear' ? 0 : session.resolveBlock(block);
      if (index < 0) {
        setNotice('Palette is full — this build cannot hold another block type.');
        return;
      }
      const op = boxEdit(grid, region.min, region.max, action, index);
      session.apply(op);
      setNotice(
        op
          ? `${VERB[action]} a ${extent} box — ${op.indices.length.toLocaleString()} blocks changed.`
          : 'Nothing changed — that box already looks like that.',
      );
    },
    [region, grid, block, session],
  );

  const regionNudge = useCallback(
    (dx: number, dy: number, dz: number) => {
      if (!region) return;
      const op = moveEdit(grid, region.min, region.max, dx, dy, dz);
      session.apply(op);
      // The box travels with what it holds. A move that left the box behind would leave the
      // next verb pointed at the hole rather than at the blocks.
      setRegion({
        min: { x: region.min.x + dx, y: region.min.y + dy, z: region.min.z + dz },
        max: { x: region.max.x + dx, y: region.max.y + dy, z: region.max.z + dz },
      });
      setNotice(
        op ? `Moved ${op.indices.length.toLocaleString()} cells.` : 'Nothing inside the box to move.',
      );
    },
    [region, grid, session],
  );

  const regionResize = useCallback(
    (by: number) => {
      if (!region) return;
      const next = {
        min: { x: region.min.x - by, y: region.min.y - by, z: region.min.z - by },
        max: { x: region.max.x + by, y: region.max.y + by, z: region.max.z + by },
      };
      // A shrink that would turn the box inside out is refused rather than clamped to a
      // point: a one-cell box is a meaningful selection, and a zero-cell one is not.
      if (next.max.x < next.min.x || next.max.y < next.min.y || next.max.z < next.min.z) {
        setNotice('The box is already as small as it goes.');
        return;
      }
      const bounds = boxBounds(grid, next.min, next.max);
      setRegion({ min: bounds.min, max: bounds.max });
      setNotice(null);
    },
    [region, grid],
  );

  /**
   * A tool click. Every branch does the same three things — resolve a palette slot, ask a
   * pure tool for an op, hand the op to the session — which is the whole reason the tools
   * take a palette index rather than a block ref and return an op rather than applying one.
   *
   * The two exceptions prove it: `copy` produces a clip instead of an op because it changes
   * nothing, and `pick` produces a block ref for the same reason.
   */
  /** The context a tool call reads — a view over the page's state, built per gesture. */
  const toolCtx = useCallback(
    (): ToolCtx => ({
      grid,
      block,
      brush: { radius: brushRadius, shape: brushShape },
      anchor,
      clip,
      stampMode,
      familyMode,
      resolveBlock: session.resolveBlock,
    }),
    [grid, block, brushRadius, brushShape, anchor, clip, stampMode, familyMode, session],
  );

  /**
   * Apply what a tool decided. This is the whole seam between tools and React: a
   * `ToolResult` is plain data, and every field is optional so a tool only touches the
   * state it means to. Symmetry mode intercepts the op on its way through — the tool never
   * knows it drew twice.
   */
  const runTool = useCallback(
    (impl: EditorTool, result: ToolResult) => {
      if (result.op !== undefined) {
        const op =
          symmetry && impl.mirrorable
            ? withMirror(grid, result.op, session.resolveBlock)
            : result.op;
        session.apply(op);
      }
      if (result.anchor !== undefined) setAnchor(result.anchor);
      if (result.region !== undefined) setRegion(result.region);
      if (result.pickBlock !== undefined) setBlock(result.pickBlock);
      if (result.clip !== undefined) setClip(result.clip);
      if (result.switchTool !== undefined) setTool(result.switchTool);
      if (result.notice !== undefined) setNotice(result.notice);
    },
    [grid, session, symmetry],
  );

  const onCanvasClick = useCallback(
    (hit: VoxelHit) => {
      const impl = TOOL_IMPL[tool];
      // A ground hit names an empty floor cell rather than a block — it is how the first
      // block of an empty build gets placed. Tools that read what is already under the
      // pointer have nothing to read there, and each says so in its own words.
      if (hit.ground && impl.groundRefusal) {
        setNotice(impl.groundRefusal);
        return;
      }
      runTool(impl, impl.onClick(toolCtx(), hit));
    },
    [tool, toolCtx, runTool],
  );

  /**
   * A Shift-drag, delivered once with every cell it crossed.
   *
   * Folded into a single op rather than replayed as one edit per cell: a stroke is one
   * gesture, so it has to be one press of Ctrl+Z. Only tools that implement `onStroke`
   * take it — the canvas reads the absence of the callback as permission to let the drag
   * orbit the camera instead.
   */
  const onStroke = useCallback(
    (hits: VoxelHit[]) => {
      const impl = TOOL_IMPL[tool];
      if (!impl.onStroke) return;
      runTool(impl, impl.onStroke(toolCtx(), hits));
    },
    [tool, toolCtx, runTool],
  );

  /** Alt+click, from any tool: sample the block under the pointer rather than editing it. */
  const onPick = useCallback(
    (hit: VoxelHit) => {
      const picked = pickBlock(grid, hit);
      if (!picked) return;
      setBlock(picked);
      setNotice(`Picked ${displayName(picked)}.`);
    },
    [grid],
  );

  // A box corner is a position in *this* grid. Switching build or moving a param produces a
  // new one, where the same coordinates mean something else entirely.
  useEffect(() => {
    setAnchor(null);
    setNotice(null);
  }, [grid]);

  const preview = useMemo(
    () => previewFor({ grid, tool, hover, anchor, radius: brushRadius, shape: brushShape, clip }),
    [grid, tool, hover, anchor, brushRadius, brushShape, clip],
  );

  // --- keyboard ------------------------------------------------------------

  // Every shortcut reads state that changes on almost every render, and this listener sits on
  // the window. Binding it to the live values would tear down and re-add a listener on every
  // pointer move over the canvas, so the handler is kept in a ref and the listener is bound
  // exactly once.
  const shortcuts = useRef<(event: KeyboardEvent) => void>(() => {});
  shortcuts.current = (event: KeyboardEvent) => {
    // While the shortcut sheet is up it is the only thing on screen, so a key that would
    // change the tool or the brush behind it is not what anyone meant. Escape is the one
    // key that still does something, and the sheet handles that itself.
    if (help) return;

    const picked = toolForKey(event.key);
    if (picked) {
      onTool(picked);
      return;
    }

    switch (event.key) {
      case '[':
        stepLayer(-1);
        return;
      case ']':
        stepLayer(1);
        return;
      case '\\':
        update({ layer: null });
        return;
      case 'i':
      case 'I':
        update({ toggleIsolate: true });
        return;
      case '-':
      case '_':
        stepBrush(-1);
        return;
      case '=':
      case '+':
        stepBrush(1);
        return;
      case 'b':
      case 'B':
        setBrushShape((prev) => (prev === 'ball' ? 'cube' : 'ball'));
        return;
      case 'r':
      case 'R':
        if (clip) rotateClipboard();
        return;
      case 'm':
        if (clip) mirrorClipboard('x');
        return;
      case 'M':
        // Shift+M is the other axis — both flips, no extra key to learn.
        if (clip) mirrorClipboard('z');
        return;
      case 'f':
      case 'F':
        setViewKind('iso');
        return;
      case '?':
        setHelp(true);
        return;
      case 'Escape':
        setAnchor(null);
        setRegion(null);
        setNotice(null);
        return;
      default:
    }
  };

  /**
   * Guarded against firing while someone is typing: the prompt box and the rename field are
   * both on this page, and a shortcut that changes the tool mid-sentence is worse than no
   * shortcut. Modifier combinations are left alone so Ctrl+Z still reaches undo — Shift is
   * not one of them, because `?` and `+` are Shift keys.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;

      const before = event.defaultPrevented;
      shortcuts.current(event);
      // Only swallow keys a shortcut actually claimed — anything else still reaches the
      // browser, which is what keeps Tab, F5 and the like working.
      if (!before && HANDLED.test(event.key)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // --- generation ----------------------------------------------------------

  // Seeded from anything restored out of localStorage, so neither a reload nor a new tab
  // loses builds that were paid for.
  const [saved, setSaved] = useState(() => generatedBuilds());
  const [murals, setMurals] = useState(() => muralBuilds());
  const [imported, setImported] = useState(() => importedBuilds());
  const [importError, setImportError] = useState<string | null>(null);

  /**
   * Open a file as a build: a `.schem` becomes voxels, a program `.json` becomes a program.
   *
   * The two paths land in different stores on purpose — a schematic has no recipe and gets
   * the voxel treatment, while a program JSON re-enters the product exactly where a
   * generated program does, sliders and refine included.
   */
  const onImportFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setImportError(null);
      try {
        if (/\.schem(atic)?$/i.test(file.name)) {
          const grid = readSchematic(new Uint8Array(await file.arrayBuffer()));
          const id = registerImportedBuild(file.name.replace(/\.[^.]+$/, ''), grid);
          setImported(importedBuilds());
          update({ build: id, scale: null });
        } else {
          const parsed: unknown = JSON.parse(await file.text());
          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            !('components' in parsed) ||
            !Array.isArray((parsed as { components: unknown }).components) ||
            !('size' in parsed)
          ) {
            throw new Error('not a build program — expected the JSON the editor exports');
          }
          const id = registerGeneratedBuild(parsed as Parameters<typeof registerGeneratedBuild>[0]);
          setSaved(generatedBuilds());
          update({ build: id, scale: programScale(id) });
        }
      } catch (error) {
        setImportError((error as Error).message);
      }
    },
    [update],
  );
  const [generated, setGenerated] = useState<{ id: string; result: GenerationResult } | null>(null);

  // A generated program is registered like any other build and then simply selected, so it
  // inherits the whole pipeline — expander, mesher, layer clip, and its own param sliders.
  // Nothing here is special-cased for AI output, which is the point of returning a program
  // rather than voxels.
  const onGenerated = useCallback(
    (result: GenerationResult) => {
      const id = registerGeneratedBuild(result.program);
      setGenerated({ id, result });
      setSaved(generatedBuilds());
      // Carrying the program's own scale into the query string is what makes the size control
      // open on the size the build was asked for, rather than showing 100% next to a build
      // that is not at 100%. Dragging it up from there is how the full-detail design is seen.
      update({ build: id, scale: programScale(id) });
    },
    [update],
  );

  const generation = useGeneration(onGenerated);

  /**
   * The ghost build: the program-so-far, expanded and shown in place of the current build
   * while the model is still emitting. This is what turns the 15–60 second wait into
   * watching the structure assemble. Each preview is a fresh expand + world load — at
   * preview cadence (~400ms) and generated-build sizes that is tens of milliseconds — and
   * a preview too large to be worth remeshing live falls back to the count-only progress.
   */
  const ghost = useMemo(() => {
    const phase = generation.phase;
    if (phase.kind !== 'emitting' || !phase.partial) return null;
    try {
      const result = expand(phase.partial);
      if (result.blockCount === 0 || result.blockCount > 150_000) return null;
      return {
        grid: result.grid,
        colors: paletteColors(result.grid.palette),
        flags: paletteFlags(result.grid.palette),
      };
    } catch {
      // expand() does not throw by contract, but a preview must never take the page down.
      return null;
    }
  }, [generation.phase]);

  // Same two conditions the prompt box enforces: a generation is charged to an account's
  // daily allowance, and there has to be budget left to charge.
  const auth = useAuth();
  const canGenerate =
    auth.status === 'signedIn' && !(generation.spend !== null && generation.spend.remainingUsd <= 0);

  /**
   * A picture rebuilt as blocks is selected exactly like any other build.
   *
   * It arrives as voxels rather than a program — nothing parametric describes a photograph —
   * so the editor treats it the way it treats a hand-edited build: every tool works, export
   * works, the guide works, and the size control has nothing to offer and says so by being
   * absent.
   */
  const onMuralBuilt = useCallback(
    (id: string) => {
      setMurals(muralBuilds());
      update({ build: id, scale: null });
    },
    [update],
  );

  // --- re-expansion -------------------------------------------------------

  // This used to be a guard with a confirmation dialog: re-expanding destroyed hand edits,
  // so everything that could re-expand had to ask first. Edits live in an overlay now and
  // ride across every re-expansion, so the guard is a plain dispatcher — kept as a function
  // only so the dozen call sites did not all need rewriting for a behavioural no-op.
  const guard = useCallback((nav: PendingNav) => applyNav(nav, update), [update]);

  const meshed = totalChunks === 0 ? 1 : 1 - remaining / totalChunks;
  const issues = [...build.errors, ...build.warnings];
  // "Air" would be true and useless. A ground hit is the floor, and saying so is what tells
  // someone staring at an empty plot that the click they are about to make will land.
  const hoverBlock = !hover ? null : hover.ground ? 'Ground' : blockAt(grid, hover);
  const strokable = TOOL_IMPL[tool].onStroke !== undefined;

  // After every hook, never before: an early return above one would change the hook order
  // between renders. The cost is expanding the default build while a library one is in
  // flight, which is a few milliseconds nobody sees.
  if (fetching.loading || fetching.error !== null) {
    return (
      <>
        <AppNav current="editor" />
        <div className="library" data-ready={fetching.error ? '1' : '0'}>
          <section className="panel">
            <h2>{fetching.error ? 'Could not open that build' : 'Opening build…'}</h2>
            <p className="library__empty">{fetching.error ?? 'Fetching it from your library.'}</p>
            {fetching.error && (
              <p className="library__empty" style={{ marginTop: '1rem' }}>
                <Link to="/library">← Back to the library</Link>
              </p>
            )}
          </section>
        </div>
      </>
    );
  }

  return (
    // `data-remaining` is the headless smoke test's readiness signal: the mesh pipeline is
    // asynchronous across a worker, so a screenshot driver has nothing else to wait on.
    // `data-edits` serves the same purpose for the editing tools.
    <div
      className="editor"
      data-remaining={remaining}
      data-build={buildId}
      data-edits={session.edits}
      data-detached={session.detached}
      data-tool={tool}
    >
      {/* The same bar every other signed-in page wears. It used to be withheld here on the
          grounds that the editor is a full-viewport canvas with its own HUD — but that made
          this the one room in the product with no visible way out, and the HUD had grown a
          stack of plain-text links down at the bottom to compensate. A strip of chrome costs
          three and a half rem of canvas and buys the same way around from every page. */}
      <AppNav current="editor" />

      <div className="editor__canvas">
        <EditorCanvas
          // Precedence: the streaming ghost while the model emits, then the opening reveal,
          // then the build itself. The ghost swaps grids at preview cadence; when the real
          // program lands the navigation to `gen:<n>` plays the reveal over the final build.
          grid={ghost?.grid ?? assembly.grid}
          paletteColors={ghost?.colors ?? session.paletteColors}
          paletteFlags={ghost?.flags ?? session.paletteFlags}
          layerClip={ghost ? null : layer}
          layerFloor={!ghost && isolate && layer !== null ? layer : 0}
          onHover={setHover}
          onClick={ghost ? undefined : assembly.assembling ? assembly.skip : onCanvasClick}
          onStroke={ghost || assembly.assembling ? undefined : strokable ? onStroke : undefined}
          onPick={ghost ? undefined : assembly.assembling ? assembly.skip : onPick}
          marker={ghost ? null : anchor}
          region={ghost ? null : (partHighlight ?? region)}
          preview={ghost || assembly.assembling ? null : preview}
          onProgress={setRemaining}
          onWorld={ghost ? noopWorld : assembly.assembling ? assembly.onWorld : session.attachWorld}
          view={view}
          onSnapshot={registerSnapshot}
          enhanced={enhanced}
          ortho={ortho}
        />
      </div>

      <section className="hud hud--top">
        {/* The wordmark moved into the bar above, so this is a panel heading now rather than
            a second brand. It still has to be the h1: it is the only heading on the page
            that names what this screen is for. */}
        <h1 className="hud__title">Voxel editor</h1>
        <p className="hud__sub">Pick a build, or start from an empty plot.</p>

        <div className="hud__actions">
          {BUILD_IDS.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={buildId === id}
              onClick={() => guard({ kind: 'build', build: id })}
            >
              {BUILD_LABELS[id] ?? id}
            </button>
          ))}
          {saved.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={buildId === entry.id}
              onClick={() => guard({ kind: 'build', build: entry.id })}
              title={entry.name}
            >
              ✦ {entry.name}
            </button>
          ))}
          {/* Pictures are listed with the builds because that is what they are, and marked
              apart because a mural behaves differently from a program: nothing to resize and
              nothing to refine. */}
          {murals.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={buildId === entry.id}
              onClick={() => guard({ kind: 'build', build: entry.id })}
              title={`${entry.name} — built from a picture`}
            >
              ▧ {entry.name}
            </button>
          ))}
          {imported.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={buildId === entry.id}
              onClick={() => guard({ kind: 'build', build: entry.id })}
              title={`${entry.name} — imported from a schematic`}
            >
              ⬇ {entry.name}
            </button>
          ))}
          {/* Import is a build source like the picker rows above it: a .schem opens as
              voxels, a program .json opens with its sliders live. */}
          <label className="plans__import" title="Open a .schem or a program .json">
            Import…
            <input
              type="file"
              accept=".schem,.schematic,application/json,.json"
              onChange={(event) => {
                void onImportFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
          {importError && (
            <p className="tools__notice" role="alert">
              {importError}
            </p>
          )}
        </div>

        <Section id="tools" title="Edit" summary={session.edits > 0 ? `${session.edits} edits` : undefined}>
        <ToolPalette
          tool={tool}
          onTool={onTool}
          block={block}
          onBlock={setBlock}
          region={region}
          regionFilled={regionFilled}
          onRegionAction={regionAction}
          onRegionNudge={regionNudge}
          onRegionResize={regionResize}
          onDeselectRegion={() => {
            setRegion(null);
            setNotice(null);
          }}
          anchor={anchor}
          onClearAnchor={() => setAnchor(null)}
          familyMode={familyMode}
          onFamilyMode={setFamilyMode}
          brushRadius={brushRadius}
          brushShape={brushShape}
          symmetry={symmetry}
          onSymmetry={setSymmetry}
          onBrushRadius={setBrushRadius}
          onBrushShape={setBrushShape}
          clip={clip}
          stampMode={stampMode}
          onStampMode={setStampMode}
          onRotateClip={rotateClipboard}
          onMirrorClip={mirrorClipboard}
          onForgetClip={() => {
            setClip(null);
            setNotice('Clipboard emptied.');
          }}
          edits={session.edits}
          detached={session.detached}
          outside={session.outside}
          canUndo={session.canUndo}
          canRedo={session.canRedo}
          onUndo={session.undo}
          onRedo={session.redo}
          onDiscard={session.discard}
          notice={notice}
          onShowHelp={() => setHelp(true)}
        />
        </Section>

        <Section
          id="stats"
          title="Details"
          // Size and block count in the header, because they are what changes while scaling —
          // collapsing this section must not cost the two numbers people watch.
          summary={`${grid.size.x}×${grid.size.y}×${grid.size.z} · ${session.blockCount.toLocaleString()}`}
          defaultOpen={false}
        >
        <dl className="hud__stats">
          <dt>Build</dt>
          <dd>{name}</dd>
          <dt>Size</dt>
          <dd>
            {grid.size.x}×{grid.size.y}×{grid.size.z}
          </dd>
          <dt>Blocks</dt>
          <dd>{session.blockCount.toLocaleString()}</dd>
          <dt>Palette</dt>
          <dd>{grid.palette.length}</dd>
          <dt>Chunks</dt>
          <dd>{totalChunks.toLocaleString()}</dd>
          <dt>Layer</dt>
          <dd>{layer === null ? 'all' : isolate ? `y ${layer} only` : `0–${layer}`}</dd>
          <dt>Clipboard</dt>
          <dd>
            {clip ? `${clip.size.x}×${clip.size.y}×${clip.size.z}` : 'empty'}
          </dd>
        </dl>
        </Section>


        {build.program && (
          <ScalePanel
            scale={scale}
            outcome={scalePreview}
            base={scaleBase}
            onChange={(next) => guard({ kind: 'scale', scale: next })}
          />
        )}

        {/* Restyle: swap the whole palette for a curated material set. Program builds only —
            a mural is a picture, and repainting a picture in spruce is not a feature. The
            pack rides in the URL like the scale does, so a restyled build is shareable and
            the guide prints it in the same materials. */}
        {build.program && (
          <div className="restyle">
            <p className="params__title">Restyle — same build, new materials</p>
            <div className="hud__actions">
              <button
                type="button"
                aria-pressed={styleId === null}
                title="The build's own materials"
                onClick={() => guard({ kind: 'style', style: null })}
              >
                Original
              </button>
              {STYLE_PACKS.map((pack) => (
                <button
                  key={pack.id}
                  type="button"
                  aria-pressed={styleId === pack.id}
                  title={pack.description}
                  onClick={() => guard({ kind: 'style', style: pack.id })}
                >
                  {pack.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {build.program && build.program.components.length > 0 && (
          <Section
            id="outline"
            title="Components"
            summary={
              hiddenPaths.length > 0
                ? `${hiddenPaths.length} hidden`
                : outlineParts
                  ? `${outlineParts.length}`
                  : undefined
            }
            defaultOpen={false}
          >
            <Outliner
              parts={outlineParts}
              hidden={new Set(hiddenPaths)}
              onToggle={onPartToggle}
              onSolo={onPartSolo}
              onShowAll={onPartsShowAll}
              onFocus={onPartFocus}
              onHighlight={onPartHighlight}
            />
          </Section>
        )}

        {build.params.length > 0 && (
          <div className="params">
            <p className="params__title">Shape — re-expands the program</p>
            {build.params.map((param) => (
              <label key={param.name} className="param">
                <span className="param__label">{param.label}</span>
                <input
                  className="param__slider"
                  type="range"
                  min={param.min}
                  max={param.max}
                  value={param.value}
                  onChange={(event) =>
                    guard({ kind: 'param', name: param.name, value: Number(event.target.value) })
                  }
                />
                <span className="param__value">{param.value}</span>
              </label>
            ))}
          </div>
        )}

        {remaining > 0 && (
          <div className="hud__progress" title={`${remaining} chunks left to mesh`}>
            <span style={{ width: `${Math.round(meshed * 100)}%` }} />
          </div>
        )}

        {issues.length > 0 && (
          <ul className="hud__issues">
            {issues.slice(0, 4).map((issue, i) => (
              <li key={i} className={build.errors.includes(issue) ? 'issue--error' : 'issue--warn'}>
                <code>{issue.path}</code> {issue.message}
              </li>
            ))}
          </ul>
        )}

        <ExportBar
          grid={grid}
          program={build.program}
          name={name}
          detached={session.detached}
          guideHref={guideHref}
          blockCount={session.blockCount}
          getEdits={session.exportEdits}
        />

        {generated && buildId === generated.id && (
          <p className="hud__generated">
            Generated for {generated.result.costUsd < 0.01
              ? `$${generated.result.costUsd.toFixed(4)}`
              : `$${generated.result.costUsd.toFixed(2)}`}
            {generated.result.repaired && ' · needed one repair round'}
          </p>
        )}

        <div className="save">
          <AccountPanel />
        </div>

        {/* Dashboard, the layouter and the mod page were all listed here. All three are one
            click away in the bar above now, and a link that repeats one already on screen is
            furniture. `/status` stays because nothing else in the product points at it. */}
        <p className="hud__sub" style={{ marginTop: '0.875rem' }}>
          <Link className="hud__link" to="/status">
            Deployment checks →
          </Link>
        </p>
      </section>

      <div className="hud-right">
        <PromptPanel
          phase={generation.phase}
          spend={generation.spend}
          estimate={generation.estimate}
          estimating={generation.estimating}
          onEstimate={generation.requestEstimate}
          onGenerate={(instruction, size) => void generation.generate(instruction, undefined, size)}
          onCancel={generation.cancel}
          onRefine={refineTarget ? (instruction) => void generation.generate(instruction, refineTarget) : null}
          initialPrompt={seededPrompt}
        />

        <section className="hud">
          <Section id="picture" title="Picture to structure" defaultOpen={false}>
            <ImagePanel
              onBuilt={onMuralBuilt}
              onFocus={(request) => void generation.generateFromImage(request)}
              busy={generation.phase.kind !== 'idle' && generation.phase.kind !== 'failed'}
              canGenerate={canGenerate}
            />
          </Section>
        </section>
      </div>

      {/* The one line that is always on screen, so it carries what the pointer is over and
          what the next click would do — the two things a HUD panel is too far away to say. */}
      <aside className="hover-readout">
        {hover ? (
          <>
            <strong>{hoverBlock}</strong>
            {hover.x}, {hover.y}, {hover.z} · {hover.face}
            {preview && <em className="hover-readout__preview"> · {preview.label}</em>}
          </>
        ) : (
          <>drag to orbit · scroll to zoom · click to {TOOL_BY_ID[tool].verb}</>
        )}
      </aside>

      <section className="hud hud--layers">
        <span className="layers__label">Layer</span>
        <input
          className="layers__slider"
          type="range"
          min={0}
          max={topLayer}
          value={layer ?? topLayer}
          onChange={(event) => update({ layer: Number(event.target.value) })}
          aria-label="Highest visible layer"
        />
        <span className="layers__value">
          {layer === null ? `y 0–${topLayer}` : isolate ? `y ${layer}` : `y 0–${layer}`}
        </span>
        <button
          type="button"
          aria-pressed={isolate}
          disabled={layer === null}
          title="Show only the cut layer  (I)"
          onClick={() => update({ toggleIsolate: true })}
        >
          Isolate
        </button>
        <button type="button" onClick={() => update({ layer: null })} disabled={layer === null}>
          Show all
        </button>
        <span className="layers__views">
          {VIEWS.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              title={`Look from ${entry.label.toLowerCase()}${entry.kind === 'iso' ? '  (F)' : ''}`}
              onClick={() => setViewKind(entry.kind)}
            >
              {entry.label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={ortho}
            title="Orthographic projection — no perspective, true proportions"
            onClick={() => setOrtho((prev) => !prev)}
          >
            Ortho
          </button>
          <button
            type="button"
            aria-pressed={enhanced}
            title="Lit, grained rendering with sky and fog. Classic is the flat look."
            onClick={toggleEnhanced}
          >
            ✨
          </button>
          <button type="button" title="Save the current view as a PNG" onClick={takeScreenshot}>
            📷
          </button>
        </span>
      </section>

      {help && (
        <ShortcutHelp
          groups={EDITOR_SHORTCUTS}
          foot={EDITOR_SHORTCUT_FOOT}
          onClose={() => setHelp(false)}
        />
      )}
    </div>
  );
}

/**
 * Tools that act on the block already under the pointer, and what to say when there is not
 * one — i.e. when the click landed on the ground plane rather than on the build.
 *
 * Everything absent from this map either adds blocks (place, line, box, stamp) or needs no
 * source block, and a ground cell is a perfectly good target for those. The four here would
 * each do something quietly wrong with it instead: a flood fill starting in air spreads
 * through the whole sky, and a palette swap keyed on air would turn every empty cell in the
 * build into stone.
 */
/** Keys a shortcut claims, so everything else still reaches the browser. */
const HANDLED = /^([1-9]|\[|\]|\\|[iI]|-|_|=|\+|[bB]|[rR]|[mM]|[fF]|\?|Escape)$/;

const VERB: Record<string, string> = {
  fill: 'Filled',
  replace: 'Replaced in',
  hollow: 'Lined',
  clear: 'Cleared',
};

function applyNav(
  nav: PendingNav,
  update: (next: {
    build?: string;
    param?: { name: string; value: number };
    scale?: ScalePercent | null;
    style?: string | null;
  }) => void,
): void {
  // Switching build seeds the scale from the program, for the same reason a generation does:
  // a build that was fitted to a size opens at that size, and the slider says so.
  if (nav.kind === 'build') update({ build: nav.build, scale: programScale(nav.build) });
  else if (nav.kind === 'scale') update({ scale: nav.scale });
  else if (nav.kind === 'style') update({ style: nav.style });
  else update({ param: { name: nav.name, value: nav.value } });
}

function parseOverrides(key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of key.split('&')) {
    const [name, raw] = entry.split('=');
    if (!name || !raw) continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value)) out[name] = value;
  }
  return out;
}

/** A hand-edited or stale `?layer=` must not be able to clip the whole structure away. */
function readLayer(raw: string | null, topLayer: number): number | null {
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return null;
  return Math.min(topLayer, Math.max(0, value));
}

function blockAt(grid: { size: { x: number; y: number; z: number }; palette: string[]; voxels: Uint16Array }, at: VoxelHit): string {
  const index = grid.voxels[voxelIndex(grid.size, at.x, at.y, at.z)] ?? 0;
  return displayName(grid.palette[index] ?? AIR_BLOCK);
}
