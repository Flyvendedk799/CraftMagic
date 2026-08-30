/**
 * The studio.
 *
 * Three features are on show and they pull in different directions, which is why they are
 * implemented differently. The **layer range** must never re-mesh — it is a pair of clipping
 * planes, so scrubbing a 200k-block build costs two uniforms. The **param slider** must
 * re-expand: that is the whole point of the IR, and re-running `expand()` is what keeps walls
 * on the walls instead of stretching them. **Manual edits** are the awkward third: they write
 * straight to the voxels, so they are exactly what re-expanding destroys. That conflict is
 * settled here — the page holds the confirmation, `useEditSession` holds the evidence.
 *
 * ## Layout
 *
 * A real frame rather than islands floating over a canvas: a title bar across the top, a
 * **build** dock on the left, the viewport in the middle, a **studio** dock on the right, and
 * the viewport's own controls along the bottom. The docks are grid columns, so the viewport
 * is never underneath them and a panel can grow without covering the build it describes.
 *
 * The split between the two docks is the one rule that makes a control's home guessable. The
 * left dock decides **which build exists**: the prompt that makes one, and the list of the
 * ones you already have. The right dock is **everything you do to that build** and where it
 * goes afterwards — tools, shape, scale, details, exports, the library, someone's Minecraft
 * world. Shape and scale belong on the right for the same reason the tools do: they change
 * the build, and they are the two controls the discard warning exists for. The old single
 * column mixed all of it together and pushed "Send to game", the headline feature, below a
 * fold that only existed because the panel was a floating box with a height cap.
 *
 * ## State
 *
 * View state lives in the query string (`?build=tower&p.height=24&layer=6&layer0=2`). It costs
 * nothing, makes a view linkable, and lets a headless screenshot reach any of these states
 * without a driver. Edits deliberately do not: a URL that claimed to describe an edited build
 * would be a lie the moment it was shared. Camera and display toggles do not either — they
 * are preferences about *looking* at a build, not about the build, so they live in
 * localStorage and never travel on a shared link.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AIR_BLOCK, displayName, voxelIndex } from '@craftmagic/core';
import { EditorCanvas } from './EditorCanvas.js';
import { chunkCounts } from './mesher.js';
import {
  BLANK_BUILD,
  BUILD_IDS,
  expandBuild,
  generatedBuilds,
  isBuildId,
  isGeneratedId,
  isLibraryId,
  libraryRowId,
  paramsOf,
  previewScale,
  baseSize,
  type ScalePercent,
  registerGeneratedBuild,
  registerLibraryBuild,
} from './builds.js';
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
import { EDITOR_KEYS, Shortcuts } from './Shortcuts.js';
import { SourcePicker } from './SourcePicker.js';
import { BuildIdentity, StudioBar, type BuildSource } from './StudioBar.js';
import { ToolPalette, type ToolId } from './ToolPalette.js';
import { ViewBar } from './ViewBar.js';
import { isWholeBuild, readLayerRange, type LayerRange } from './viewport.js';
import { useStudioChrome } from './useStudioChrome.js';
import { useEditSession } from './useEditSession.js';
import { place } from './tools/place.js';
import { erase } from './tools/erase.js';
import { floodFill } from './tools/fill.js';
import { boxBounds, boxEdit, type BoxCorner, type BoxMode } from './tools/boxSelect.js';
import { familyOf, swapFamily, swapPaletteIndex } from './tools/paletteSwap.js';
import { PromptPanel } from '../generate/PromptPanel.js';
import { useGeneration, type GenerationResult } from '../generate/useGeneration.js';
import { getBuild } from '../library/library.js';
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

/** Kept beside the palette's own labels; both are wrong the moment they disagree. */
const TOOL_KEYS: Record<string, ToolId> = {
  '1': 'place',
  '2': 'erase',
  '3': 'fill',
  '4': 'select',
  '5': 'swap',
};

/** What a click does right now, for the idle line in the status bar. */
const TOOL_VERBS: Record<ToolId, string> = {
  place: 'place',
  erase: 'erase',
  fill: 'fill',
  select: 'set a corner',
  swap: 'swap',
};

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

  const rawBuild = params.get('build');

  // A library build lives in the database rather than in the bundle, so `?build=lib:<id>`
  // has to be fetched before it can be expanded. Fetching on demand rather than caching it in
  // the browser is what makes the deep link survive a reload and, more importantly, what stops
  // it from ever showing a stale copy of a build that was renamed or deleted elsewhere.
  const [fetching, setFetching] = useState<{ id: string; error: string | null } | null>(null);
  const needsFetch = rawBuild !== null && isLibraryId(rawBuild) && !isBuildId(rawBuild);

  useEffect(() => {
    if (!needsFetch || rawBuild === null) return;
    const rowId = libraryRowId(rawBuild);
    if (!rowId) return;

    let cancelled = false;
    setFetching({ id: rawBuild, error: null });

    getBuild(rowId)
      .then((detail) => {
        if (cancelled) return;
        // Prefer the program so the param sliders still work — except when the build was
        // hand-edited, where no program describes what was saved and only the voxels do.
        registerLibraryBuild(
          rowId,
          detail.program && !detail.detached
            ? { kind: 'program', name: detail.name, program: detail.program }
            : {
                kind: 'voxels',
                name: detail.name,
                grid: {
                  size: detail.grid.size,
                  palette: detail.grid.palette,
                  voxels: Uint16Array.from(detail.grid.voxels),
                },
              },
        );
        setFetching(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setFetching({ id: rawBuild, error: (err as Error).message });
      });

    return () => {
      cancelled = true;
    };
  }, [needsFetch, rawBuild]);

  const buildId = isBuildId(rawBuild) ? rawBuild : DEFAULT_BUILD;

  // Only param values may re-expand. Keying the memo on a string of just those keeps the
  // layer range — which lives in the same query string — from rebuilding the world.
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

  const { grid } = build;

  /**
   * A name the user typed, or null to use the one the build came with.
   *
   * Held here rather than pushed into the build, because a build is a derived value: the next
   * param drag re-runs `expand()` and would hand back the program's own name again. Cleared
   * whenever the build identity changes, since a name typed for a cottage has nothing to do
   * with the tower that replaced it.
   */
  const [renamed, setRenamed] = useState<string | null>(null);
  useEffect(() => setRenamed(null), [buildId]);
  const name = renamed ?? build.name;

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

  // Memoised on the two raw strings, not rebuilt per render: this object is a prop of the
  // canvas, and a fresh identity every render would re-run the clipping effect on every
  // pointer move.
  const rawLayerMax = params.get('layer');
  const rawLayerMin = params.get('layer0');
  const layerRange = useMemo(
    () => readLayerRange(rawLayerMax, rawLayerMin, topLayer),
    [rawLayerMax, rawLayerMin, topLayer],
  );
  // Clipping at the full extent is clipping for nothing, and `null` is the only value that
  // lets the mesher skip binding planes at all.
  const effectiveClip = isWholeBuild(layerRange, topLayer) ? null : layerRange;

  const totalChunks = useMemo(() => {
    const counts = chunkCounts(grid.size);
    return counts.x * counts.y * counts.z;
  }, [grid.size]);

  // The guide reads the same query convention as the editor, so it renders exactly the
  // build on screen — including whatever the param sliders are currently set to.
  //
  // Not offered for a library build. The guide rebuilds the grid from the id in the URL and
  // has no network fetch of its own, so `/guide?build=lib:<id>` would open on the default
  // build and print the wrong thing — a broken link is better named by not existing.
  const guideHref = useMemo(() => {
    if (isLibraryId(buildId)) return null;
    const search = new URLSearchParams();
    search.set('build', buildId);
    // Params *and* scale: the guide prints the build on screen, and a resized one is a
    // different build to put together block by block.
    carrySettings(params, search);
    return `/guide?${search.toString()}`;
  }, [buildId, params]);

  const update = useCallback(
    (next: {
      build?: string;
      layer?: LayerRange | null;
      param?: { name: string; value: number };
      scale?: ScalePercent | null;
    }) => {
      setParams(
        (prev) => {
          const search = new URLSearchParams(prev);
          if (next.build !== undefined) {
            search.set('build', next.build);
            // Layers and params are per-build; carrying either across is meaningless.
            search.delete('layer');
            search.delete('layer0');
            for (const key of [...search.keys()]) {
              if (key.startsWith(PARAM_PREFIX) || key.startsWith(SCALE_PREFIX)) search.delete(key);
            }
          }
          if (next.param) search.set(PARAM_PREFIX + next.param.name, String(next.param.value));
          if (next.scale !== undefined) writeScale(search, next.scale);
          if (next.layer !== undefined) {
            if (next.layer === null) {
              search.delete('layer');
              search.delete('layer0');
            } else {
              search.set('layer', String(next.layer.max));
              // Absent rather than zero: the common case is a ceiling, and a link that only
              // clips the top should not carry a second parameter saying "from the bottom".
              if (next.layer.min > 0) search.set('layer0', String(next.layer.min));
              else search.delete('layer0');
            }
          }
          return search;
        },
        { replace: true },
      );
      if (next.build !== undefined) setHover(null);
    },
    [setParams],
  );

  const setRange = useCallback((next: LayerRange | null) => update({ layer: next }), [update]);

  // --- viewport ------------------------------------------------------------

  // Docks, camera, display toggles and the keyboard sheet are the same on every surface of
  // the studio, so they are the same hook. The planner uses it too, which is what keeps a
  // dock from collapsing differently depending on which page you are standing on.
  const { docks, toggleDock, display, setDisplay, view, sendView, shortcuts, setShortcuts } =
    useStudioChrome();

  // --- editing ------------------------------------------------------------

  const [tool, setTool] = useState<ToolId>('place');
  const [block, setBlock] = useState<string>(DEFAULT_BLOCK);
  const [boxMode, setBoxMode] = useState<BoxMode>('fill');
  const [familyMode, setFamilyMode] = useState(false);
  const [anchor, setAnchor] = useState<BoxCorner | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * A tool click. Every branch does the same three things — resolve a palette slot, ask a
   * pure tool for an op, hand the op to the session — which is the whole reason the tools
   * take a palette index rather than a block ref and return an op rather than applying one.
   */
  const onCanvasClick = useCallback(
    (hit: VoxelHit) => {
      const slot = () => {
        const index = session.resolveBlock(block);
        if (index < 0) setNotice('Palette is full — this build cannot hold another block type.');
        return index;
      };

      switch (tool) {
        case 'place': {
          const index = slot();
          if (index < 0) return;
          const op = place(grid, hit, index);
          if (!op) setNotice('Nothing to place there — that face is already covered.');
          else setNotice(null);
          session.apply(op);
          return;
        }

        case 'erase': {
          session.apply(erase(grid, hit));
          setNotice(null);
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

        case 'select': {
          if (!anchor) {
            setAnchor({ x: hit.x, y: hit.y, z: hit.z });
            setNotice('Now click the opposite corner.');
            return;
          }
          const index = boxMode === 'clear' ? 0 : slot();
          if (index < 0) return;
          const bounds = boxBounds(grid, anchor, hit);
          const op = boxEdit(grid, anchor, hit, boxMode, index);
          session.apply(op);
          setAnchor(null);
          setNotice(
            `${boxMode === 'clear' ? 'Cleared' : 'Filled'} a ${bounds.max.x - bounds.min.x + 1}×${
              bounds.max.y - bounds.min.y + 1
            }×${bounds.max.z - bounds.min.z + 1} box — ${(op?.indices.length ?? 0).toLocaleString()} blocks changed.`,
          );
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
    [tool, block, boxMode, familyMode, anchor, grid, session],
  );

  const onTool = useCallback((next: ToolId) => {
    setTool(next);
    setAnchor(null);
    setNotice(null);
  }, []);

  // A box corner is a position in *this* grid. Switching build or moving a param produces a
  // new one, where the same coordinates mean something else entirely.
  useEffect(() => {
    setAnchor(null);
    setNotice(null);
  }, [grid]);

  /**
   * The unmodified keyboard map.
   *
   * Guarded against firing while someone is typing: the prompt box, the block search and the
   * sign-in fields are all reachable from this screen, and a shortcut that changes the tool
   * mid-sentence is worse than no shortcut. Modifier combinations are left alone so Ctrl+Z
   * still reaches undo, which `useEditSession` binds separately.
   *
   * Every key here is listed in `Shortcuts`. A binding that is not is a bug.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;

      const picked = TOOL_KEYS[event.key];
      if (picked) {
        event.preventDefault();
        onTool(picked);
        return;
      }

      // A step moves the whole band, so soloing a course and walking up through the build is
      // the same two keys as raising a ceiling.
      const step = (delta: number) => {
        event.preventDefault();
        const current = layerRange ?? { min: 0, max: topLayer };
        const width = current.max - current.min;
        const max = Math.min(topLayer, Math.max(width, current.max + delta));
        setRange({ min: max - width, max });
      };

      switch (event.key) {
        case '[':
          step(-1);
          return;
        case ']':
          step(1);
          return;
        case '\\':
          event.preventDefault();
          setRange(null);
          return;
        case 'f':
        case 'F':
          event.preventDefault();
          sendView('frame');
          return;
        case 'g':
        case 'G':
          event.preventDefault();
          setDisplay({ ...display, grid: !display.grid });
          return;
        case '?':
          event.preventDefault();
          setShortcuts(!shortcuts);
          return;
        case 'Escape':
          if (anchor) {
            event.preventDefault();
            setAnchor(null);
            setNotice(null);
          }
          return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onTool, layerRange, topLayer, setRange, sendView, setDisplay, display, anchor, shortcuts, setShortcuts]);

  // --- generation ----------------------------------------------------------

  // Seeded from anything restored out of sessionStorage, so a reload does not lose builds
  // that were paid for.
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

  const issues = [...build.errors, ...build.warnings];
  const hoverBlock = hover ? blockAt(grid, hover) : null;
  const source: BuildSource = isGeneratedId(buildId)
    ? 'generated'
    : isLibraryId(buildId)
      ? 'library'
      : buildId === BLANK_BUILD
        ? 'blank'
        : 'sample';

  // After every hook, never before: an early return above one would change the hook order
  // between renders. The cost is expanding the default build while a library one is in
  // flight, which is a few milliseconds nobody sees.
  if (fetching && fetching.id === rawBuild) {
    return (
      <div className="library" data-ready={fetching.error ? '1' : '0'}>
        <section className="panel">
          <h2>{fetching.error ? 'Could not open that build' : 'Opening build…'}</h2>
          <p className="library__empty">
            {fetching.error ?? 'Fetching it from your library.'}
          </p>
          {fetching.error && (
            <p className="library__empty" style={{ marginTop: '1rem' }}>
              <Link to="/library">← Back to the library</Link>
            </p>
          )}
        </section>
      </div>
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
      data-left={docks.left}
      data-right={docks.right}
    >
      <StudioBar
        identity={
          <BuildIdentity
            name={name}
            onRename={setRenamed}
            source={source}
            detached={session.detached}
            edits={session.edits}
            size={grid.size}
            blockCount={session.blockCount}
          />
        }
        leftOpen={docks.left}
        rightOpen={docks.right}
        leftLabel="Build"
        rightLabel="Tools"
        onToggleLeft={() => toggleDock('left')}
        onToggleRight={() => toggleDock('right')}
        onShowShortcuts={() => setShortcuts(true)}
      />

      {/* `.hud` is the shared panel surface, and the deployment drivers read the stats table
          through it. Both docks carry it for that reason. */}
      <aside className="hud dock dock--left" aria-label="Build" hidden={!docks.left}>
        <PromptPanel
          phase={generation.phase}
          spend={generation.spend}
          estimate={generation.estimate}
          estimating={generation.estimating}
          onEstimate={generation.requestEstimate}
          onGenerate={generation.generate}
          onCancel={generation.cancel}
          onRefine={refineTarget ? (instruction) => void generation.generate(instruction, refineTarget) : null}
        />

        {generated && buildId === generated.id && (
          <p className="hud__generated">
            Generated for {generated.result.costUsd < 0.01
              ? `$${generated.result.costUsd.toFixed(4)}`
              : `$${generated.result.costUsd.toFixed(2)}`}
            {generated.result.repaired && ' · needed one repair round'}
          </p>
        )}

        <Section id="source" title="Build" summary={sourceSummary(source, saved.length)}>
          <SourcePicker
            current={buildId}
            samples={BUILD_IDS}
            generated={saved}
            onPick={(id) => guard({ kind: 'build', build: id })}
          />
        </Section>


        {issues.length > 0 && (
          <ul className="hud__issues">
            {issues.slice(0, 4).map((issue, i) => (
              <li key={i} className={build.errors.includes(issue) ? 'issue--error' : 'issue--warn'}>
                <code>{issue.path}</code> {issue.message}
              </li>
            ))}
          </ul>
        )}
      </aside>

      <main className="viewport">
        <EditorCanvas
          grid={grid}
          paletteColors={session.paletteColors}
          paletteFlags={session.paletteFlags}
          layerClip={effectiveClip}
          display={display}
          view={view}
          onHover={setHover}
          onClick={onCanvasClick}
          marker={anchor}
          onProgress={setRemaining}
          onWorld={session.attachWorld}
        />

        {/* An empty plot renders a ground grid and nothing else, which reads as a page that
            failed to load rather than as a place to start. */}
        {session.blockCount === 0 && (
          <div className="viewport__empty">
            <p className="viewport__empty-title">Nothing here yet</p>
            <p className="viewport__empty-body">
              Describe a build on the left, or pick a sample to take apart.
            </p>
          </div>
        )}

        {pending && (
          // Centred over the viewport rather than tucked into a panel: it is the one moment
          // in the studio where nothing else should be clicked until it is answered.
          <div className="detach" role="alertdialog" aria-label="Discard edits?">
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
      </main>

      <aside className="hud dock dock--right" aria-label="Tools" hidden={!docks.right}>
        <Section id="tools" title="Edit" summary={session.edits > 0 ? `${session.edits}` : undefined}>
          <ToolPalette
            tool={tool}
            onTool={onTool}
            block={block}
            onBlock={setBlock}
            boxMode={boxMode}
            onBoxMode={setBoxMode}
            anchor={anchor}
            onClearAnchor={() => setAnchor(null)}
            familyMode={familyMode}
            onFamilyMode={setFamilyMode}
            edits={session.edits}
            detached={session.detached}
            canUndo={session.canUndo}
            canRedo={session.canRedo}
            onUndo={session.undo}
            onRedo={session.redo}
            onDiscard={session.discard}
            notice={notice}
          />
        </Section>

        {build.params.length > 0 && (
          <Section id="shape" title="Shape" summary={`${build.params.length}`}>
            <div className="params">
              <p className="params__note">Re-expands the program — manual edits do not survive it.</p>
              {build.params.map((param) => (
                <label key={param.name} className="param">
                  <span className="param__label">{param.label}</span>
                  <span className="param__value">{param.value}</span>
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
                </label>
              ))}
            </div>
          </Section>
        )}

        {build.program && (
          <Section
            id="scale"
            title="Scale"
            summary={scale.x === scale.y && scale.y === scale.z ? `${scale.x}%` : 'per axis'}
          >
            <ScalePanel
              scale={scale}
              outcome={scalePreview}
              base={scaleBase}
              onChange={(next) => guard({ kind: 'scale', scale: next })}
            />
          </Section>
        )}

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
            <dd>{effectiveClip === null ? 'all' : `${effectiveClip.min}–${effectiveClip.max}`}</dd>
          </dl>
        </Section>

        <ExportBar
          grid={grid}
          program={build.program}
          name={name}
          detached={session.detached}
          guideHref={guideHref}
          blockCount={session.blockCount}
        />
      </aside>

      <ViewBar
        topLayer={topLayer}
        range={layerRange}
        onRange={setRange}
        display={display}
        onDisplay={setDisplay}
        onView={sendView}
        hover={hover}
        hoverBlock={hoverBlock}
        toolVerb={TOOL_VERBS[tool]}
        remaining={remaining}
        totalChunks={totalChunks}
      />

      {shortcuts && <Shortcuts groups={EDITOR_KEYS} onClose={() => setShortcuts(false)} />}
    </div>
  );
}

/** What the collapsed Build section says, so collapsing it never costs the answer. */
function sourceSummary(source: BuildSource, generatedCount: number): string {
  if (source === 'generated') return '✦ generated';
  if (source === 'library') return 'from library';
  if (generatedCount > 0) return `${generatedCount} generated`;
  return source === 'blank' ? 'empty' : 'sample';
}

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

function blockAt(grid: { size: { x: number; y: number; z: number }; palette: string[]; voxels: Uint16Array }, at: VoxelHit): string {
  const index = grid.voxels[voxelIndex(grid.size, at.x, at.y, at.z)] ?? 0;
  return displayName(grid.palette[index] ?? AIR_BLOCK);
}
