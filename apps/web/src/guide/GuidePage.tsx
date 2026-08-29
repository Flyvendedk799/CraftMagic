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
  type GuidePart,
  type MaterialCount,
} from '@craftmagic/core';
import { expandBuild, isBuildId, type LoadedBuild } from '../editor/builds.js';
import { useLibraryBuild } from '../library/useLibraryBuild.js';
import { carrySettings, parseScale, scaleKey as readScaleKey, PARAM_PREFIX, STYLE_PARAM } from '../editor/urlState.js';
import { IsoFilmstrip } from './isoRender.js';
import { drawLayerPlan, earlierInLayer, footprint, type LayerPlan, type PlanCell } from './layerGrid.js';
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
  const [params] = useSearchParams();

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

  return (
    <article className="step">
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
        </div>

        <h3 className="step__title">{step.title}</h3>

        {also.length > 0 && (
          <p className="step__also">
            with {also.map((part) => `${part.label} × ${part.blocks}`).join(', ')}
          </p>
        )}

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
        <ArtFrame size="panel" caption="After this step — seen from the south-east">
          <ArtImage className="panel__shot" src={shot} alt={`The build after step ${step.index}`} />
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
      const cover = film.snapshot(COVER_W, COVER_H);
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
        shots.push(film.snapshot(STEP_W, STEP_H));
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
      guide.steps.flatMap((step) => step.blocks.map((b): PlanCell => ({ x: b.x, z: b.z, paletteIndex: b.paletteIndex }))),
    );

    return guide.steps.map((step, i) => ({
      size: build.grid.size,
      voxels: build.grid.voxels,
      paletteColors: build.paletteColors,
      footprint: box,
      layer: step.layer,
      placed: step.blocks.map((b): PlanCell => ({ x: b.x, z: b.z, paletteIndex: b.paletteIndex })),
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
