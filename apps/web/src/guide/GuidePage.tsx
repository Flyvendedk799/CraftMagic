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
import { buildGuide, colorOf, type BuildGuide, type BuildStep, type MaterialCount } from '@imaginecraft/core';
import { expandBuild, isBuildId, type LoadedBuild } from '../editor/builds.js';
import { IsoFilmstrip } from './isoRender.js';
import { drawLayerPlan, earlierInLayer, footprint, type LayerPlan, type PlanCell } from './layerGrid.js';
import './print.css';

const DEFAULT_BUILD = 'cottage';
/** Same convention as the editor, so a guide link is the editor's URL with a new path. */
const PARAM_PREFIX = 'p.';

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
  const buildId = isBuildId(rawBuild) ? rawBuild : DEFAULT_BUILD;

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

  const build = useMemo(() => expandBuild(buildId, parseOverrides(overrideKey)), [buildId, overrideKey]);
  const guide = useMemo(() => buildGuide(build.grid, build.name), [build]);

  const printable = guide.steps.length <= MAX_PRINTABLE_STEPS;
  const film = useFilmstrip(build, guide, printable);
  const ready = film.cover !== null;

  const plans = useLayerPlans(build, guide, printable);
  const editorHref = useMemo(() => {
    const search = new URLSearchParams();
    search.set('build', buildId);
    if (overrideKey) {
      for (const entry of overrideKey.split('&')) {
        const [name, value] = entry.split('=');
        if (name && value) search.set(PARAM_PREFIX + name, value);
      }
    }
    return `/?${search.toString()}`;
  }, [buildId, overrideKey]);

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
      <Materials guide={guide} />

      {printable ? (
        <section className="steps">
          <h2 className="sheet__title steps__title">Assembly</h2>
          {guide.steps.map((step, i) => (
            <StepCard
              key={step.index}
              step={step}
              total={guide.steps.length}
              plan={plans[i]!}
              shot={film.shots[i]}
            />
          ))}
        </section>
      ) : (
        <article className="sheet oversize">
          <h2 className="sheet__title">Assembly</h2>
          <p className="sheet__lede">
            This build segments into {guide.steps.length.toLocaleString()} steps — about{' '}
            {Math.ceil(guide.steps.length / 2).toLocaleString()} printed pages, past what a
            booklet can usefully be. The cover and the bill of materials above still apply;
            for step-by-step assembly, resize the build down in the editor or export a
            schematic instead.
          </p>
        </article>
      )}

      <footer className="guide__foot">
        Built from a program, not a picture — resize it in the editor and print a new booklet.
      </footer>
    </div>
  );
}

/* --- cover ---------------------------------------------------------------------------- */

function Cover({ build, guide, art }: { build: LoadedBuild; guide: BuildGuide; art: string | null }) {
  return (
    <article className="sheet cover">
      <p className="cover__eyebrow">ImagineCraft · Build guide</p>
      <h1 className="cover__title">{guide.name}</h1>
      {build.description && <p className="cover__lede">{build.description}</p>}

      <figure className="cover__art">
        {art ? (
          <img src={art} alt={`Finished ${guide.name}, seen from above at an angle`} />
        ) : (
          <span className="art__wait">Rendering…</span>
        )}
      </figure>

      <dl className="cover__stats">
        <div>
          <dt>Dimensions</dt>
          <dd>
            {guide.size.x} × {guide.size.y} × {guide.size.z}
          </dd>
          <dd className="stat__note">W × H × L</dd>
        </div>
        <div>
          <dt>Blocks</dt>
          <dd>{guide.totalBlocks.toLocaleString()}</dd>
          <dd className="stat__note">{guide.materials.length} kinds</dd>
        </div>
        <div>
          <dt>Steps</dt>
          <dd>{guide.steps.length.toLocaleString()}</dd>
          <dd className="stat__note">bottom-up</dd>
        </div>
        <div>
          <dt>Difficulty</dt>
          <dd className="stat__difficulty">{guide.difficulty}</dd>
          {/* Layers that hold something, not the grid's height: an empty top half is not
              work, and a builder counting courses would be told the wrong number. */}
          <dd className="stat__note">{new Set(guide.steps.map((step) => step.layer)).size} layers</dd>
        </div>
      </dl>
    </article>
  );
}

/* --- bill of materials ----------------------------------------------------------------- */

function Materials({ guide }: { guide: BuildGuide }) {
  return (
    <article className="sheet materials">
      <h2 className="sheet__title">Bill of materials</h2>
      <p className="sheet__lede">
        Everything the build needs, most-used first. Stacks are the unit you actually gather
        in, so they are spelled out; a door counts once, not twice.
      </p>

      <ol className="materials__list">
        {guide.materials.map((material) => (
          <li className="material" key={material.block}>
            <span className="swatch" style={{ background: cssColor(material.block) }} aria-hidden="true" />
            <span className="material__name">{material.displayName}</span>
            <span className="material__count">{material.count.toLocaleString()}</span>
            <span className="material__stacks">{stackText(material)}</span>
          </li>
        ))}
      </ol>
    </article>
  );
}

/* --- steps ------------------------------------------------------------------------------ */

function StepCard({
  step,
  total,
  plan,
  shot,
}: {
  step: BuildStep;
  total: number;
  plan: LayerPlan;
  shot: string | undefined;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);

  // Layout effect, not effect: the canvas sets its own width/height, and doing that after
  // paint makes every card visibly resize once on first render.
  useLayoutEffect(() => {
    if (canvas.current) drawLayerPlan(canvas.current, plan);
  }, [plan]);

  return (
    <article className="step">
      <header className="step__head">
        <span className="step__index">
          Step {step.index}
          <span className="step__of"> of {total}</span>
        </span>
        <span className="step__layer">
          y = {step.layer}
          {step.partOfLayer && (
            <span className="step__part">
              {' '}
              ({step.partOfLayer.part} of {step.partOfLayer.total})
            </span>
          )}
        </span>
        <ul className="step__materials">
          {step.materials.map((material) => (
            <li key={material.block}>
              <span className="swatch swatch--small" style={{ background: cssColor(material.block) }} aria-hidden="true" />
              {material.count} × {material.displayName}
            </li>
          ))}
        </ul>
      </header>

      <div className="step__panels">
        <figure className="panel">
          <canvas className="panel__plan" ref={canvas} />
          <figcaption>Layer {step.layer} from above — place the outlined squares</figcaption>
        </figure>
        <figure className="panel">
          {shot ? (
            <img className="panel__shot" src={shot} alt={`The build after step ${step.index}`} />
          ) : (
            <span className="art__wait">Rendering…</span>
          )}
          <figcaption>How it looks once this step is done</figcaption>
        </figure>
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
function useFilmstrip(build: LoadedBuild, guide: BuildGuide, printable: boolean): Filmstrip {
  const [state, setState] = useState<Filmstrip>(EMPTY);

  useEffect(() => {
    setState(EMPTY);

    let cancelled = false;
    let frame = 0;
    const film = new IsoFilmstrip(build.grid.size, build.paletteColors, build.paletteFlags);
    const shots: string[] = [];
    const startedAt = performance.now();

    const finish = () => {
      // The scene already holds the finished build, so the cover is one extra readback
      // rather than a second pass over the steps.
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
  }, [build, guide, printable]);

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

function cssColor(block: string): string {
  const [r, g, b] = colorOf(block);
  return `rgb(${r}, ${g}, ${b})`;
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
