/**
 * One undo stack for the whole project.
 *
 * Each zoom level still stores its own entries — voxel ops, plan snapshots, terrain deltas —
 * because those shapes do not mix. What they did not share was the order. Editing a wall,
 * zooming out to the map and pressing Ctrl+Z undid the map, or nothing, because the key was
 * bound to whichever page was mounted.
 *
 * The journal is only that order. The page that is open applies the entry when it is the one
 * on top. When it is not, the shell zooms to the document that is, and that page applies it
 * once it is mounted. A new edit drops the redo tail here and on every document the tail named.
 */

import { planHistoryFor, editHistoryFor, worldHistoryFor } from './retainHistory.js';

export type ZoomScope = 'build' | 'arch' | 'world';

export interface JournalFrame {
  scope: ZoomScope;
  docId: string;
}

export interface LiveUndo {
  scope: ZoomScope;
  docId: string;
  undo: () => boolean;
  redo: () => boolean;
}

interface Pending {
  frame: JournalFrame;
  action: 'undo' | 'redo';
}

const frames: JournalFrame[] = [];
let cursor = 0;
let live: LiveUndo | null = null;
let pending: Pending | null = null;
let zoomTo: ((frame: JournalFrame, action: 'undo' | 'redo') => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeJournal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function journalCanUndo(): boolean {
  return cursor > 0;
}

export function journalCanRedo(): boolean {
  return cursor < frames.length;
}

function discardFrame(frame: JournalFrame): void {
  if (frame.scope === 'build') editHistoryFor(frame.docId).discardRedo();
  else if (frame.scope === 'arch') planHistoryFor(frame.docId).discardRedo();
  else worldHistoryFor(frame.docId).discardRedo();
}

/** A committed edit on the document that is open. */
export function recordChange(scope: ZoomScope, docId: string): void {
  const dropped = frames.splice(cursor);
  const seen = new Set<string>();
  for (const frame of dropped) {
    const key = `${frame.scope}:${frame.docId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    discardFrame(frame);
  }
  frames.push({ scope, docId });
  cursor = frames.length;
  emit();
}

export function bindZoom(fn: (frame: JournalFrame, action: 'undo' | 'redo') => void): () => void {
  zoomTo = fn;
  return () => {
    if (zoomTo === fn) zoomTo = null;
  };
}

function finish(step: { kind: 'applied' } | { kind: 'zoom'; frame: JournalFrame; action: 'undo' | 'redo' } | { kind: 'empty' }): void {
  if (step.kind === 'zoom') zoomTo?.(step.frame, step.action);
}

export function undoProject(): void {
  finish(requestUndo());
}

export function redoProject(): void {
  finish(requestRedo());
}

export function registerLive(handler: LiveUndo): () => void {
  live = handler;
  return () => {
    if (live === handler) live = null;
  };
}

/**
 * Undo the latest edit in the project.
 *
 * `applied` means the open page did it. `zoom` means the shell should open that document;
 * the page applies the entry when it mounts.
 */
export function requestUndo(): { kind: 'applied' } | { kind: 'zoom'; frame: JournalFrame; action: 'undo' } | { kind: 'empty' } {
  if (cursor === 0) return { kind: 'empty' };
  const frame = frames[cursor - 1]!;
  if (live && live.scope === frame.scope && live.docId === frame.docId) {
    if (!live.undo()) return { kind: 'empty' };
    cursor--;
    emit();
    return { kind: 'applied' };
  }
  pending = { frame, action: 'undo' };
  return { kind: 'zoom', frame, action: 'undo' };
}

export function requestRedo(): { kind: 'applied' } | { kind: 'zoom'; frame: JournalFrame; action: 'redo' } | { kind: 'empty' } {
  if (cursor >= frames.length) return { kind: 'empty' };
  const frame = frames[cursor]!;
  if (live && live.scope === frame.scope && live.docId === frame.docId) {
    if (!live.redo()) return { kind: 'empty' };
    cursor++;
    emit();
    return { kind: 'applied' };
  }
  pending = { frame, action: 'redo' };
  return { kind: 'zoom', frame, action: 'redo' };
}

/** The zoom the shell just performed, once, for the page that matches it. */
export function takePending(scope: ZoomScope, docId: string): 'undo' | 'redo' | null {
  if (!pending || pending.frame.scope !== scope || pending.frame.docId !== docId) return null;
  const action = pending.action;
  pending = null;
  return action;
}

/** The page applied the pending entry. Moves the cursor to match. */
export function confirmPending(action: 'undo' | 'redo'): void {
  if (action === 'undo' && cursor > 0) cursor--;
  else if (action === 'redo' && cursor < frames.length) cursor++;
  emit();
}

/** Test hook. */
export function resetJournal(): void {
  frames.length = 0;
  cursor = 0;
  live = null;
  pending = null;
  emit();
}
