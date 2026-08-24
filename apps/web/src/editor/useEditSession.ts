/**
 * The editing session: everything that sits between a pure tool and the mesh manager.
 *
 * A build is normally a *derived* value — change a param, re-run `expand()`, get a fresh
 * grid — and that is the whole point of the IR. Manual edits break the derivation: once a
 * voxel has been changed by hand there is no program that produces the grid on screen, so
 * re-expanding would silently throw the edits away. This hook is where that tension is
 * managed rather than hidden. The first edit marks the session **detached**; from then on
 * the caller is expected to ask before doing anything that re-expands, and `discard()`
 * exists so "put it back" is a real answer rather than a reload.
 *
 * The pre-edit voxels are kept for exactly that reason. 2 bytes per cell, taken once on the
 * first edit — 21 MB at the largest legal size, in exchange for never having to tell someone
 * their edits are gone.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  paletteColors,
  paletteFlags,
  type BlockRef,
  type EditOp,
  type VoxelGrid,
} from '@imaginecraft/core';
import type { LoadedBuild } from './builds.js';
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
  /** Applied edits, unaffected by history eviction. */
  edits: number;
  /** True once anything has been edited by hand: the grid no longer matches the program. */
  detached: boolean;
  canUndo: boolean;
  canRedo: boolean;

  /** Apply an op, record it, and mark the session detached. Null ops are ignored. */
  apply: (op: EditOp | null) => void;
  undo: () => void;
  redo: () => void;
  /** Restore the freshly expanded grid and clear the history. */
  discard: () => void;
  /** Palette slot for a block, appending one if needed. -1 when the palette is full. */
  resolveBlock: (block: BlockRef) => number;
  /** Handed to `EditorCanvas`; the mesh manager applies and reverts ops. */
  attachWorld: (world: VoxelWorld | null) => void;
}

interface SessionState {
  /** Identity of the expansion this state belongs to — a new one resets everything. */
  build: LoadedBuild;
  paletteColors: Uint8Array;
  paletteFlags: Uint8Array;
  blockCount: number;
  edits: number;
  detached: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

function freshState(build: LoadedBuild): SessionState {
  return {
    build,
    paletteColors: build.paletteColors,
    paletteFlags: build.paletteFlags,
    blockCount: build.blockCount,
    edits: 0,
    detached: false,
    canUndo: false,
    canRedo: false,
  };
}

export function useEditSession(build: LoadedBuild): EditSession {
  const historyRef = useRef<EditHistory | null>(null);
  // Lazy rather than `useRef(new EditHistory())`, which would allocate one on every render
  // — and the editor re-renders on every pointer move.
  const history = (historyRef.current ??= new EditHistory());

  const worldRef = useRef<VoxelWorld | null>(null);
  /** Voxels as expanded, captured lazily on the first edit. */
  const baselineRef = useRef<{ voxels: Uint16Array; paletteLength: number } | null>(null);

  const [state, setState] = useState<SessionState>(() => freshState(build));

  // Reset during render rather than in an effect: an effect would let one frame paint with
  // the previous build's edit count and undo buttons attached to a grid that no longer
  // exists. React re-runs this component immediately, so nothing downstream sees the stale
  // state.
  if (state.build !== build) {
    history.clear();
    baselineRef.current = null;
    setState(freshState(build));
  }

  const grid = build.grid;

  const attachWorld = useCallback((world: VoxelWorld | null) => {
    worldRef.current = world;
  }, []);

  const ensureBaseline = useCallback(() => {
    if (baselineRef.current) return;
    baselineRef.current = { voxels: grid.voxels.slice(), paletteLength: grid.palette.length };
  }, [grid]);

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

      const delta = blockDelta(op);
      setState((prev) => ({
        ...prev,
        blockCount: prev.blockCount + delta,
        edits: prev.edits + 1,
        detached: true,
        canUndo: true,
        canRedo: false,
      }));
    },
    [ensureBaseline, history],
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
    const delta = blockDelta(op);
    setState((prev) => ({
      ...prev,
      blockCount: prev.blockCount - delta,
      edits: Math.max(0, prev.edits - 1),
      canUndo: history.canUndo,
      canRedo: true,
    }));
  }, [history]);

  const redo = useCallback(() => {
    const world = worldRef.current;
    if (!world) return;
    const op = history.redo();
    if (!op) return;

    world.applyEdit(op);
    const delta = blockDelta(op);
    setState((prev) => ({
      ...prev,
      blockCount: prev.blockCount + delta,
      edits: prev.edits + 1,
      detached: true,
      canUndo: true,
      canRedo: history.canRedo,
    }));
  }, [history]);

  const discard = useCallback(() => {
    const baseline = baselineRef.current;
    if (!baseline) return;

    grid.voxels.set(baseline.voxels);
    // Slots appended by the block picker are dropped too, or the palette would keep growing
    // across every discard and the mesher would carry colours nothing references.
    grid.palette.length = baseline.paletteLength;
    baselineRef.current = null;
    history.clear();

    const colors = paletteColors(grid.palette);
    const flags = paletteFlags(grid.palette);
    // A wholesale restore is the one case that really does need every chunk re-meshed, and
    // the world is reloaded explicitly rather than by changing a prop identity — the canvas
    // no longer watches the palette arrays, precisely so growth does not reload.
    worldRef.current?.load(grid, colors, flags);

    setState({ ...freshState(build), paletteColors: colors, paletteFlags: flags });
  }, [build, grid, history]);

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

  return {
    grid,
    paletteColors: state.paletteColors,
    paletteFlags: state.paletteFlags,
    blockCount: state.blockCount,
    edits: state.edits,
    detached: state.detached,
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    apply,
    undo,
    redo,
    discard,
    resolveBlock,
    attachWorld,
  };
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
