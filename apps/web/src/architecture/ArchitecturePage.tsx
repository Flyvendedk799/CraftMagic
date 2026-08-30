/**
 * Architecture mode.
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
 * model on the right is where you check it — and a finished building is opaque, so the model
 * cuts: the whole thing, one storey with its ceiling off, or one room boxed in and framed.
 * Without those, every room you drew is behind a wall and half the building is behind a floor.
 *
 * **The prompt box refines the drawing — it never replaces it.** The page's premise is still
 * direct manipulation: you draw the plan, and the plan stays the document. But a compiled
 * plan is an ordinary `BuildProgram`, and the server's refine pipeline takes any program —
 * so "add window boxes and a chimney" on top of what you drew is a one-call trip through
 * exactly the machinery the editor uses. The result opens in the editor as a generated
 * build; the plan you drew is untouched and still here.
 *
 * The level editor engine from flyvendedk799/firstpgame is reused throughout — its plan
 * viewport, grid and wall-insert snapping, snapshot history, autosave, kit-driven materials
 * and walkability validation, each ported to TypeScript in the module named in its header.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { expand, paletteColors, paletteFlags, voxelIndex, type BuildPart, type VoxelGrid } from '@craftmagic/core';
import { EditorCanvas, type ViewKind, type ViewRequest } from '../editor/EditorCanvas.js';
import type { VoxelHit } from '../editor/raycast.js';
import { ExportBar } from '../editor/ExportBar.js';
import { Section } from '../editor/Section.js';
import { registerGeneratedBuild } from '../editor/builds.js';
import { PromptPanel } from '../generate/PromptPanel.js';
import { useGeneration, type GenerationResult } from '../generate/useGeneration.js';
import { AccountPanel } from '../library/AccountPanel.js';
import { AppNav } from '../shell/AppNav.js';
import { alignOffsets, distributeOffsets, type Offsets } from './arrange.js';
import { ArrangePanel } from './ArrangePanel.js';
import { compilePlan } from './compile.js';
import { ComponentsPanel } from './ComponentsPanel.js';
import { useComponentLibrary, type Catalogue } from './components.js';
import { FloorStack } from './FloorStack.js';
import { Inspector } from './Inspector.js';
import { IssuesPanel, issueSummary } from './IssuesPanel.js';
import { PlanCanvas, type PlaceChoice } from './PlanCanvas.js';
import { RoomSchedule, scheduleSummary } from './RoomSchedule.js';
import { SitePanel } from './SitePanel.js';
import { getBuild } from '../library/library.js';
import {
  addItem,
  countItems,
  findItem,
  floorHeight,
  normalizePlan,
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
import { MODEL_MODES, modelView, type ModelMode } from './modelView.js';
import { ShortcutHelp } from '../editor/ShortcutHelp.js';
import { ARCHITECTURE_SHORTCUTS, ARCHITECTURE_SHORTCUT_FOOT } from './shortcuts.js';
import '../editor/editor.css';
import './architecture.css';

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

export function ArchitecturePage() {
  const navigate = useNavigate();
  const session = usePlanSession(() => templateById('blank')!.build());
  const { plan } = session;

  const [tool, setTool] = useState<LayoutToolId>('room');
  const [floorIndex, setFloorIndex] = useState(0);
  /**
   * The selection, as a list.
   *
   * Most of the page still wants exactly one item — the inspector's fields, the room cutaway,
   * "send to floor" — and reads `selected` below for it. What a list buys is the other half of
   * drafting: moving a wing of a building without dragging four rooms one at a time, and
   * lining rooms up with each other rather than with a coordinate typed twice.
   */
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const setSelectedId = useCallback(
    (id: string | null, additive = false) => {
      setSelectedIds((current) => {
        if (id === null) return [];
        if (!additive) return [id];
        return current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
      });
    },
    [],
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [showBelow, setShowBelow] = useState(true);
  const [modelMode, setModelMode] = useState<ModelMode>('storey');
  const [view, setView] = useState<ViewRequest | null>(null);
  const [hover, setHover] = useState<{ x: number; z: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  /** The saved build the Place tool will drop. Armed from the Components panel. */
  const [placeChoice, setPlaceChoice] = useState<PlaceChoice | null>(null);
  /** Bumped to ask the plan to re-frame; see `PlanCanvas`'s `fitNonce`. */
  const [fitNonce, setFitNonce] = useState(0);
  /**
   * The item on the clipboard.
   *
   * A plain item rather than a serialized string: the clipboard never leaves the page, and a
   * plan item is already JSON. It survives a storey change and a template load on purpose —
   * copying a bathroom to paste onto the floor above is most of what a clipboard is for here.
   */
  const [clip, setClip] = useState<PlanItem[]>([]);

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
      setSelectedIds([]);
      setFloorIndex(0);
      setNotice(null);
      // After the deferred compile has produced the new grid, so the framing is of the
      // building that was just loaded rather than of the one leaving the screen.
      setTimeout(frame, PREVIEW_DELAY + 60);
    },
    [session, frame],
  );

  // Open a plan saved in the library: `/studio?mode=arch&plan=lib:<row>`. One fetch, then the param
  // is dropped from the URL so a reload afterwards keeps whatever the user has since drawn
  // rather than stamping the library copy back over it.
  const [searchParams, setSearchParams] = useSearchParams();
  const planParam = searchParams.get('plan');
  useEffect(() => {
    if (!planParam?.startsWith('lib:')) return;
    let cancelled = false;
    getBuild(planParam.slice(4))
      .then((detail) => {
        if (cancelled) return;
        if (!detail.plan) {
          setImportError('That library build has no plan saved with it — only its blocks.');
          return;
        }
        load(normalizePlan(detail.plan));
        setImportError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setImportError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) {
          // Drop only our own param. The studio shell keeps its mode in the same query, and
          // wiping it would flip the page out of Plan mode the moment a plan finished loading.
          setSearchParams(
            (params) => {
              params.delete('plan');
              return params;
            },
            { replace: true },
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [planParam, load, setSearchParams]);

  // A plan that lost a storey — an undo, a delete, an import — must not leave the canvas
  // editing a floor that no longer exists.
  const activeFloor = Math.min(floorIndex, plan.floors.length - 1);
  useEffect(() => {
    if (activeFloor !== floorIndex) setFloorIndex(activeFloor);
  }, [activeFloor, floorIndex]);

  // The library, as a parts bin: the shelf eagerly, each placed build's blocks on demand.
  const library = useComponentLibrary(plan);

  /**
   * True footprints for every placement whose blocks have arrived, by item id.
   *
   * Built here rather than in the canvas because the inspector wants the same answer, and two
   * panels disagreeing about how big a placed building is would be a slow, confusing bug.
   */
  const placeSizes = useMemo(() => {
    const sizes = new Map<string, { w: number; d: number; h: number }>();
    for (const floor of plan.floors) {
      for (const item of floor.items) {
        if (item.kind !== 'place') continue;
        const component = library.catalogue.get(item.buildId);
        if (component) {
          sizes.set(item.id, { w: component.size.x, d: component.size.z, h: component.size.y });
        }
      }
    }
    return sizes;
  }, [plan, library.catalogue]);

  /** How many times each saved build is placed, for the shelf's counts. */
  const placeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const floor of plan.floors) {
      for (const item of floor.items) {
        if (item.kind === 'place') counts.set(item.buildId, (counts.get(item.buildId) ?? 0) + 1);
      }
    }
    return counts;
  }, [plan]);

  const validation = useMemo(() => validatePlan(plan), [plan]);

  const deferred = useDeferred(plan, PREVIEW_DELAY);
  const built = useMemo(() => buildFrom(deferred, library.catalogue), [deferred, library.catalogue]);

  const selectedId = selectedIds.length === 1 ? selectedIds[0]! : null;
  const selected = useMemo(() => findItem(plan, selectedId ?? ''), [plan, selectedId]);

  /** The selected items on the storey being edited. Alignment is a within-storey idea. */
  const selectedItems = useMemo(() => {
    const wanted = new Set(selectedIds);
    return (plan.floors[activeFloor]?.items ?? []).filter((item) => wanted.has(item.id));
  }, [plan, activeFloor, selectedIds]);

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
    (items: PlanItem[]) =>
      session.preview((current) =>
        items.reduce((plan, item) => replaceItem(plan, item.id, item), current),
      ),
    [session],
  );

  /** Apply a map of per-item moves as one undo entry. The align and distribute buttons' verb. */
  const arrange = useCallback(
    (offsets: Offsets, what: string) => {
      if (offsets.size === 0) {
        setNotice(`Nothing to ${what} — those are already there.`);
        return;
      }
      session.commit((current) =>
        [...offsets].reduce(
          (plan, [id, move]) => {
            const found = findItem(plan, id);
            return found ? replaceItem(plan, id, offset(found.item, move.dx, move.dz)) : plan;
          },
          current,
        ),
      );
      setNotice(null);
    },
    [session],
  );

  const remove = useCallback(() => {
    if (selectedIds.length === 0) return;
    session.commit((current) => selectedIds.reduce((plan, id) => removeItem(plan, id), current));
    setSelectedIds([]);
  }, [session, selectedIds]);

  const duplicate = useCallback(() => {
    if (selectedItems.length === 0) return;
    const copies = selectedItems.map((item) =>
      offset({ ...item, id: planId(item.kind) }, 2, 2),
    );
    session.commit((current) => copies.reduce((plan, copy) => addItem(plan, activeFloor, copy), current));
    setSelectedIds(copies.map((copy) => copy.id));
  }, [session, selectedItems, activeFloor]);

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
      if (selectedItems.length === 0) return;
      session.commit((current) =>
        selectedItems.reduce(
          (plan, item) => replaceItem(plan, item.id, offset(item, dx, dz)),
          current,
        ),
      );
    },
    [selectedItems, session],
  );

  /**
   * Turn every selected placed build a quarter clockwise.
   *
   * Only placements: nothing else on a plan has a rotation. A room is a rectangle and turning
   * one would mean resizing it, which is what the resize handles are for; a door already says
   * which way it faces. So this is not a general "rotate the selection" — it is the one
   * transform the one item kind that has an orientation actually has.
   */
  const turn = useCallback(() => {
    const placements = selectedItems.filter((item) => item.kind === 'place');
    if (placements.length === 0) return;
    session.commit((current) =>
      placements.reduce(
        (plan, item) =>
          replaceItem(plan, item.id, {
            ...item,
            turns: (((item.turns + 1) % 4) as 0 | 1 | 2 | 3),
          }),
        current,
      ),
    );
  }, [selectedItems, session]);

  const copy = useCallback(() => {
    if (selectedItems.length === 0) return;
    setClip(selectedItems);
    const what =
      selectedItems.length === 1 ? `the ${selectedItems[0]!.kind}` : `${selectedItems.length} items`;
    setNotice(`Copied ${what}. Ctrl+V drops a copy on the storey you are on.`);
  }, [selectedItems]);

  /**
   * Paste onto the storey being edited, offset by two blocks.
   *
   * Offset rather than in place, and that is not politeness: pasted exactly on top of its
   * original, a copy is invisible, unselectable except by moving the thing above it, and
   * indistinguishable from a paste that silently failed.
   */
  const paste = useCallback(() => {
    if (clip.length === 0) return;
    const copied = clip.map((item) => offset({ ...item, id: planId(item.kind) }, 2, 2));
    session.commit((current) => copied.reduce((plan, item) => addItem(plan, activeFloor, item), current));
    setSelectedIds(copied.map((item) => item.id));
    setNotice(null);
  }, [clip, session, activeFloor]);

  // --- keyboard ----------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntry(event.target)) return;
      // While the sheet is up it is the only thing on screen, so a key that would change the
      // tool behind it is not what anyone meant. Escape is the exception, and the sheet owns it.
      if (help) return;

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
        if (key === 'c') {
          event.preventDefault();
          copy();
          return;
        }
        if (key === 'v') {
          event.preventDefault();
          paste();
          return;
        }
        if (key === 'd') {
          event.preventDefault();
          duplicate();
          return;
        }
        if (key === 'a') {
          // The storey, not the building: every other selection verb here is scoped to the
          // floor being edited, and a selection spanning storeys could not be dragged.
          event.preventDefault();
          setSelectedIds((plan.floors[activeFloor]?.items ?? []).map((item) => item.id));
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
        case 'f':
        case 'F':
          event.preventDefault();
          setFitNonce((nonce) => nonce + 1);
          break;
        // One key that cycles, not three that select. The three modes are a progression from
        // the whole building to one room, so "again" is the only thing anyone means by it.
        case 'v':
        case 'V': {
          event.preventDefault();
          const order = MODEL_MODES.map((entry) => entry.id);
          setModelMode((current) => order[(order.indexOf(current) + 1) % order.length]!);
          break;
        }
        case '?':
          event.preventDefault();
          setHelp(true);
          break;
        case 'Delete':
        case 'Backspace':
          if (selectedIds.length > 0) {
            event.preventDefault();
            remove();
          }
          break;
        case 'r':
        case 'R':
          if (selectedItems.some((item) => item.kind === 'place')) {
            event.preventDefault();
            turn();
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
          if (selectedIds.length > 0) {
            event.preventDefault();
            nudge(-1, 0);
          }
          break;
        case 'ArrowRight':
          if (selectedIds.length > 0) {
            event.preventDefault();
            nudge(1, 0);
          }
          break;
        case 'ArrowUp':
          if (selectedIds.length > 0) {
            event.preventDefault();
            nudge(0, -1);
          }
          break;
        case 'ArrowDown':
          if (selectedIds.length > 0) {
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
  }, [
    session,
    selectedIds,
    remove,
    nudge,
    turn,
    selectedItems,
    copy,
    paste,
    duplicate,
    help,
    plan.floors,
    activeFloor,
    setSelectedId,
  ]);

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

  // A finished AI pass lands in the editor, exactly like the hand-off button: the result is
  // a generated build, not a plan, and the editor is where a generated build lives. The plan
  // here is left untouched — it remains the drawing the refine started from.
  const onGenerated = useCallback(
    (result: GenerationResult) => {
      const id = registerGeneratedBuild(result.program);
      navigate(`/editor?build=${encodeURIComponent(id)}`);
    },
    [navigate],
  );
  const generation = useGeneration(onGenerated);

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

  /**
   * Click a wall in the model, select the item that drew it on the plan.
   *
   * The chain is the compiler's provenance tag run backwards: voxel → part (the expander's
   * `origin` array) → component path → the component's `id`, whose prefix is the plan item's
   * id. Anything without a tag — the ground, a furnishing detail op — falls through silently;
   * a click that selects nothing reads as a miss, which it is.
   */
  const onModelClick = useCallback(
    (hit: VoxelHit) => {
      if (hit.ground || !built.partOf) return;
      const partId = built.partOf[voxelIndex(built.grid.size, hit.x, hit.y, hit.z)];
      if (!partId) return;
      const part = built.parts.find((entry) => entry.id === partId);
      const match = part?.path.match(/^components\[(\d+)\]$/);
      const componentId = match ? built.program.components[Number(match[1])]?.id : undefined;
      const found = componentId ? findItem(plan, componentId.split('.')[0]!) : null;
      if (!found) return;
      setFloorIndex(found.floorIndex);
      setSelectedId(found.item.id);
      setNotice(null);
    },
    [built, plan, setSelectedId],
  );

  // What the model shows, as a cut and a camera framing. Recomputed from the deferred build
  // rather than the live plan so the cut and the geometry it is cutting are the same age — a
  // clip against a grid one keystroke ahead flickers a slab in and out during a drag.
  const shown = useMemo(
    () =>
      modelView({
        plan,
        mode: modelMode,
        floorIndex: activeFloor,
        selected: selected?.floorIndex === activeFloor ? selected.item : null,
        grid: built.grid.size,
        origin: built.origin,
      }),
    [plan, modelMode, activeFloor, selected, built.grid.size, built.origin],
  );

  // Re-frame whenever the thing being framed changes: switching to Room mode, or picking a
  // different room while in it. Keyed on the box rather than on the selection, so selecting
  // the same room twice does not fight the camera the user has since moved.
  const focusKey = shown.focus ? JSON.stringify(shown.focus) : '';
  useEffect(() => {
    if (!focusKey) return;
    setView((prev) => ({ kind: 'iso', nonce: (prev?.nonce ?? 0) + 1, focus: JSON.parse(focusKey) }));
  }, [focusKey]);

  return (
    <div className="arch">
      {/* The same bar the editor wears, for the same reason: this is a full-viewport tool, and
          without it the only way back out is whatever links its own panel happens to carry.
          The bar already lists this page as a destination, so arriving here and losing it was
          the one place the chrome contradicted itself. */}
      <AppNav current="architecture" />

      <section className="hud arch__panel">
        <h1 className="hud__title">Architecture</h1>
        <p className="hud__sub">Rooms, storeys and what goes in them</p>

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

        {/* The `layouter-` section ids are deliberately unchanged. `Section` persists each
            one's open state under `craftmagic.section.<id>`, so renaming them would silently
            reset every panel everyone had arranged, to buy nothing a user can see. */}
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
          {/* The hint and the way to the rest of the keys, on one line. A sheet reachable
              only by pressing `?` is a sheet nobody opens, and `?` is exactly the kind of key
              you have to already know about to try. */}
          <p className="tool-rail__hint">
            {LAYOUT_TOOL_BY_ID[tool].hint}{' '}
            <button type="button" className="tools__inline" onClick={() => setHelp(true)}>
              shortcuts
            </button>
          </p>

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

        <Section
          id="layouter-inspector"
          title="Selection"
          summary={
            selectedIds.length > 1
              ? `${selectedIds.length} items`
              : selected?.item.kind ?? 'none'
          }
        >
          {selectedItems.length > 1 ? (
            <ArrangePanel
              count={selectedItems.length}
              onAlign={(mode) =>
                arrange(
                  alignOffsets(selectedItems, selectedIds, plan.wallThickness, floorHeight(plan, activeFloor), mode),
                  'align',
                )
              }
              onDistribute={(axis) =>
                arrange(
                  distributeOffsets(selectedItems, selectedIds, plan.wallThickness, floorHeight(plan, activeFloor), axis),
                  'space out',
                )
              }
              canDistribute={selectedItems.length > 2}
              onDelete={remove}
              onDuplicate={duplicate}
            />
          ) : (
            <Inspector
              shelf={library.shelf}
              placeSize={
                selected?.item.kind === 'place' ? (placeSizes.get(selected.item.id) ?? null) : null
              }
              plan={plan}
              item={selected?.item ?? null}
              floorIndex={selected?.floorIndex ?? activeFloor}
              onChange={change}
              onDelete={remove}
              onDuplicate={duplicate}
              onSendToFloor={sendToFloor}
            />
          )}
        </Section>

        {/* Between the selection and the building settings: it is a reading of what has been
            drawn, so it belongs after the thing that draws it and before the thing that
            re-skins it. */}
        <Section
          id="layouter-schedule"
          title="Rooms"
          summary={scheduleSummary(plan, activeFloor)}
          defaultOpen={false}
        >
          <RoomSchedule
            plan={plan}
            floorIndex={activeFloor}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </Section>

        {/* Between the rooms you drew and the building-wide settings: a placed build is a
            thing on the plan, not a property of the project. */}
        <Section
          id="layouter-components"
          title="Components"
          summary={library.shelf.length > 0 ? `${library.shelf.length}` : undefined}
          defaultOpen={false}
        >
          <ComponentsPanel
            shelf={library.shelf}
            status={library.status}
            chosen={placeChoice?.id ?? null}
            counts={placeCounts}
            loading={library.loading}
            failed={library.failed}
            onChoose={(entry) => {
              setPlaceChoice({ id: entry.id, name: entry.name, w: entry.w, d: entry.d, h: entry.h });
              // Arming the tool as well: picking a component and then having to find the Place
              // button is a step that exists only because the two live in different panels.
              setTool('place');
              // Fetched now rather than at compile time, so the ghost under the cursor is the
              // building's real footprint before the click rather than after it.
              void library.load(entry.id);
              setNotice(`"${entry.name}" ready — click the plan to place it.`);
            }}
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
          // The drawing rides beside the building it compiles to, so a library save from
          // here can be reopened *as a plan* — walls still walls — not just as blocks.
          plan={plan}
          // Everything Architecture mode compiles is the inside of a building.
          kind="interior"
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

        <Section id="layouter-ai" title="Refine with AI" defaultOpen={false}>
          <PromptPanel
            phase={generation.phase}
            spend={generation.spend}
            estimate={generation.estimate}
            estimating={generation.estimating}
            onEstimate={generation.requestEstimate}
            onGenerate={(instruction, size) => void generation.generate(instruction, undefined, size)}
            onCancel={generation.cancel}
            // The drawn plan, compiled, is the program the model edits. Zero blocks means an
            // empty plan, and refining nothing would silently become "invent something".
            onRefine={
              built.blockCount > 0
                ? (instruction) => void generation.generate(instruction, built.program)
                : null
            }
          />
          <p className="site-panel__hint">
            Sends the compiled building, not the drawing — the result opens in the editor as a
            new build, and the plan here stays exactly as you drew it.
          </p>
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

      <div className="arch__plan">
        <PlanCanvas
          plan={plan}
          floorIndex={activeFloor}
          tool={tool}
          placeChoice={placeChoice}
          placeSizes={placeSizes}
          selectedIds={selectedIds}
          unreachable={validation.unreachable}
          showBelow={showBelow}
          fitNonce={fitNonce}
          onSelect={setSelectedId}
          onSelectMany={setSelectedIds}
          onBeginGesture={session.mark}
          onCreate={create}
          onPreview={previewChange}
          onNotice={setNotice}
          onHover={setHover}
        />

        <aside className="hover-readout arch__readout">
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

      <div className="arch__model">
        <EditorCanvas
          grid={built.grid}
          paletteColors={built.paletteColors}
          paletteFlags={built.paletteFlags}
          clip={shown.clip}
          view={view}
          onClick={onModelClick}
        />

        {/* Says which storey you are looking at, because every mode but Whole shows one and
            the plan beside it is the only other thing that knows which. */}
        <p className="model-caption">
          {modelMode === 'whole' ? (
            <>Whole building · {plan.floors.length} storey{plan.floors.length === 1 ? '' : 's'}</>
          ) : shown.fallback ? (
            <em>{shown.fallback}</em>
          ) : modelMode === 'room' && selected?.item.kind === 'room' ? (
            <>{selected.item.label.trim() || 'Room'} · {plan.floors[activeFloor]?.name}</>
          ) : (
            <>{plan.floors[activeFloor]?.name} · ceiling off</>
          )}
        </p>

        <div className="arch__model-bar">
          {/* Three ways to look at the same building, not a checkbox: "cut at this storey"
              only ever answered one of the three questions people actually have, and the two
              it did not answer are the ones a plan with more than one room raises. */}
          <span className="model-modes" role="group" aria-label="How much of the building to show">
            {MODEL_MODES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={modelMode === entry.id}
                title={entry.hint}
                onClick={() => setModelMode(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </span>
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

      {help && (
        <ShortcutHelp
          groups={ARCHITECTURE_SHORTCUTS}
          foot={ARCHITECTURE_SHORTCUT_FOOT}
          onClose={() => setHelp(false)}
        />
      )}
    </div>
  );
}

interface Built {
  program: ReturnType<typeof compilePlan>['program'];
  /**
   * Plan coordinate of the grid's (0,0).
   *
   * The compiler crops the build to what is drawn plus an eave, so a room at plan x=30 can be
   * at grid x=2. Anything that talks about the model in plan terms — the clip box, the camera
   * focus — has to subtract this first, and forgetting to is silent: you get a clip box over
   * empty air and a viewport that renders nothing.
   */
  origin: { x: number; z: number };
  grid: VoxelGrid;
  paletteColors: Uint8Array;
  paletteFlags: Uint8Array;
  blockCount: number;
  messages: string[];
  /** Per-voxel part id from the provenance expansion, for click-to-select. Null on failure. */
  partOf: Uint16Array | null;
  parts: BuildPart[];
}

/**
 * Compile and expand, never throwing.
 *
 * A half-drawn plan is the normal state of a plan, and the expander is entitled to complain
 * about geometry that does not fit. Turning any of that into a blank page would make the tool
 * feel broken at exactly the moment the user is mid-thought, so problems come back as messages
 * beside a build that is still on screen.
 */
function buildFrom(plan: LayoutPlan, catalogue: Catalogue): Built {
  const compiled = compilePlan(plan, catalogue);
  try {
    // Provenance costs one extra array per compile, and compiles are already deferred behind
    // the drag — it is what lets a click on the model land back on the plan item that drew it.
    const result = expand(compiled.program, { provenance: true });
    return {
      program: compiled.program,
      origin: compiled.origin,
      grid: result.grid,
      paletteColors: paletteColors(result.grid.palette),
      paletteFlags: paletteFlags(result.grid.palette),
      blockCount: result.blockCount,
      messages: [
        ...compiled.warnings,
        ...result.errors.map((issue) => `${issue.path}: ${issue.message}`),
        ...result.warnings.map((issue) => `${issue.path}: ${issue.message}`),
      ],
      partOf: result.origin,
      parts: result.parts,
    };
  } catch (error) {
    return {
      program: compiled.program,
      origin: compiled.origin,
      grid: EMPTY_GRID,
      paletteColors: paletteColors(EMPTY_GRID.palette),
      paletteFlags: paletteFlags(EMPTY_GRID.palette),
      blockCount: 0,
      messages: [...compiled.warnings, (error as Error).message],
      partOf: null,
      parts: [],
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
