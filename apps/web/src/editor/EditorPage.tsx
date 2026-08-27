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
import { AIR_BLOCK, displayName, voxelIndex } from '@craftmagic/core';
import { EditorCanvas, type ViewKind, type ViewRequest } from './EditorCanvas.js';
import { chunkCounts } from './mesher.js';
import {
  BLANK_BUILD,
  BUILD_IDS,
  expandBuild,
  generatedBuilds,
  isBuildId,
  paramsOf,
  previewScale,
  baseSize,
  NO_SCALE,
  type ScalePercent,
  registerGeneratedBuild,
} from './builds.js';
import { useLibraryBuild } from '../library/useLibraryBuild.js';
import {
  carrySettings,
  parseScale,
  scaleKey as readScaleKey,
  writeScale,
  PARAM_PREFIX,
  SCALE_PREFIX,
} from './urlState.js';
import { ExportBar } from './ExportBar.js';
import { ScalePanel } from './ScalePanel.js';
import { Section } from './Section.js';
import { ShortcutHelp } from './ShortcutHelp.js';
import { EDITOR_SHORTCUTS, EDITOR_SHORTCUT_FOOT } from './shortcuts.js';
import { ToolPalette, type BoxAction } from './ToolPalette.js';
import { toolForKey, TOOL_BY_ID, type ToolId } from './toolset.js';
import { previewFor } from './preview.js';
import { useEditSession } from './useEditSession.js';
import { placementCell } from './tools/place.js';
import { erase } from './tools/erase.js';
import { floodFill } from './tools/fill.js';
import { boxBounds, boxEdit, type BoxCorner } from './tools/boxSelect.js';
import { brushEdit, MAX_BRUSH_RADIUS, type BrushShape, type Cell } from './tools/brush.js';
import { lineEdit } from './tools/line.js';
import {
  ClipTooLargeError,
  copyRegion,
  mirrorClip,
  rotateClip,
  stampEdit,
  type Clip,
  type StampMode,
} from './tools/clipboard.js';
import { pickBlock } from './tools/pick.js';
import { familyOf, swapFamily, swapPaletteIndex } from './tools/paletteSwap.js';
import { PromptPanel } from '../generate/PromptPanel.js';
import { useGeneration, type GenerationResult } from '../generate/useGeneration.js';
import { AccountPanel } from '../library/AccountPanel.js';
import { AppNav } from '../shell/AppNav.js';
import type { VoxelHit } from './raycast.js';
import './editor.css';

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
  | { kind: 'scale'; scale: ScalePercent };

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

  const build = useMemo(
    () => expandBuild(buildId, { params: parseOverrides(overrideKey), scale: parseScale(scaleKey) }),
    [buildId, overrideKey, scaleKey],
  );
  const session = useEditSession(build);

  const { grid, name } = build;

  const scalePreview = useMemo(() => previewScale(buildId, scale), [buildId, scale]);
  const scaleBase = useMemo(() => baseSize(buildId), [buildId]);

  /**
   * The program a refine would edit, or null when refining makes no sense.
   *
   * Null in two cases, both of which would otherwise silently become "generate something
   * new": the empty plot has nothing to change, and a hand-edited build has no program behind
   * it any more, so the model would be handed the pre-edit version and quietly discard the
   * user's edits.
   */
  const refineTarget =
    buildId !== BLANK_BUILD && !session.detached ? build.program : null;
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
    }) => {
      setParams(
        () => {
          const search = new URLSearchParams(window.location.search);
          if (next.build !== undefined) {
            search.set('build', next.build);
            // Layers and params are per-build; carrying either across is meaningless.
            search.delete('layer');
            search.delete('only');
            for (const key of [...search.keys()]) {
              if (key.startsWith(PARAM_PREFIX) || key.startsWith(SCALE_PREFIX)) search.delete(key);
            }
          }
          if (next.param) search.set(PARAM_PREFIX + next.param.name, String(next.param.value));
          if (next.scale !== undefined) writeScale(search, next.scale);
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
  const [boxAction, setBoxAction] = useState<BoxAction>('fill');
  const [familyMode, setFamilyMode] = useState(false);
  const [anchor, setAnchor] = useState<BoxCorner | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [brushRadius, setBrushRadius] = useState(0);
  const [brushShape, setBrushShape] = useState<BrushShape>('ball');
  const [clip, setClip] = useState<Clip | null>(null);
  const [stampMode, setStampMode] = useState<StampMode>('merge');
  const [help, setHelp] = useState(false);
  const [view, setView] = useState<ViewRequest | null>(null);

  const onTool = useCallback((next: ToolId) => {
    setTool(next);
    setAnchor(null);
    setNotice(null);
  }, []);

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

  const mirrorClipboard = useCallback(() => {
    setClip((prev) => (prev ? mirrorClip(prev, 'x') : prev));
    setNotice('Clipboard mirrored.');
  }, []);

  /**
   * A tool click. Every branch does the same three things — resolve a palette slot, ask a
   * pure tool for an op, hand the op to the session — which is the whole reason the tools
   * take a palette index rather than a block ref and return an op rather than applying one.
   *
   * The two exceptions prove it: `copy` produces a clip instead of an op because it changes
   * nothing, and `pick` produces a block ref for the same reason.
   */
  const onCanvasClick = useCallback(
    (hit: VoxelHit) => {
      // A ground hit names an empty floor cell rather than a block, which is the whole point
      // of it — it is how the first block of an empty build gets placed. The tools below act
      // on whatever is *already* under the pointer, and on the floor there is nothing: a
      // flood fill would spread through the air, and a palette swap would find every empty
      // cell in the build and turn the sky into stone.
      const refusal = hit.ground ? NEEDS_A_BLOCK[tool] : undefined;
      if (refusal) {
        setNotice(refusal);
        return;
      }

      const slot = () => {
        const index = session.resolveBlock(block);
        if (index < 0) setNotice('Palette is full — this build cannot hold another block type.');
        return index;
      };

      switch (tool) {
        case 'place': {
          const index = slot();
          if (index < 0) return;
          const cell = placementCell(grid, hit);
          if (!cell) {
            setNotice('Nothing to place there — that face is already covered.');
            return;
          }
          const result = brushEdit(grid, [cell], index, {
            radius: brushRadius,
            shape: brushShape,
            onlyAir: true,
          });
          session.apply(result.op);
          setNotice(
            result.cells === 0
              ? 'Nothing to place there — every cell the brush covers is already filled.'
              : brushRadius === 0
                ? null
                : `Placed ${result.cells.toLocaleString()} blocks.`,
          );
          return;
        }

        case 'erase': {
          if (brushRadius === 0) {
            session.apply(erase(grid, hit));
            setNotice(null);
            return;
          }
          const result = brushEdit(grid, [hit], 0, {
            radius: brushRadius,
            shape: brushShape,
            onlySolid: true,
          });
          session.apply(result.op);
          setNotice(
            result.cells === 0 ? 'Nothing there to erase.' : `Erased ${result.cells.toLocaleString()} blocks.`,
          );
          return;
        }

        case 'fill': {
          const index = slot();
          if (index < 0) return;
          const result = floodFill(grid, hit, index);
          session.apply(result.op);
          setNotice(
            result.capped
              ? `Filled ${result.cells.toLocaleString()} blocks — stopped at the cap; click again to continue.`
              : `Filled ${result.cells.toLocaleString()} connected block${result.cells === 1 ? '' : 's'}.`,
          );
          return;
        }

        case 'line': {
          if (!anchor) {
            setAnchor({ x: hit.x, y: hit.y, z: hit.z });
            setNotice('Now click the other end.');
            return;
          }
          const index = slot();
          if (index < 0) return;
          const result = lineEdit(grid, anchor, hit, index, {
            radius: brushRadius,
            shape: brushShape,
          });
          session.apply(result.op);
          setAnchor(null);
          setNotice(`Drew a line of ${result.cells.toLocaleString()} blocks.`);
          return;
        }

        case 'select': {
          if (!anchor) {
            setAnchor({ x: hit.x, y: hit.y, z: hit.z });
            setNotice(
              boxAction === 'copy' ? 'Now click the opposite corner to copy.' : 'Now click the opposite corner.',
            );
            return;
          }

          const bounds = boxBounds(grid, anchor, hit);
          const extent = `${bounds.max.x - bounds.min.x + 1}×${bounds.max.y - bounds.min.y + 1}×${
            bounds.max.z - bounds.min.z + 1
          }`;

          if (boxAction === 'copy') {
            setAnchor(null);
            try {
              const copied = copyRegion(grid, anchor, hit);
              setClip(copied);
              // Straight to the tool that uses it: copying is never the goal, and leaving the
              // box tool armed after a copy invites a second selection nobody wanted.
              setTool('stamp');
              setNotice(
                `Copied ${extent} — ${copied.blocks.toLocaleString()} blocks. Click to stamp it; R rotates.`,
              );
            } catch (err) {
              setNotice(err instanceof ClipTooLargeError ? err.message : String(err));
            }
            return;
          }

          const index = boxAction === 'clear' ? 0 : slot();
          if (index < 0) return;
          const op = boxEdit(grid, anchor, hit, boxAction, index);
          session.apply(op);
          setAnchor(null);
          setNotice(
            `${VERB[boxAction]} a ${extent} box — ${(op?.indices.length ?? 0).toLocaleString()} blocks changed.`,
          );
          return;
        }

        case 'stamp': {
          if (!clip) {
            setNotice('Nothing copied yet — use the Box tool in Copy mode first.');
            return;
          }
          const cell = placementCell(grid, hit) ?? hit;
          const result = stampEdit(grid, clip, cell, (ref) => session.resolveBlock(ref), stampMode);
          session.apply(result.op);
          setNotice(
            result.truncated
              ? 'Palette is full — part of the clipboard could not be stamped.'
              : `Stamped ${result.cells.toLocaleString()} blocks at ${cell.x}, ${cell.y}, ${cell.z}.`,
          );
          return;
        }

        case 'pick': {
          const picked = pickBlock(grid, hit);
          if (!picked) {
            setNotice('Nothing to pick there.');
            return;
          }
          setBlock(picked);
          setNotice(`Picked ${displayName(picked)}.`);
          return;
        }

        case 'swap': {
          const from = grid.voxels[voxelIndex(grid.size, hit.x, hit.y, hit.z)] ?? 0;

          if (familyMode) {
            // Deliberately not `slot()`: a family swap resolves its own replacements, and
            // reserving a slot for the chosen block would leave an unused palette entry
            // whenever its category has no counterpart in the source family.
            const source = familyOf(grid.palette[from] ?? AIR_BLOCK);
            const target = familyOf(block);
            if (!source || !target) {
              setNotice('Family swap needs two blocks the registry knows a family for.');
              return;
            }
            const op = swapFamily(grid, source, target, (ref) => session.resolveBlock(ref));
            session.apply(op);
            setNotice(
              op
                ? `Re-skinned ${source} → ${target}: ${op.indices.length.toLocaleString()} blocks.`
                : `Nothing in the ${source} family to re-skin.`,
            );
            return;
          }

          const index = slot();
          if (index < 0) return;
          const op = swapPaletteIndex(grid, from, index);
          session.apply(op);
          setNotice(
            op
              ? `Swapped ${op.indices.length.toLocaleString()} blocks of ${displayName(grid.palette[from] ?? AIR_BLOCK)}.`
              : 'That block is already the chosen one.',
          );
          return;
        }
      }
    },
    [tool, block, boxAction, familyMode, anchor, grid, session, brushRadius, brushShape, clip, stampMode],
  );

  /**
   * A Shift-drag, delivered once with every cell it crossed.
   *
   * Folded into a single op rather than replayed as one edit per cell: a stroke is one
   * gesture, so it has to be one press of Ctrl+Z. Offered only for the two tools where
   * "keep going" means something — the canvas reads the absence of this callback as
   * permission to let the drag orbit the camera instead.
   */
  const onStroke = useCallback(
    (hits: VoxelHit[]) => {
      if (tool === 'place') {
        const index = session.resolveBlock(block);
        if (index < 0) {
          setNotice('Palette is full — this build cannot hold another block type.');
          return;
        }
        const cells = hits
          .map((hit) => placementCell(grid, hit))
          .filter((cell): cell is Cell => cell !== null);
        const result = brushEdit(grid, cells, index, {
          radius: brushRadius,
          shape: brushShape,
          onlyAir: true,
        });
        session.apply(result.op);
        setNotice(result.op ? `Placed ${result.cells.toLocaleString()} blocks in one stroke.` : null);
        return;
      }

      if (tool !== 'erase') return;
      const result = brushEdit(grid, hits, 0, {
        radius: brushRadius,
        shape: brushShape,
        onlySolid: true,
      });
      session.apply(result.op);
      setNotice(result.op ? `Erased ${result.cells.toLocaleString()} blocks in one stroke.` : null);
    },
    [tool, block, grid, session, brushRadius, brushShape],
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
      case 'M':
        if (clip) mirrorClipboard();
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
      update({ build: id });
    },
    [update],
  );

  const generation = useGeneration(onGenerated);

  // --- re-expansion guard --------------------------------------------------

  const [pending, setPending] = useState<PendingNav | null>(null);
  /** Anything that re-runs `expand()` discards the edits, so it has to ask first. */
  const guard = useCallback(
    (nav: PendingNav) => {
      if (session.detached && session.edits > 0) setPending(nav);
      else applyNav(nav, update);
    },
    [session.detached, session.edits, update],
  );

  const meshed = totalChunks === 0 ? 1 : 1 - remaining / totalChunks;
  const issues = [...build.errors, ...build.warnings];
  // "Air" would be true and useless. A ground hit is the floor, and saying so is what tells
  // someone staring at an empty plot that the click they are about to make will land.
  const hoverBlock = !hover ? null : hover.ground ? 'Ground' : blockAt(grid, hover);
  const strokable = tool === 'place' || tool === 'erase';

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
          grid={grid}
          paletteColors={session.paletteColors}
          paletteFlags={session.paletteFlags}
          layerClip={layer}
          layerFloor={isolate && layer !== null ? layer : 0}
          onHover={setHover}
          onClick={onCanvasClick}
          onStroke={strokable ? onStroke : undefined}
          onPick={onPick}
          marker={anchor}
          preview={preview}
          onProgress={setRemaining}
          onWorld={session.attachWorld}
          view={view}
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
        </div>

        <Section id="tools" title="Edit" summary={session.edits > 0 ? `${session.edits} edits` : undefined}>
        <ToolPalette
          tool={tool}
          onTool={onTool}
          block={block}
          onBlock={setBlock}
          boxAction={boxAction}
          onBoxAction={setBoxAction}
          anchor={anchor}
          onClearAnchor={() => setAnchor(null)}
          familyMode={familyMode}
          onFamilyMode={setFamilyMode}
          brushRadius={brushRadius}
          brushShape={brushShape}
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

        {pending && (
          <div className="detach" role="alertdialog">
            <p className="detach__text">
              {pending.kind === 'build' ? 'Switching build' : pending.kind === 'scale' ? 'Scaling' : 'Resizing'} re-expands the program
              and discards {session.edits} manual edit{session.edits === 1 ? '' : 's'}. The program
              itself is unchanged.
            </p>
            <div className="detach__actions">
              <button
                type="button"
                className="detach__confirm"
                onClick={() => {
                  applyNav(pending, update);
                  setPending(null);
                }}
              >
                Discard edits
              </button>
              <button type="button" onClick={() => setPending(null)}>
                Keep editing
              </button>
            </div>
          </div>
        )}

        {build.program && (
          <ScalePanel
            scale={scale}
            outcome={scalePreview}
            base={scaleBase}
            onChange={(next) => guard({ kind: 'scale', scale: next })}
          />
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

      <PromptPanel
        phase={generation.phase}
        spend={generation.spend}
        estimate={generation.estimate}
        estimating={generation.estimating}
        onEstimate={generation.requestEstimate}
        onGenerate={generation.generate}
        onCancel={generation.cancel}
        onRefine={refineTarget ? (instruction) => void generation.generate(instruction, refineTarget) : null}
        initialPrompt={seededPrompt}
      />

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
const NEEDS_A_BLOCK: Readonly<Partial<Record<ToolId, string>>> = {
  erase: 'Nothing there to erase — that is bare ground.',
  fill: 'Nothing to fill there — a flood fill has to start from a block.',
  swap: 'Nothing to swap there — click the block you want replaced everywhere.',
  pick: 'Nothing to pick there — click a block to make it the active one.',
};

/** Keys a shortcut claims, so everything else still reaches the browser. */
const HANDLED = /^([1-8]|\[|\]|\\|[iI]|-|_|=|\+|[bB]|[rR]|[mM]|[fF]|\?|Escape)$/;

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
  }) => void,
): void {
  if (nav.kind === 'build') update({ build: nav.build });
  else if (nav.kind === 'scale') update({ scale: nav.scale });
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
