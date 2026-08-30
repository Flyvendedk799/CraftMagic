/**
 * Undo/redo for the plan.
 *
 * Snapshots, not operations — the opposite choice from the voxel editor's `EditHistory`, and
 * for the opposite reason. A voxel edit can touch a hundred thousand cells, so it is stored as
 * the cells it changed. A plan is a few kilobytes of JSON no matter how much of it changed, so
 * storing the whole document is cheaper than describing the difference, and it makes every
 * mutation undoable without each one having to define its own inverse. This is what
 * `saveHistory`/`restoreFrom` do in the level editor engine this is ported from, and the
 * reasoning there is the same.
 *
 * Snapshots are taken *before* a change, which is what makes the first undo land on the state
 * the user was looking at rather than one step further back.
 */

import { cloneJson, type LayoutPlan } from './plan.js';

/**
 * Deep enough that nobody hits the end of it in a session, bounded so a long one cannot grow
 * without limit. Forty plans is well under a megabyte.
 */
export const HISTORY_DEPTH = 40;

export class PlanHistory {
  private readonly past: LayoutPlan[] = [];
  private readonly future: LayoutPlan[] = [];

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get depth(): number {
    return this.past.length;
  }

  /** Record the state a change is about to replace. Clears the redo stack, as a new edit must. */
  push(plan: LayoutPlan): void {
    this.past.push(cloneJson(plan));
    if (this.past.length > HISTORY_DEPTH) this.past.shift();
    this.future.length = 0;
  }

  /** The state to go back to, given the one on screen. Null when there is nothing to undo. */
  undo(current: LayoutPlan): LayoutPlan | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(cloneJson(current));
    return previous;
  }

  redo(current: LayoutPlan): LayoutPlan | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(cloneJson(current));
    return next;
  }

  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
  }
}
