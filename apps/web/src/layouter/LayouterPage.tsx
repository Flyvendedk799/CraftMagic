/**
 * The layouter.
 *
 * A second way into the same engine. The editor is a voxel tool — you place blocks, and the
 * building is whatever the blocks add up to. This is the other half of the job: you lay out
 * *rooms*, and the blocks are a consequence. Interiors are where that difference bites, because
 * the thing you are actually deciding — where a wall goes, where a door goes through it,
 * whether you can get from the entrance to the back room — is invisible from outside and
 * miserable to nudge one block at a time.
 *
 * Three things follow from that, and they are the whole design:
 *
 * **The plan is the document.** Not the voxels. Every gesture edits a floorplan, and the
 * building is compiled from it on every change (`compile.ts`) into an ordinary
 * `BuildProgram` — which is why the export controls here are literally the editor's
 * `ExportBar`, not a copy of it. Schematic, program JSON, library, "Send to game" and the
 * printable guide all work because a compiled plan is not a special kind of build.
 *
 * **Two views, one of which you draw in.** The plan on the left is where the work happens; the
 * model on the right is where you check it. The model can be cut at the storey being edited,
 * which is the only way to look inside a finished building.
 *
 * **No prompt box.** Deliberately. The editor has generation and refinement, and neither
 * belongs on a tool whose entire premise is that you know what you want and the fastest way to
 * get it is to draw it. Everything here is direct manipulation, and the two pages share the
 * expander, the mesher, the exports and the library rather than sharing a model.
 *
 * The level editor engine from flyvendedk799/firstpgame is reused throughout — its plan
 * viewport, grid and wall-insert snapping, snapshot history, autosave, kit-driven materials
 * and walkability validation, each ported to TypeScript in the module named in its header.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { expand, paletteColors, paletteFlags, type VoxelGrid } from '@craftmagic/core';
import { EditorCanvas, type ViewKind, type ViewRequest } from '../editor/EditorCanvas.js';
import { ExportBar } from '../editor/ExportBar.js';
import { Section } from '../editor/Section.js';
import { registerGeneratedBuild } from '../editor/builds.js';
import { AccountPanel } from '../library/AccountPanel.js';
import { AppNav } from '../shell/AppNav.js';
import { compilePlan } from './compile.js';
import { FloorStack } from './FloorStack.js';
import { Inspector } from './Inspector.js';
import { IssuesPanel, issueSummary } from './IssuesPanel.js';
import { PlanCanvas } from './PlanCanvas.js';
import { SitePanel } from './SitePanel.js';
import {
  addItem,
  countItems,
  findItem,
  planId,
  removeItem,
  replaceItem,
  type LayoutPlan,
  type PlanItem,
} from './plan.js';
import { downloadPlan, parsePlanFile } from './storage.js';
import { TEMPLATES, templateById } from './templates.js';
import { LAYOUT_TOOLS, LAYOUT_TOOL_BY_ID, layoutToolForKey, type LayoutToolId } from './toolset.js';
import { usePlanSession } from './usePlanSession.js';
import { validatePlan } from './validate.js';
import '../editor/editor.css';
import './layouter.css';

const VIEWS: readonly { kind: ViewKind; label: string }[] = [
  { kind: 'iso', label: 'Iso' },
  { kind: 'top', label: 'Top' },
  { kind: 'front', label: 'Front' },
  { kind: 'side', label: 'Side' },
];

/**
 * How long the model waits behind the plan.
 *
 * Re-expanding is cheap; re-meshing a whole building is not, and a dragged wall would ask for
 * both on every frame. The plan itself never waits — this delays only the 3D view and the
 * export's view of the grid, which is the right trade: the drawing has to be instant, and
 * nobody exports mid-drag.
 */
const PREVIEW_DELAY = 180;

/** An empty grid, so the page has something to hand the canvas before the first compile. */
const EMPTY_GRID: VoxelGrid = {
  size: { x: 1, y: 1, z: 1 },
  palette: ['minecraft:air'],
  voxels: new Uint16Array(1),
};

export function LayouterPage() {
  const navigate = useNavigate();
  const session = usePlanSession(() => templateById('blank')!.build());
  const { plan } = session;

  const [tool, setTool] = useState<LayoutToolId>('room');
  const [floorIndex, setFloorIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showBelow, setShowBelow] = useState(true);
  const [cutToStorey, setCutToStorey] = useState(true);
  const [view, setView] = useState<ViewRequest | null>(null);
  const [hover, setHover] = useState<{ x: number; z: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  /**
   * Re-frame the model.
   *
   * Only on a wholesale load — a template, a saved plan, an import. The camera deliberately
   * does *not* follow ordinary edits: a view that jumped every time a room changed the
   * building's bounds would be unusable, and after loading a different building the old
   * framing is simply wrong.
   */
  const frame = useCallback(() => {
    setView((prev) => ({ kind: 'iso', nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const load = useCallback(
    (next: LayoutPlan) => {
      session.reset(next);
      setSelectedId(null);
      setFloorIndex(0);
      setNotice(null);
      // After the deferred compile has produced the new grid, so the framing is of the
      // building that was just loaded rather than of the one leaving the screen.
      setTimeout(frame, PREVIEW_DELAY + 60);
    },
    [session, frame],
  );

  // A plan that lost a storey — an undo, a delete, an import — must not leave the canvas
  // editing a floor that no longer exists.
  const activeFloor = Math.min(floorIndex, plan.floors.length - 1);
  useEffect(() => {
    if (activeFloor !== floorIndex) setFloorIndex(activeFloor);
  }, [activeFloor, floorIndex]);

  const validation = useMemo(() => validatePlan(plan), [plan]);

  const deferred = useDeferred(plan, PREVIEW_DELAY);
  const built = useMemo(() => buildFrom(deferred), [deferred]);

  const selected = useMemo(() => findItem(plan, selectedId ?? ''), [plan, selectedId]);

  // --- mutation ----------------------------------------------------------

  const create = useCallback(
    (item: PlanItem) => {
      session.commit((current) => addItem(current, Math.min(floorIndex, current.floors.length - 1), item));
    },
    [session, floorIndex],
  );

  const change = useCallback(
    (item: PlanItem) => session.commit((current) => replaceItem(current, item.id, item)),
    [session],
  );

  const previewChange = useCallback(
    (item: PlanItem) => session.preview((current) => replaceItem(current, item.id, item)),
    [session],
  );

  const remove = useCallback(() => {
    if (!selectedId) return;
    session.commit((current) => removeItem(current, selectedId));
    setSelectedId(null);
  }, [session, selectedId]);

  const duplicate = useCallback(() => {
    if (!selected) return;
    const copy = offset({ ...selected.item, id: planId(selected.item.kind) }, 2, 2);
    session.commit((current) => addItem(current, selected.floorIndex, copy));
    setSelectedId(copy.id);
  }, [session, selected]);

  const sendToFloor = useCallback(
    (target: number) => {
      if (!selected || target === selected.floorIndex) return;
      session.commit((current) => addItem(removeItem(current, selected.item.id), target, selected.item));
      setFloorIndex(target);
    },
    [session, selected],
  );

  const nudge = useCallback(
    (dx: number, dz: number) => {
      if (!selected) return;
      change(offset(selected.item, dx, dz));
    },
    [selected, change],
  );

  // --- keyboard ----------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntry(event.target)) return;

      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'z') {
          event.preventDefault();
          if (event.shiftKey) session.redo();
          else session.undo();
          return;
        }
        if (key === 'y') {
          event.preventDefault();
          session.redo();
          return;
        }
        return;
      }

      const nextTool = layoutToolForKey(event.key);
      if (nextTool) {
        event.preventDefault();
        setTool(nextTool);
        setNotice(null);
        return;
      }

      switch (event.key) {
        case 'Escape':
          setSelectedId(null);
          setNotice(null);
          break;
        case 'Delete':
        case 'Backspace':
          if (selectedId) {
            event.preventDefault();
            remove();
          }
          break;
        case '[':
          event.preventDefault();
          setFloorIndex((index) => Math.max(0, index - 1));
          break;
        case ']':
          event.preventDefault();
          setFloorIndex((index) => Math.min(plan.floors.length - 1, index + 1));
          break;
        case 'ArrowLeft':
          if (selectedId) {
            event.preventDefault();
            nudge(-1, 0);
          }
          break;
        case 'ArrowRight':
          if (selectedId) {
            event.preventDefault();
            nudge(1, 0);
          }
          break;
        case 'ArrowUp':
          if (selectedId) {
            event.preventDefault();
            nudge(0, -1);
          }
          break;
        case 'ArrowDown':
          if (selectedId) {
            event.preventDefault();
            nudge(0, 1);
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [session, selectedId, remove, nudge, plan.floors.length]);

  // --- hand-off ----------------------------------------------------------

  /**
   * Register the compiled program as a build, so the rest of the product can address it.
   *
   * The editor and the guide both take `?build=<id>`, and generated builds are exactly the
   * mechanism for a program that came from somewhere other than the sample list. Registering
   * on demand rather than on every compile matters: the store is capped and persisted, and a
   * plan compiles on every keystroke.
   */
  const handOff = useCallback(
    (where: 'editor' | 'guide') => {
      const id = registerGeneratedBuild(built.program);
      if (where === 'editor') navigate(`/editor?build=${encodeURIComponent(id)}`);
      else window.open(`/guide?build=${encodeURIComponent(id)}`, '_blank', 'noreferrer');
    },
    [built.program, navigate],
  );

  const onImport = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        load(parsePlanFile(await file.text()));
        setImportError(null);
      } catch (error) {
        setImportError((error as Error).message);
      }
    },
    [load],
  );

  const storeyTop = plan.foundation + (activeFloor + 1) * plan.storeyHeight - 1;
  const layerClip = cutToStorey ? Math.min(storeyTop, built.grid.size.y - 1) : null;

  return (
    <div className="layouter">
      {/* The same bar the editor wears, for the same reason: this is a full-viewport tool, and
          without it the only way back out is whatever links its own panel happens to carry.
          The bar already lists this page as a destination, so arriving here and losing it was
          the one place the chrome contradicted itself. */}
      <AppNav current="layouter" />

      <section className="hud layouter__panel">
        <h1 className="hud__title">Layouter</h1>
        <p className="hud__sub">Floorplans, storey by storey</p>

        <div className="hud__actions">
          {TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              title={template.description}
              onClick={() => load(template.build())}
            >
              {template.name}
            </button>
          ))}
        </div>

        <Section id="layouter-tools" title="Draw" summary={LAYOUT_TOOL_BY_ID[tool].label}>
          <div className="tool-rail">
            {LAYOUT_TOOLS.map((spec) => (
              <button
                key={spec.id}
                type="button"
                aria-pressed={tool === spec.id}
                title={`${spec.hint}  (${spec.key})`}
                onClick={() => {
                  setTool(spec.id);
                  setNotice(null);
                }}
              >
                <span className="tool-rail__key">{spec.key}</span>
                {spec.label}
              </button>
            ))}
          </div>
          <p className="tool-rail__hint">{LAYOUT_TOOL_BY_ID[tool].hint}</p>

          <div className="tool-rail__history">
            <button type="button" onClick={session.undo} disabled={!session.canUndo}>
              Undo
            </button>
            <button type="button" onClick={session.redo} disabled={!session.canRedo}>
              Redo
            </button>
          </div>

          {notice && <p className="tool-rail__notice">{notice}</p>}
        </Section>

        <Section id="layouter-floors" title="Storeys" summary={`${plan.floors.length}`}>
          <FloorStack
            plan={plan}
            active={activeFloor}
            showBelow={showBelow}
            onShowBelow={setShowBelow}
            onSelect={(index) => {
              setFloorIndex(index);
              setSelectedId(null);
            }}
            onChange={(next) => session.commit(next)}
          />
        </Section>

        <Section id="layouter-inspector" title="Selection" summary={selected?.item.kind ?? 'none'}>
          <Inspector
            plan={plan}
            item={selected?.item ?? null}
            floorIndex={selected?.floorIndex ?? activeFloor}
            onChange={change}
            onDelete={remove}
            onDuplicate={duplicate}
            onSendToFloor={sendToFloor}
          />
        </Section>

        <Section id="layouter-site" title="Building" summary={`${plan.storeyHeight} high`} defaultOpen={false}>
          <SitePanel plan={plan} onChange={(next) => session.commit(next)} />
        </Section>

        <Section id="layouter-issues" title="Checks" summary={issueSummary(validation.issues)}>
          <IssuesPanel
            issues={validation.issues}
            onGo={(issue) => {
              if (issue.floorIndex !== undefined) setFloorIndex(issue.floorIndex);
              setSelectedId(issue.itemId ?? null);
            }}
          />
        </Section>

        <Section
          id="layouter-stats"
          title="Details"
          summary={`${built.grid.size.x}×${built.grid.size.y}×${built.grid.size.z} · ${built.blockCount.toLocaleString()}`}
          defaultOpen={false}
        >
          <dl className="hud__stats">
            <dt>Storeys</dt>
            <dd>{plan.floors.length}</dd>
            <dt>Rooms</dt>
            <dd>{validation.roomCount}</dd>
            <dt>Items</dt>
            <dd>{countItems(plan)}</dd>
            <dt>Size</dt>
            <dd>
              {built.grid.size.x}×{built.grid.size.y}×{built.grid.size.z}
            </dd>
            <dt>Blocks</dt>
            <dd>{built.blockCount.toLocaleString()}</dd>
            <dt>Components</dt>
            <dd>{built.program.components.length}</dd>
          </dl>
          {built.messages.length > 0 && (
            <ul className="hud__issues">
              {built.messages.slice(0, 4).map((message, index) => (
                <li key={index} className="issue--warn">
                  {message}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <ExportBar
          grid={built.grid}
          program={built.program}
          name={plan.name}
          detached={false}
          // The guide is offered as a button below rather than as a link: it needs the compiled
          // program registered under an id first, and doing that on every keystroke would fill
          // the generated-build store with a hundred drafts of the same building.
          guideHref={null}
          blockCount={built.blockCount}
        />

        <Section id="layouter-plans" title="Plans" summary={session.dirty ? 'unsaved' : 'saved'} defaultOpen={false}>
          <div className="plans__actions">
            <button type="button" onClick={session.save}>
              Save plan
            </button>
            <button type="button" onClick={() => downloadPlan(plan)}>
              Download .layout.json
            </button>
            <label className="plans__import">
              Open a plan
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  void onImport(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </label>
          </div>
          {importError && (
            <p className="tool-rail__notice" role="alert">
              {importError}
            </p>
          )}
          <p className="site-panel__hint">
            A plan is the drawing; a schematic is the finished building. Saved plans live in this
            browser — download one to keep it or pass it on.
          </p>
          <ul className="plans__list">
            {session.saved.map((entry) => (
              <li key={entry.id}>
                <button type="button" onClick={() => load(entry.plan)}>
                  {entry.name}
                </button>
                <button type="button" className="plans__delete" onClick={() => session.remove(entry.id)}>
                  ×
                </button>
              </li>
            ))}
            {session.saved.length === 0 && <li className="plans__empty">Nothing saved yet.</li>}
          </ul>
        </Section>

        <Section id="layouter-handoff" title="Hand off" defaultOpen={false}>
          <div className="plans__actions">
            <button type="button" onClick={() => handOff('editor')} disabled={built.blockCount === 0}>
              Open in the editor
            </button>
            <button type="button" onClick={() => handOff('guide')} disabled={built.blockCount === 0}>
              Build guide
            </button>
          </div>
          <p className="site-panel__hint">
            The editor takes the compiled building block by block — good for detailing, and a
            one-way trip: it edits voxels, not the plan.
          </p>
        </Section>

        <div className="save">
          <AccountPanel />
        </div>

        {/* The editor and the dashboard were listed here. Both are one click away in the bar
            above now, and a link that repeats one already on screen is furniture. */}
      </section>

      <div className="layouter__plan">
        <PlanCanvas
          plan={plan}
          floorIndex={activeFloor}
          tool={tool}
          selectedId={selectedId}
          unreachable={validation.unreachable}
          showBelow={showBelow}
          onSelect={setSelectedId}
          onBeginGesture={session.mark}
          onCreate={create}
          onPreview={previewChange}
          onNotice={setNotice}
          onHover={setHover}
        />

        <aside className="hover-readout layouter__readout">
          {hover ? (
            <>
              <strong>
                x {hover.x}, z {hover.z}
              </strong>
              {plan.floors[activeFloor]?.name} · click to {LAYOUT_TOOL_BY_ID[tool].verb}
            </>
          ) : (
            <>scroll to zoom · middle-drag to pan · [ and ] change storey</>
          )}
        </aside>
      </div>

      <div className="layouter__model">
        <EditorCanvas
          grid={built.grid}
          paletteColors={built.paletteColors}
          paletteFlags={built.paletteFlags}
          layerClip={layerClip}
          view={view}
        />
        <div className="layouter__model-bar">
          <label className="field field--toggle">
            <input
              type="checkbox"
              checked={cutToStorey}
              onChange={(event) => setCutToStorey(event.target.checked)}
            />
            <span className="field__label">Cut at this storey</span>
          </label>
          <span className="layers__views">
            {VIEWS.map((entry) => (
              <button
                key={entry.kind}
                type="button"
                title={`Look from ${entry.label.toLowerCase()}`}
                onClick={() => setView((prev) => ({ kind: entry.kind, nonce: (prev?.nonce ?? 0) + 1 }))}
              >
                {entry.label}
              </button>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

interface Built {
  program: ReturnType<typeof compilePlan>['program'];
  grid: VoxelGrid;
  paletteColors: Uint8Array;
  paletteFlags: Uint8Array;
  blockCount: number;
  messages: string[];
}

/**
 * Compile and expand, never throwing.
 *
 * A half-drawn plan is the normal state of a plan, and the expander is entitled to complain
 * about geometry that does not fit. Turning any of that into a blank page would make the tool
 * feel broken at exactly the moment the user is mid-thought, so problems come back as messages
 * beside a build that is still on screen.
 */
function buildFrom(plan: LayoutPlan): Built {
  const compiled = compilePlan(plan);
  try {
    const result = expand(compiled.program);
    return {
      program: compiled.program,
      grid: result.grid,
      paletteColors: paletteColors(result.grid.palette),
      paletteFlags: paletteFlags(result.grid.palette),
      blockCount: result.blockCount,
      messages: [
        ...compiled.warnings,
        ...result.errors.map((issue) => `${issue.path}: ${issue.message}`),
        ...result.warnings.map((issue) => `${issue.path}: ${issue.message}`),
      ],
    };
  } catch (error) {
    return {
      program: compiled.program,
      grid: EMPTY_GRID,
      paletteColors: paletteColors(EMPTY_GRID.palette),
      paletteFlags: paletteFlags(EMPTY_GRID.palette),
      blockCount: 0,
      messages: [...compiled.warnings, (error as Error).message],
    };
  }
}

/** A value that lags behind by `delay`, so expensive work skips the frames of a drag. */
function useDeferred<T>(value: T, delay: number): T {
  const [deferred, setDeferred] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDeferred(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return deferred;
}

function offset(item: PlanItem, dx: number, dz: number): PlanItem {
  if (item.kind === 'room' || item.kind === 'opening' || item.kind === 'platform') {
    return { ...item, rect: { ...item.rect, x: item.rect.x + dx, z: item.rect.z + dz } };
  }
  return { ...item, x: item.x + dx, z: item.z + dz };
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
