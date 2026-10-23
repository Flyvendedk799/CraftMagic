/**
 * The printable build guide.
 *
 * Nothing here is stored. The URL names a build and its params, the expander rebuilds the
 * grid and `buildGuide` re-segments it — which is what keeps a booklet honest after a
 * resize: `?build=tower&p.height=24` prints the tower at *that* height rather than whatever
 * the PDF was generated from last week. It also means the guide inherits every future
 * expander fix for free.
 *
 * Three passes, in increasing cost. The cover and the bill of materials are plain DOM. Each
 * step's plan is a synchronous 2D canvas drawn on mount. The running isometric renders share
 * a single WebGL context and are spread across frames under a time budget, so the page stays
 * scrollable while a 40-step guide fills in behind you.
 *
 * `data-ready` flips only when the last render lands. Both consumers need that signal: the
 * screenshot driver has nothing else to wait on, and a user who hits Ctrl+P early would
 * otherwise print a booklet of empty frames — which is why the print button is disabled
 * until then rather than merely discouraged.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  buildGuide,
  type BuildGuide,
  type BuildStep,
  type CameraOrientation,
  type GuidePart,
  type MaterialCount,
} from '@craftmagic/core';
import { expandBuild, isBuildId, type LoadedBuild } from '../editor/builds.js';
import { useLibraryBuild } from '../library/useLibraryBuild.js';
import { carrySettings, parseScale, scaleKey as readScaleKey, PARAM_PREFIX, STYLE_PARAM } from '../editor/urlState.js';
import { IsoFilmstrip } from './isoRender.js';
import {
  drawLayerPlan,
  earlierInLayer,
  footprint,
  placedDimensions,
  type LayerPlan,
  type PlanCell,
} from './layerGrid.js';
import { StepTray } from './StepTray.js';
import {
  ArtFrame,
  ArtImage,
  Eyebrow,
  Lede,
  Sheet,
  SheetTitle,
  Stat,
  StatGrid,
  Swatch,
} from './primitives.js';
// Tokens first: `print.css` is written entirely against them, and the bundler preserves this
// order, so the roles exist by the time anything asks for one.
import './tokens.css';
import './print.css';

/**
 * What `/guide` with no build named prints.
 *
 * Only ever used when the URL names nothing at all. It is emphatically *not* a fallback for a
 * build that failed to resolve — substituting it there is what made every generated build's
 * guide come out as the sample cottage, silently and with no clue that anything had gone
 * wrong. An unresolvable id now prints an explanation instead.
 */
const DEFAULT_BUILD = 'cottage';

/** Step art. Sized for print (~88mm at 190dpi) rather than for the screen. */
const STEP_W = 640;
const STEP_H = 520;
/** The cover gets its own, larger render — it is the one image seen at full page width. */
const COVER_W = 1160;
const COVER_H = 840;

/**
 * Rendering time allowed per frame. Long enough to amortise the readback, short enough that
 * scrolling stays smooth while the filmstrip is still filling in.
 */
const FRAME_BUDGET_MS = 12;

/**
 * Past this, assembly steps are dropped and the guide prints as a cover and a parts list.
 *
 * 400 steps is already a 200-page booklet, and the editor's stress build — 200k blocks —
 * would ask for thousands: thousands of canvases, thousands of PNG readbacks, and a tab that
 * never comes back. The cover still renders, because that costs one mesh of the whole build
 * either way.
 */
const MAX_PRINTABLE_STEPS = 400;

export function GuidePage() {
  const [params, setParams] = useSearchParams();

  const mode = params.get('mode') === 'builder' ? 'builder' : 'booklet';
  const rawBuild = params.get('build');

  // A library build lives in the database rather than in the bundle, so `?build=lib:<id>`
  // has to be fetched before it can be expanded. The guide used not to do this at all, which
  // is why the editor withheld the link for a library build rather than hand out a URL that
  // printed the wrong thing.
  const fetching = useLibraryBuild(rawBuild);

  /**
   * The build to print, or null when the URL names one this browser cannot produce.
   *
   * Recomputed on every render rather than memoised: `isBuildId` is two map lookups, and the
   * render after a fetch lands is exactly when the answer must change. Null is a real state
   * with its own page — never a reason to print something else.
   */
  const resolved = rawBuild === null ? DEFAULT_BUILD : isBuildId(rawBuild) ? rawBuild : null;

  // Hooks below must run on every render, so an unresolved id still expands *something*.
  // Nothing is drawn from it — `renderable` gates the expensive work and the page body.
  const buildId = resolved ?? DEFAULT_BUILD;
  const renderable = resolved !== null;

  // A stable string key rather than the URLSearchParams object: it is a fresh instance on
  // every render, and re-expanding a build is not something to do 60 times a second.
  const overrideKey = useMemo(
    () =>
      [...params.entries()]
        .filter(([key]) => key.startsWith(PARAM_PREFIX))
        .map(([key, value]) => `${key.slice(PARAM_PREFIX.length)}=${value}`)
        .sort()
        .join('&'),
    [params],
  );

  const scaleKey = readScaleKey(params);
  const styleId = params.get(STYLE_PARAM);

  // Both halves of the editor's URL, or the guide prints a different build from the one the
  // link came from: `parseOverrides` alone was silently dropped, because it is a bare map of
  // values where `expandBuild` expects them under `params`.
  // The style pack rides too, or a restyled build's booklet would name the original
  // materials — a shopping list for a building that is not the one on screen.
  // Provenance is asked for here and nowhere else in the app. It is what lets a step be
  // called "South windows" instead of "y = 7, part 2 of 3", and the guide is the one place
  // that expands a build once rather than on every frame of a slider drag.
  const build = useMemo(
    () =>
      expandBuild(
        buildId,
        { params: parseOverrides(overrideKey), scale: parseScale(scaleKey), style: styleId },
        { provenance: true },
      ),
    [buildId, overrideKey, scaleKey, styleId],
  );
  const guide = useMemo(
    () => buildGuide(build.grid, build.name, { parts: build.parts, origin: build.origin }),
    [build],
  );

  const printable = guide.steps.length <= MAX_PRINTABLE_STEPS;
  // `renderable` and not just `printable`: an unresolved id would otherwise spin up a WebGL
  // context and read back a cover for a build nobody asked for, behind an error page.
  const film = useFilmstrip(build, guide, printable, renderable);
  const ready = film.cover !== null;

  const plans = useLayerPlans(build, guide, printable && renderable);

  /**
   * Blocks standing once each step is done.
   *
   * "Step 31 of 43" says nothing about how much work is left: the last dozen steps of a build
   * are usually its roof, and a roof can be a quarter of it. A running block count is the
   * honest measure of progress, and it costs one pass over the steps.
   */
  const placedBy = useMemo(() => {
    let running = 0;
    return guide.steps.map((step) => (running += step.blocks.length));
  }, [guide]);
  const editorHref = useMemo(() => {
    const search = new URLSearchParams();
    if (rawBuild !== null) search.set('build', rawBuild);
    carrySettings(params, search);
    return `/editor?${search.toString()}`;
  }, [rawBuild, params]);

  const handleSetMode = (nextMode: 'booklet' | 'builder') => {
    const next = new URLSearchParams(params);
    if (nextMode === 'booklet') {
      next.delete('mode');
    } else {
      next.set('mode', 'builder');
    }
    setParams(next, { replace: true });
  };

  if (!renderable) {
    return (
      <Unavailable
        id={rawBuild ?? ''}
        loading={fetching.loading}
        error={fetching.error}
        editorHref={editorHref}
      />
    );
  }

  if (mode === 'builder') {
    return (
      <BuilderView
        build={build}
        guide={guide}
        film={film}
        plans={plans}
        editorHref={editorHref}
        buildId={buildId}
        onSwitchToBooklet={() => handleSetMode('booklet')}
      />
    );
  }

  return (
    <div
      className="guide"
      data-ready={ready ? '1' : '0'}
      data-build={buildId}
      data-steps={guide.steps.length}
      data-render-ms={film.elapsedMs}
    >
      <nav className="guide__bar no-print">
        <Link className="guide__back" to={editorHref}>
          ← Back to editor
        </Link>
        <span className="guide__status">
          {!printable
            ? `${guide.steps.length.toLocaleString()} steps — too many to print`
            : ready
              ? `${guide.steps.length} steps rendered in ${(film.elapsedMs / 1000).toFixed(1)}s`
              : `Rendering step ${Math.min(film.shots.length + 1, guide.steps.length)} of ${guide.steps.length}…`}
        </span>
        <button
          type="button"
          className="guide__mode-btn"
          onClick={() => handleSetMode('builder')}
          title="Switch to interactive builder mode"
        >
          🔨 Interactive Builder
        </button>
        <button type="button" className="guide__print" onClick={() => window.print()} disabled={!ready}>
          Print / Save as PDF
        </button>
      </nav>

      <Cover build={build} guide={guide} art={film.cover} />
      <Parts guide={guide} />
      <Materials guide={guide} />

      {printable ? (
        <section className="steps">
          <h2 className="sheet__title">Assembly</h2>
          {/* The rules the segmentation actually followed, read off the design system rather
              than restated here — so a guide laid out under a different one describes itself
              correctly instead of describing the default. */}
          {/* Both views use the same convention and neither is self-explanatory, so it is
              stated once here rather than repeated under forty-three pictures. The model half
              is the newer of the two claims and the one a reader is most likely to miss: pale
              means built, full colour means place it now. */}
          <p className="sheet__lede steps__lede">
            Bottom-up, at most {guide.design.step.maxBlocks} blocks a step
            {guide.parts.length > 0 && ', and one part at a time'}. In the plan, grey squares
            are already placed and outlined ones are this step. In the model, what you have
            built is faded and <strong>this step is in full colour</strong>.
          </p>
          {guide.steps.map((step, i) => (
            <StepCard
              key={step.index}
              step={step}
              total={guide.steps.length}
              plan={plans[i]!}
              shot={film.shots[i]}
              placed={placedBy[i]!}
              totalBlocks={guide.totalBlocks}
            />
          ))}
        </section>
      ) : (
        <Sheet variant="oversize">
          <SheetTitle>Assembly</SheetTitle>
          <Lede>
            This build segments into {guide.steps.length.toLocaleString()} steps — about{' '}
            {Math.ceil(guide.steps.length / 2).toLocaleString()} printed pages, past what a
            booklet can usefully be. The cover and the bill of materials above still apply;
            for step-by-step assembly, resize the build down in the editor or export a
            schematic instead.
          </Lede>
        </Sheet>
      )}

      <footer className="guide__foot">
        Built from a program, not a picture — resize it in the editor and print a new booklet.
      </footer>
    </div>
  );
}

/* --- when the build cannot be resolved --------------------------------------------------- */

/**
 * The page for a build this browser cannot produce.
 *
 * It exists because the alternative — quietly printing {@link DEFAULT_BUILD} — is worse than
 * useless: the booklet looks finished, the cover says "Oak Cottage", and nothing anywhere
 * says the link named something else. A guide that admits it cannot find a build is a bug
 * report; a guide that prints the wrong build is a mystery.
 */
function Unavailable({
  id,
  loading,
  error,
  editorHref,
}: {
  id: string;
  loading: boolean;
  error: string | null;
  editorHref: string;
}) {
  return (
    <div className="guide" data-ready="0" data-build={id} data-unavailable="1">
      <nav className="guide__bar no-print">
        <Link className="guide__back" to={editorHref}>
          ← Back to editor
        </Link>
      </nav>

      <Sheet variant="cover">
        <Eyebrow>CraftMagic · Build guide</Eyebrow>
        <h1 className="cover__title">{loading ? 'Loading…' : 'Build not found'}</h1>
        {loading ? (
          <p className="cover__lede">Fetching {id} from your library.</p>
        ) : error !== null ? (
          <p className="cover__lede">
            <code>{id}</code> could not be loaded: {error}
          </p>
        ) : (
          <p className="cover__lede">
            <code>{id}</code> is not a build this browser knows about. Generated builds are
            kept on the device that made them, so a link opened on another computer — or after
            clearing site data — cannot rebuild one. Save it to your library and the guide will
            fetch it anywhere.
          </p>
        )}
      </Sheet>
    </div>
  );
}

/* --- cover ---------------------------------------------------------------------------- */

function Cover({ build, guide, art }: { build: LoadedBuild; guide: BuildGuide; art: string | null }) {
  return (
    <Sheet variant="cover" break="after">
      <Eyebrow>CraftMagic · Build guide</Eyebrow>
      <h1 className="cover__title">{guide.name}</h1>
      {build.description && <p className="cover__lede">{build.description}</p>}

      <ArtFrame size="cover">
        <ArtImage src={art} alt={`Finished ${guide.name}, seen from above at an angle`} />
      </ArtFrame>

      <StatGrid>
        <Stat
          label="Dimensions"
          value={`${guide.size.x} × ${guide.size.y} × ${guide.size.z}`}
          note="W × H × L"
        />
        <Stat
          label="Blocks"
          value={guide.totalBlocks.toLocaleString()}
          note={`${guide.materials.length} kinds`}
        />
        {/* Layers that hold something, not the grid's height: an empty top half is not work,
            and a builder counting courses would be told the wrong number. */}
        <Stat
          label="Steps"
          value={guide.steps.length.toLocaleString()}
          note={`${new Set(guide.steps.map((step) => step.layer)).size} layers`}
        />
        <Stat
          label="Difficulty"
          value={guide.difficulty}
          plain
          note={guide.parts.length > 0 ? `${guide.parts.length} parts` : 'bottom-up'}
        />
      </StatGrid>
    </Sheet>
  );
}

/* --- bill of parts --------------------------------------------------------------------- */

/**
 * What the build is made of, before what it is made from.
 *
 * The bill of materials answers "what do I gather"; this answers "what am I building", which
 * is the question that comes first and which a booklet of forty near-identical step diagrams
 * otherwise never answers at all. It exists only when the build came from a program — a
 * hand-edited grid has no components to name, and inventing names for it would be fiction.
 */
function Parts({ guide }: { guide: BuildGuide }) {
  if (guide.parts.length === 0) return null;

  return (
    <Sheet variant="parts">
      <SheetTitle>What you are building</SheetTitle>
      <Lede>
        The parts this build is made of, in the order they go up. Each assembly step below is
        named after the part it advances.
      </Lede>

      <ol className="parts__list">
        {guide.parts.map((part) => (
          <li className="part" key={part.id}>
            <span className="part__name">{part.label}</span>
            <span className="part__count">{part.blocks.toLocaleString()}</span>
            <span className="part__note">{partExtent(part)}</span>
          </li>
        ))}
      </ol>
    </Sheet>
  );
}

/** `7 × 4 × 11` — the box a part occupies, which is how you spot the roof in a list. */
function partExtent(part: GuidePart): string {
  if (!part.min || !part.max) return '';
  const [x0, y0, z0] = part.min;
  const [x1, y1, z1] = part.max;
  return `${x1 - x0 + 1} × ${y1 - y0 + 1} × ${z1 - z0 + 1}`;
}

/* --- bill of materials ----------------------------------------------------------------- */

function Materials({ guide }: { guide: BuildGuide }) {
  return (
    <Sheet variant="materials" break="after">
      <SheetTitle>Bill of materials</SheetTitle>
      <Lede>
        Everything the build needs, most-used first. Stacks are the unit you actually gather
        in, so they are spelled out; a door counts once, not twice.
      </Lede>

      <ol className="materials__list">
        {guide.materials.map((material) => (
          <li className="material" key={material.block}>
            <Swatch block={material.block} />
            <span className="material__name">{material.displayName}</span>
            <span className="material__count">{material.count.toLocaleString()}</span>
            <span className="material__stacks">{stackText(material)}</span>
          </li>
        ))}
      </ol>
    </Sheet>
  );
}

/* --- steps ------------------------------------------------------------------------------ */

function orientationName(orientation: CameraOrientation): string {
  switch (orientation) {
    case 'SE':
      return 'south-east';
    case 'SW':
      return 'south-west';
    case 'NW':
      return 'north-west';
    case 'NE':
      return 'north-east';
  }
}

function StepCard({
  step,
  total,
  plan,
  shot,
  placed,
  totalBlocks,
}: {
  step: BuildStep;
  total: number;
  plan: LayerPlan;
  shot: string | undefined;
  /** Blocks placed once this step is done, counting every step before it. */
  placed: number;
  totalBlocks: number;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);

  // Layout effect, not effect: the canvas sets its own width/height, and doing that after
  // paint makes every card visibly resize once on first render.
  useLayoutEffect(() => {
    if (canvas.current) drawLayerPlan(canvas.current, plan);
  }, [plan]);

  // Named after the part it mostly places, so anything else riding along in the step is said
  // out loud rather than left for the reader to find mid-course.
  const also = step.parts.slice(1);
  const orientation = step.optimalOrientation ?? 'SE';

  return (
    <article className="step" id={`step-${step.index}`}>
      <header className="step__head">
        <div className="step__id">
          <span className="step__index">
            Step {step.index}
            <span className="step__of"> of {total}</span>
          </span>
          <span className="step__layer">
            {placed.toLocaleString()} of {totalBlocks.toLocaleString()} · y = {step.layer}
            {step.partOfLayer && (
              <span className="step__part">
                {' '}
                ({step.partOfLayer.part} of {step.partOfLayer.total})
              </span>
            )}
          </span>
          {step.hasOverhangs && (
            <span className="step__overhang-pill" title={`${step.overhangCount} unsupported blocks`}>
              ⚠ {step.overhangCount} Overhang{step.overhangCount === 1 ? '' : 's'}
            </span>
          )}
        </div>

        <h3 className="step__title">{step.title}</h3>

        {also.length > 0 && (
          <p className="step__also">
            with {also.map((part) => `${part.label} × ${part.blocks}`).join(', ')}
          </p>
        )}

        <StepTray items={step.trayItems} className="step__tray" />

        <ul className="step__materials">
          {step.materials.map((material) => (
            <li key={material.block}>
              <Swatch block={material.block} small />
              {material.count} × {material.displayName}
            </li>
          ))}
        </ul>
      </header>

      <div className="step__panels">
        <ArtFrame size="panel" caption={`Layer ${step.layer} from above — place the outlined squares`}>
          <canvas className="panel__plan" ref={canvas} />
        </ArtFrame>
        <ArtFrame size="panel" caption={`After this step — seen from the ${orientationName(orientation)}`}>
          <ArtImage className="panel__shot" src={shot} alt={`The build after step ${step.index} seen from ${orientation}`} />
        </ArtFrame>
      </div>
    </article>
  );
}

/* --- rendering ------------------------------------------------------------------------- */

interface Filmstrip {
  shots: readonly string[];
  /** The finished build, rendered large. Doubles as the "everything is done" flag. */
  cover: string | null;
  elapsedMs: number;
}

const EMPTY: Filmstrip = { shots: [], cover: null, elapsedMs: 0 };

/**
 * Drive one `IsoFilmstrip` across frames until every step has an image.
 *
 * Batched by a time budget rather than a step count, because a step's cost is dominated by
 * the PNG readback and that scales with the *image*, not with how many blocks were placed.
 * The loop always renders at least one step per frame, so a build slow enough to blow the
 * whole budget on a single readback still finishes instead of stalling. Progress is pushed
 * to state once per frame, not per step: 40 renders would otherwise be 40 re-renders of a
 * page holding 40 canvases.
 *
 * When the guide is over the printable cap only the cover is wanted, so the whole build is
 * placed in one pass and read back once — the readbacks, not the meshing, are what would
 * have taken minutes.
 */
function useFilmstrip(
  build: LoadedBuild,
  guide: BuildGuide,
  printable: boolean,
  enabled: boolean,
): Filmstrip {
  const [state, setState] = useState<Filmstrip>(EMPTY);

  useEffect(() => {
    setState(EMPTY);
    if (!enabled) return;

    let cancelled = false;
    let frame = 0;
    const film = new IsoFilmstrip(build.grid.size, build.paletteColors, build.paletteFlags);
    const shots: string[] = [];
    const startedAt = performance.now();

    const finish = () => {
      // The scene already holds the finished build, so the cover is one extra readback
      // rather than a second pass over the steps — but it has to stop highlighting first, or
      // the finished building comes out muted except for whatever the last step placed.
      film.settle();
      film.setOrientation('SE');
      const cover = film.snapshot(COVER_W, COVER_H, 'SE');
      setState({ shots, cover, elapsedMs: Math.round(performance.now() - startedAt) });
      film.dispose();
    };

    const pump = () => {
      if (cancelled) return;

      if (!printable) {
        for (const step of guide.steps) film.place(step.blocks);
        finish();
        return;
      }

      const until = performance.now() + FRAME_BUDGET_MS;
      do {
        const step = guide.steps[shots.length];
        if (!step) break;
        film.place(step.blocks);
        shots.push(film.snapshot(STEP_W, STEP_H, step.optimalOrientation));
      } while (performance.now() < until);

      if (shots.length < guide.steps.length) {
        setState({ shots: shots.slice(), cover: null, elapsedMs: 0 });
        frame = requestAnimationFrame(pump);
        return;
      }
      finish();
    };

    frame = requestAnimationFrame(pump);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      film.dispose();
    };
  }, [build, guide, printable, enabled]);

  return state;
}

/**
 * One `LayerPlan` per step, built once.
 *
 * Stable identities matter here: the plan object is the dependency of the canvas draw
 * effect, so rebuilding them on every render would redraw all 40 canvases on every state
 * update the filmstrip pushes.
 */
function useLayerPlans(build: LoadedBuild, guide: BuildGuide, printable: boolean): LayerPlan[] {
  return useMemo(() => {
    if (!printable) return [];
    const earlier = earlierInLayer(guide.steps);
    // One frame for every plan, taken from the whole build: a step whose blocks sit in one
    // corner must still line up with the step before it.
    const box = footprint(
      guide.steps.flatMap((step) =>
        step.blocks.map((b): PlanCell => ({
          x: b.x,
          z: b.z,
          paletteIndex: b.paletteIndex,
          isOverhang: b.isOverhang,
        })),
      ),
    );

    return guide.steps.map((step, i) => ({
      size: build.grid.size,
      voxels: build.grid.voxels,
      paletteColors: build.paletteColors,
      footprint: box,
      layer: step.layer,
      hasOverhangs: step.hasOverhangs,
      overhangCount: step.overhangCount,
      placed: step.blocks.map(
        (b): PlanCell => ({
          x: b.x,
          z: b.z,
          paletteIndex: b.paletteIndex,
          isOverhang: b.isOverhang,
        }),
      ),
      earlier: earlier[i] ?? [],
    }));
  }, [build, guide, printable]);
}

/* --- formatting -------------------------------------------------------------------------- */

/** `3 stacks + 60` — how a player counts, rather than a bare 252. */
function stackText(material: MaterialCount): string {
  if (material.stacks === 0) return `${material.remainder}`;
  const stacks = `${material.stacks} stack${material.stacks === 1 ? '' : 's'}`;
  return material.remainder === 0 ? stacks : `${stacks} + ${material.remainder}`;
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

/* --- digital builder mode ----------------------------------------------------------------- */

function getStepSnapshot(
  build: LoadedBuild,
  guide: BuildGuide,
  stepIndex: number,
  orientation: CameraOrientation,
  filmShots: readonly string[],
  cache: Map<string, string>,
): string {
  const step = guide.steps[stepIndex];
  if (!step) return '';
  const optimal = step.optimalOrientation ?? 'SE';
  if (orientation === optimal && filmShots[stepIndex]) {
    return filmShots[stepIndex]!;
  }
  const cacheKey = `${stepIndex}:${orientation}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const film = new IsoFilmstrip(build.grid.size, build.paletteColors, build.paletteFlags, true, orientation);
  for (let i = 0; i <= stepIndex; i++) {
    film.place(guide.steps[i]!.blocks);
  }
  const shot = film.snapshot(STEP_W, STEP_H, orientation);
  film.dispose();
  cache.set(cacheKey, shot);
  return shot;
}

function BuilderView({
  build,
  guide,
  film,
  plans,
  editorHref,
  buildId,
  onSwitchToBooklet,
}: {
  build: LoadedBuild;
  guide: BuildGuide;
  film: Filmstrip;
  plans: readonly LayerPlan[];
  editorHref: string;
  buildId: string;
  onSwitchToBooklet: () => void;
}) {
  const totalSteps = guide.steps.length;
  const progressKey = `craftmagic:guide:progress:${buildId}`;

  // Completed steps persistence in localStorage
  const [completed, setCompleted] = useState<Set<number>>(() => {
    try {
      const saved = localStorage.getItem(progressKey);
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr)) return new Set<number>(arr);
      }
    } catch {
      // ignore
    }
    return new Set<number>();
  });

  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem(progressKey, JSON.stringify([...completed]));
    } catch {
      // ignore
    }
  }, [progressKey, completed]);

  const handleResetProgress = () => {
    if (window.confirm('Reset all step progress for this build?')) {
      setCompleted(new Set());
      try {
        localStorage.removeItem(progressKey);
      } catch {
        // ignore
      }
    }
  };

  const currentStep = guide.steps[activeStep];
  const currentPlan = plans[activeStep];
  const dimensions = useMemo(() => {
    return placedDimensions(currentPlan ? currentPlan.placed : []);
  }, [currentPlan]);

  // Camera orientation state per step or active
  const [customOrientations, setCustomOrientations] = useState<Record<number, CameraOrientation>>({});
  const [cueOrientation, setCueOrientation] = useState<string | null>(null);
  const cueTimerRef = useRef<number | null>(null);

  const orientation: CameraOrientation =
    (currentStep && customOrientations[activeStep]) ?? currentStep?.optimalOrientation ?? 'SE';

  const setOrientation = (orient: CameraOrientation) => {
    setCustomOrientations((prev) => ({ ...prev, [activeStep]: orient }));
    setCueOrientation(`Facing ${orient} (${orientationName(orient)})`);
    if (cueTimerRef.current) clearTimeout(cueTimerRef.current);
    cueTimerRef.current = window.setTimeout(() => setCueOrientation(null), 1800);
  };

  const cycleOrientation = () => {
    const list: CameraOrientation[] = ['SE', 'SW', 'NW', 'NE'];
    const idx = list.indexOf(orientation);
    const next = list[(idx + 1) % list.length]!;
    setOrientation(next);
  };

  // Zoom state for 2D Plan
  const [zoom, setZoom] = useState(1);
  const handleZoomIn = () => setZoom((z) => Math.min(2.5, +(z + 0.25).toFixed(2)));
  const handleZoomOut = () => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)));
  const handleZoomReset = () => setZoom(1);

  // Mobile tab state
  const [mobileTab, setMobileTab] = useState<'plan' | 'model'>('plan');

  // Shortcuts modal state
  const [helpOpen, setHelpOpen] = useState(false);
  const builderRef = useRef<HTMLDivElement | null>(null);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      builderRef.current?.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };

  const isCurrentDone = completed.has(activeStep);
  const toggleCurrentDone = () => {
    setCompleted((prev) => {
      const next = new Set(prev);
      if (next.has(activeStep)) {
        next.delete(activeStep);
      } else {
        next.add(activeStep);
      }
      return next;
    });
  };

  const markDoneAndAdvance = () => {
    setCompleted((prev) => new Set(prev).add(activeStep));
    if (activeStep < totalSteps - 1) {
      setActiveStep((s) => s + 1);
    }
  };

  // 3D snapshot cache
  const cacheRef = useRef<Map<string, string>>(new Map());
  const shot = useMemo(() => {
    if (!currentStep) return '';
    return getStepSnapshot(build, guide, activeStep, orientation, film.shots, cacheRef.current);
  }, [build, guide, activeStep, orientation, film.shots, currentStep]);

  // 2D Plan canvas ref
  const planCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => {
    if (planCanvasRef.current && currentPlan) {
      drawLayerPlan(planCanvasRef.current, currentPlan);
    }
  }, [currentPlan]);

  // Auto-scroll timeline to active step
  const timelineRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = timelineRef.current?.querySelector(`[data-step-index="${activeStep}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [activeStep]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      if (e.key === '?' || e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        setHelpOpen((open) => !open);
        return;
      }
      if (e.key === 'Escape') {
        if (helpOpen) {
          e.preventDefault();
          setHelpOpen(false);
        }
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (activeStep < totalSteps - 1) setActiveStep((s) => s + 1);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (activeStep > 0) setActiveStep((s) => s - 1);
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        markDoneAndAdvance();
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        setActiveStep(0);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        setActiveStep(totalSteps - 1);
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        cycleOrientation();
        return;
      }
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeStep, totalSteps, helpOpen, orientation]);

  if (!currentStep) return null;

  const percent = totalSteps > 0 ? Math.round((completed.size / totalSteps) * 100) : 0;
  const isFinalStep = activeStep === totalSteps - 1;

  return (
    <div
      ref={builderRef}
      className="guide guide--builder"
      data-build={buildId}
      data-step={activeStep + 1}
      data-total={totalSteps}
    >
      {/* Builder Header */}
      <header className="builder__header">
        <Link className="guide__back" to={editorHref}>
          ← Back to editor
        </Link>
        <button
          type="button"
          className="builder__btn builder__btn--subtle"
          onClick={onSwitchToBooklet}
          title="Switch to printable booklet view"
        >
          📖 Booklet view
        </button>

        <div className="builder__header-center">
          <span className="builder__step-badge">
            Step {activeStep + 1} of {totalSteps} · y = {currentStep.layer}
          </span>
          <span className="builder__progress-badge">{percent}% complete</span>
        </div>

        <div className="builder__header-actions">
          <button
            type="button"
            className="builder__btn builder__btn--subtle"
            onClick={handleResetProgress}
            title="Reset progress"
          >
            Reset progress
          </button>
          <button
            type="button"
            className="builder__btn builder__btn--circle"
            onClick={() => setHelpOpen((o) => !o)}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            ?
          </button>
        </div>

        <div
          className="builder__progress-bar"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="builder__progress-fill" style={{ width: `${percent}%` }} />
        </div>
      </header>

      {/* Top Shelf Parts Tray */}
      <div className="builder__shelf">
        <div className="builder__shelf-tray">
          <span className="builder__shelf-label">Parts for Step {activeStep + 1}:</span>
          <StepTray items={currentStep.trayItems} className="builder__tray" />
        </div>
        {currentStep.hasOverhangs && (
          <div className="builder__overhang-alert" role="alert">
            <span className="builder__overhang-icon">⚠</span>
            <span>
              <strong>Overhang warning:</strong> {currentStep.overhangCount} block
              {currentStep.overhangCount === 1 ? '' : 's'} placed without support beneath
            </span>
          </div>
        )}
      </div>

      {/* Responsive mobile tab switcher */}
      <div className="builder__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mobileTab === 'plan'}
          className={`builder__tab ${mobileTab === 'plan' ? 'is-active' : ''}`}
          onClick={() => setMobileTab('plan')}
        >
          2D Plan
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobileTab === 'model'}
          className={`builder__tab ${mobileTab === 'model' ? 'is-active' : ''}`}
          onClick={() => setMobileTab('model')}
        >
          3D View
        </button>
      </div>

      {/* Dual Panel Stage */}
      <main className="builder__stage">
        {/* Left Panel: 2D Layer Plan */}
        <section
          className={`builder__panel builder__panel--plan ${mobileTab === 'plan' ? 'is-mobile-visible' : ''}`}
          aria-label="2D Layer Plan"
        >
          <div className="builder__panel-head">
            <div className="builder__panel-title">
              <strong>Layer {currentStep.layer} Plan</strong>
              {currentPlan && (
                <span className="builder__panel-meta">
                  {' '}· {dimensions.text}
                </span>
              )}
            </div>
            <div className="builder__zoom-controls">
              <button
                type="button"
                className="builder__btn builder__btn--small"
                onClick={handleZoomOut}
                disabled={zoom <= 0.5}
                title="Zoom out"
              >
                −
              </button>
              <button
                type="button"
                className="builder__btn builder__btn--small builder__btn--zoom-val"
                onClick={handleZoomReset}
                title="Reset zoom"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                className="builder__btn builder__btn--small"
                onClick={handleZoomIn}
                disabled={zoom >= 2.5}
                title="Zoom in"
              >
                +
              </button>
            </div>
          </div>
          <div className="builder__panel-body builder__panel-body--canvas">
            <div
              className="builder__canvas-transform"
              style={{
                transform: `scale(${zoom})`,
                transformOrigin: 'center center',
              }}
            >
              <canvas ref={planCanvasRef} className="builder__plan-canvas" />
            </div>
          </div>
        </section>

        {/* Right Panel: 3D View */}
        <section
          className={`builder__panel builder__panel--model ${mobileTab === 'model' ? 'is-mobile-visible' : ''}`}
          aria-label="3D Model View"
        >
          <div className="builder__panel-head">
            <div className="builder__panel-title">
              <strong>3D View</strong>
              <span className="builder__panel-meta">
                {' '}· seen from {orientationName(orientation)} ({orientation})
              </span>
            </div>
            <div className="builder__orientation-controls">
              <button
                type="button"
                className="builder__btn builder__btn--small builder__btn--rotate"
                onClick={cycleOrientation}
                title="Rotate camera view (R)"
              >
                ↺ Rotated to {orientation}
              </button>
              <div className="builder__orient-buttons" role="group" aria-label="Camera orientation">
                {(['SE', 'SW', 'NW', 'NE'] as const).map((dir) => (
                  <button
                    key={dir}
                    type="button"
                    className={`builder__btn builder__btn--dir ${dir === orientation ? 'is-active' : ''}`}
                    onClick={() => setOrientation(dir)}
                    title={`View from ${dir} (${orientationName(dir)})`}
                  >
                    {dir}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="builder__panel-body builder__panel-body--model">
            {cueOrientation && (
              <div className="builder__cue-badge" role="status">
                {cueOrientation}
              </div>
            )}
            {shot ? (
              <img
                src={shot}
                alt={`Model view after step ${activeStep + 1} from ${orientation}`}
                className="builder__model-image"
              />
            ) : (
              <div className="builder__loading-model">Rendering 3D model…</div>
            )}
          </div>
        </section>
      </main>

      {/* Floating Stepper Bar */}
      <footer className="builder__stepper">
        <button
          type="button"
          className="builder__btn builder__stepper-nav"
          onClick={() => setActiveStep((s) => Math.max(0, s - 1))}
          disabled={activeStep === 0}
          title="Previous step (Left Arrow)"
        >
          ‹ Prev
        </button>

        <div className="builder__stepper-center">
          <div className="builder__stepper-title">
            <span className="builder__stepper-step">Step {activeStep + 1}:</span> {currentStep.title}
          </div>
          <button
            type="button"
            className={`builder__btn builder__done-btn ${isCurrentDone ? 'is-completed' : ''}`}
            onClick={toggleCurrentDone}
            title="Mark current step done (Space)"
          >
            {isCurrentDone ? '✓ Completed' : '✓ Mark Step Done'}
          </button>
        </div>

        {isFinalStep ? (
          <button
            type="button"
            className={`builder__btn builder__stepper-nav builder__btn--finish ${
              completed.size === totalSteps ? 'is-all-done' : ''
            }`}
            onClick={markDoneAndAdvance}
            title="Finish Build"
          >
            Finish Build 🎉
          </button>
        ) : (
          <button
            type="button"
            className="builder__btn builder__stepper-nav"
            onClick={() => setActiveStep((s) => Math.min(totalSteps - 1, s + 1))}
            title="Next step (Right Arrow or Space)"
          >
            Next ›
          </button>
        )}
      </footer>

      {/* Timeline Scrubber */}
      <nav className="builder__timeline" ref={timelineRef} aria-label="Step timeline">
        {guide.steps.map((st, i) => {
          const isDone = completed.has(i);
          const isCurrent = i === activeStep;
          return (
            <button
              key={st.index}
              type="button"
              data-step-index={i}
              className={`timeline-node ${isCurrent ? 'is-active' : ''} ${isDone ? 'is-completed' : ''} ${
                st.hasOverhangs ? 'has-overhang' : ''
              }`}
              onClick={() => setActiveStep(i)}
              title={`Step ${i + 1}: ${st.title}${st.hasOverhangs ? ' (Overhang)' : ''}${isDone ? ' (Completed)' : ''}`}
            >
              {i + 1}
            </button>
          );
        })}
      </nav>

      {/* Shortcuts Cheat Sheet Modal */}
      {helpOpen && (
        <div
          className="builder__modal-backdrop"
          onClick={() => setHelpOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="shortcuts-title"
        >
          <div className="builder__modal" onClick={(e) => e.stopPropagation()}>
            <div className="builder__modal-head">
              <h3 id="shortcuts-title">Keyboard Shortcuts</h3>
              <button
                type="button"
                className="builder__modal-close"
                onClick={() => setHelpOpen(false)}
                aria-label="Close shortcuts modal"
              >
                ✕
              </button>
            </div>
            <div className="builder__shortcuts-list">
              <div className="builder__shortcut-row">
                <span className="builder__shortcut-keys">
                  <kbd>→</kbd>
                </span>
                <span>Next step</span>
              </div>
              <div className="builder__shortcut-row">
                <span className="builder__shortcut-keys">
                  <kbd>←</kbd>
                </span>
                <span>Previous step</span>
              </div>
              <div className="builder__shortcut-row">
                <span className="builder__shortcut-keys">
                  <kbd>Space</kbd>
                </span>
                <span>Mark step done & advance</span>
              </div>
              <div className="builder__shortcut-row">
                <span className="builder__shortcut-keys">
                  <kbd>R</kbd>
                </span>
                <span>Cycle camera orientation (SE → SW → NW → NE)</span>
              </div>
              <div className="builder__shortcut-row">
                <span className="builder__shortcut-keys">
                  <kbd>Home</kbd> / <kbd>End</kbd>
                </span>
                <span>Jump to first / last step</span>
              </div>
              <div className="builder__shortcut-row">
                <span className="builder__shortcut-keys">
                  <kbd>F</kbd>
                </span>
                <span>Toggle fullscreen mode</span>
              </div>
              <div className="builder__shortcut-row">
                <span className="builder__shortcut-keys">
                  <kbd>?</kbd> or <kbd>H</kbd>
                </span>
                <span>Toggle shortcuts cheat sheet</span>
              </div>
              <div className="builder__shortcut-row">
                <span className="builder__shortcut-keys">
                  <kbd>Esc</kbd>
                </span>
                <span>Close modal</span>
              </div>
            </div>
            <button
              type="button"
              className="builder__btn builder__modal-btn"
              onClick={() => setHelpOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
