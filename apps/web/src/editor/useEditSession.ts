/**
 * The editing session: everything that sits between a pure tool and the mesh manager.
 *
 * A build is normally a *derived* value — change a param, re-run `expand()`, get a fresh
 * grid — and that is the whole point of the IR. Manual edits used to break the derivation:
 * the first changed voxel marked the session **detached**, and everything that re-expanded
 * had to ask permission to destroy the user's work.
 *
 * That conflict is dissolved now. Edits are recorded in an `EditOverlay` — a sparse layer of
 * (position, block) entries over the expansion, keyed by canonical block refs rather than
 * palette indices — and when the build re-expands (a param, the scale, a restyle, an AI
 * refine), the fresh grid is composited with the overlay during the same render. The program
 * stays live, the sliders stay live, refine stays live, and the edits stay put at the
 * absolute coordinates they were made at. Entries a resize pushes outside the bounds are
 * kept and reported (`outside`), not dropped: scale back up and they return.
 *
 * The pre-edit voxels are still kept — 2 bytes per cell, captured before the first composite
 * or edit — so `discard()` remains instant, and so undoing an edit can tell "back to the
 * program's own block" (entry deleted) from "changed to something else" (entry kept).
 *
 * Edits persist per build id via `builds.ts`: in memory for every build, and through
 * localStorage for generated ones — a refresh no longer silently eats an hour of detailing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EditOverlay,
  paletteColors,
  paletteFlags,
  type BlockRef,
  type EditLayer,
  type EditOp,
  type VoxelGrid,
} from '@craftmagic/core';
import { editsOf, rememberEdits, type LoadedBuild } from './builds.js';
import type { VoxelWorld } from './VoxelWorld.js';
import { EditHistory } from './history.js';
import { blockDelta } from './tools/op.js';
import { resolvePaletteIndex } from './tools/palette.js';

export interface EditSession {
  /** The live grid. Same object as `build.grid` — edits write through it. */
  grid: VoxelGrid;
  /** Regenerated whenever the palette grows, which is what re-loads the mesher. */
  paletteColors: Uint8Array;
  paletteFlags: Uint8Array;

  /** Non-air blocks, tracked through edits rather than rescanned. */
  blockCount: number;
  /** Hand-edited cells currently in the overlay — not an op count. */
  edits: number;
  /** Edits whose coordinates fall outside the current size. Shown, never dropped. */
  outside: number;
  /**
   * True when the grid on screen differs from what the program alone would produce.
   *
   * The name survives from the era when this was a point of no return. It no longer is —
   * re-expansion keeps the edits — but exports still need to know that the program JSON
   * describes the building *without* them.
   */
  detached: boolean;
  canUndo: boolean;
  canRedo: boolean;

  /** Apply an op and record it in the overlay. Null ops are ignored. */
  apply: (op: EditOp | null) => void;
  undo: () => void;
  redo: () => void;
  /** Remove every hand edit: restore the pristine expansion and clear the overlay. */
  discard: () => void;
  /** Palette slot for a block, appending one if needed. -1 when the palette is full. */
  resolveBlock: (block: BlockRef) => number;
  /** Handed to `EditorCanvas`; the mesh manager applies and reverts ops. */
  attachWorld: (world: VoxelWorld | null) => void;
  /**
   * The edit layer in its storage form, or null when there are no edits.
   *
   * A function rather than a value: serialising on every render would tax the pointer-move
   * path, and the one consumer — saving to the library — wants it exactly once, on click.
   */
  exportEdits: () => EditLayer | null;
}

interface SessionState {
  /** Identity of the expansion this state belongs to — a new one resets everything. */
  build: LoadedBuild;
  paletteColors: Uint8Array;
  paletteFlags: Uint8Array;
  blockCount: number;
  edits: number;
  outside: number;
  canUndo: boolean;
  canRedo: boolean;
}

/** How long after the last edit the overlay is persisted. Same rhythm as the layouter. */
const PERSIST_DELAY = 500;

export function useEditSession(build: LoadedBuild): EditSession {
  const historyRef = useRef<EditHistory | null>(null);
  // Lazy rather than `useRef(new EditHistory())`, which would allocate one on every render
  // — and the editor re-renders on every pointer move.
  const history = (historyRef.current ??= new EditHistory());

  const worldRef = useRef<VoxelWorld | null>(null);
  /** Voxels as expanded — before the overlay, before any edit. What discard restores. */
  const baselineRef = useRef<{ voxels: Uint16Array; paletteLength: number } | null>(null);
  const overlayRef = useRef<EditOverlay | null>(null);
  const lastIdRef = useRef<string | null>(null);
  /**
   * Which grid the overlay was last composited into, and what that did.
   *
   * `stateFor` runs during render, and StrictMode runs renders twice in development: an
   * unguarded composite would capture an already-composited grid as the baseline and count
   * its delta twice. Keying on grid identity makes the whole thing idempotent per expansion.
   */
  const compositedRef = useRef<{ grid: VoxelGrid; delta: number; outside: number } | null>(null);

  /**
   * Fresh state for a new expansion, compositing any surviving overlay onto it.
   *
   * Runs during render (in the initializer and in the reset branch below), which is exactly
   * where it must run: an effect would let one frame paint the un-composited grid, and the
   * user's edits blinking out for a frame on every slider tick reads as data loss.
   */
  const stateFor = (next: LoadedBuild): SessionState => {
    if (lastIdRef.current !== next.id) {
      lastIdRef.current = next.id;
      overlayRef.current = EditOverlay.fromJSON(editsOf(next.id));
    }
    const overlay = (overlayRef.current ??= new EditOverlay());

    if (overlay.size > 0 && compositedRef.current?.grid !== next.grid) {
      baselineRef.current = {
        voxels: next.grid.voxels.slice(),
        paletteLength: next.grid.palette.length,
      };
      const result = overlay.composite(next.grid);
      compositedRef.current = { grid: next.grid, delta: result.delta, outside: result.outside };
      if (result.paletteGrew) {
        // The palette grew in place; the derived tables must be rebuilt to match.
        next.paletteColors = paletteColors(next.grid.palette);
        next.paletteFlags = paletteFlags(next.grid.palette);
      }
    }
    const composited = compositedRef.current?.grid === next.grid ? compositedRef.current : null;

    return {
      build: next,
      paletteColors: next.paletteColors,
      paletteFlags: next.paletteFlags,
      blockCount: next.blockCount + (composited?.delta ?? 0),
      edits: overlay.size,
      outside: composited?.outside ?? 0,
      canUndo: false,
      canRedo: false,
    };
  };

  const [state, setState] = useState<SessionState>(() => stateFor(build));

  // Reset during render rather than in an effect — see `stateFor`. React re-runs the
  // component immediately, so nothing downstream sees the stale state.
  if (state.build !== build) {
    history.clear();
    baselineRef.current = null;
    setState(stateFor(build));
  }

  const grid = build.grid;
  const overlay = (overlayRef.current ??= new EditOverlay());

  const attachWorld = useCallback((world: VoxelWorld | null) => {
    worldRef.current = world;
  }, []);

  const ensureBaseline = useCallback(() => {
    if (baselineRef.current) return;
    baselineRef.current = { voxels: grid.voxels.slice(), paletteLength: grid.palette.length };
  }, [grid]);

  // Persist the overlay a beat after the last change. Debounced because a stroke is dozens
  // of state updates, and serialising the layer on each would jank the very gesture it is
  // trying to protect.
  useEffect(() => {
    const timer = setTimeout(() => {
      rememberEdits(build.id, overlay.size > 0 ? overlay.toJSON() : null);
    }, PERSIST_DELAY);
    return () => clearTimeout(timer);
  }, [state.edits, build.id, overlay]);

  // And flush on the way out — a build switch inside the debounce window must not eat the
  // last stroke. The overlay is captured when the effect runs (after the first render for
  // this id), not read from the ref at cleanup, when it already belongs to the next build.
  useEffect(() => {
    const id = build.id;
    const captured = overlayRef.current;
    return () => {
      if (captured) rememberEdits(id, captured.size > 0 ? captured.toJSON() : null);
    };
  }, [build.id]);

  const apply = useCallback(
    (op: EditOp | null) => {
      if (!op) return;
      const world = worldRef.current;
      // The world owns the write-through to `grid.voxels` as well as the dirty chunks, so
      // applying without it would leave the history describing changes that never happened.
      if (!world) return;

      ensureBaseline();
      world.applyEdit(op);
      history.push(op);
      overlay.recordOp(grid, op, baselineRef.current?.voxels);

      const delta = blockDelta(op);
      setState((prev) => ({
        ...prev,
        blockCount: prev.blockCount + delta,
        edits: overlay.size,
        canUndo: true,
        canRedo: false,
      }));
    },
    [ensureBaseline, history, overlay, grid],
  );

  // Undo does not shrink the palette. A slot the undone edit was the last user of stays
  // behind, costing four bytes in the mesher's tables and one entry in an exported
  // schematic — both harmless, and cheaper than the alternative, which is renumbering every
  // voxel above the removed slot and invalidating every op still on the stack.
  const undo = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    const op = history.undo();
    if (!op) return;

    world.revertEdit(op);
    overlay.recordRevert(grid, op, baselineRef.current?.voxels);
    const delta = blockDelta(op);
    setState((prev) => ({
      ...prev,
      blockCount: prev.blockCount - delta,
      edits: overlay.size,
      canUndo: history.canUndo,
      canRedo: true,
    }));
  }, [history, overlay, grid]);

  const redo = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    const op = history.redo();
    if (!op) return;

    world.applyEdit(op);
    overlay.recordOp(grid, op, baselineRef.current?.voxels);
    const delta = blockDelta(op);
    setState((prev) => ({
      ...prev,
      blockCount: prev.blockCount + delta,
      edits: overlay.size,
      canUndo: true,
      canRedo: history.canRedo,
    }));
  }, [history, overlay, grid]);

  const discard = useCallback(() => {
    const baseline = baselineRef.current;
    if (!baseline) return;

    grid.voxels.set(baseline.voxels);
    // Slots appended by the block picker are dropped too, or the palette would keep growing
    // across every discard and the mesher would carry colours nothing references.
    grid.palette.length = baseline.paletteLength;
    baselineRef.current = null;
    history.clear();
    overlay.clear();
    rememberEdits(build.id, null);

    const colors = paletteColors(grid.palette);
    const flags = paletteFlags(grid.palette);
    // A wholesale restore is the one case that really does need every chunk re-meshed, and
    // the world is reloaded explicitly rather than by changing a prop identity — the canvas
    // no longer watches the palette arrays, precisely so growth does not reload.
    worldRef.current?.load(grid, colors, flags);

    setState((prev) => ({
      ...prev,
      paletteColors: colors,
      paletteFlags: flags,
      blockCount: build.blockCount,
      edits: 0,
      outside: 0,
      canUndo: false,
      canRedo: false,
    }));
  }, [build, grid, history, overlay]);

  const resolveBlock = useCallback(
    (block: BlockRef) => {
      const { index, grew } = resolvePaletteIndex(grid, block);
      if (!grew) return index;

      const colors = paletteColors(grid.palette);
      const flags = paletteFlags(grid.palette);
      // Pushed into the world synchronously, before the caller builds the op that uses this
      // slot. Going through React state instead would land the wider table an effect later,
      // and the worker could mesh the new voxel against a colour table one entry short.
      worldRef.current?.setPalette(colors, flags);
      setState((prev) => ({ ...prev, paletteColors: colors, paletteFlags: flags }));
      return index;
    },
    [grid],
  );

  // Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z, on the window so they work wherever the pointer is.
  // Skipped while a text field has focus: the generation prompt is a textarea on this same
  // page, and stealing undo inside it would be worse than not having the shortcut at all.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (isTextEntry(event.target)) return;

      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === 'y') {
        // Windows convention, and free to support.
        event.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  const exportEdits = useCallback(
    () => (overlay.size > 0 ? overlay.toJSON() : null),
    [overlay],
  );

  return {
    grid,
    paletteColors: state.paletteColors,
    paletteFlags: state.paletteFlags,
    blockCount: state.blockCount,
    edits: state.edits,
    outside: state.outside,
    detached: state.edits > 0,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    apply,
    undo,
    redo,
    discard,
    resolveBlock,
    attachWorld,
    exportEdits,
  };
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
