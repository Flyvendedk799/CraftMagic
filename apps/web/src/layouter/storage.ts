/**
 * Where a plan lives between visits.
 *
 * The level editor engine this is ported from keeps an autosave key and a store of named map
 * packs in localStorage (`CUSTOM_MAP_AUTOSAVE_KEY` / `CUSTOM_MAP_PACK_STORE` in its
 * `schema.js`, read and written by `customMapStore.js`), and both halves earn their place for
 * the same reasons here.
 *
 * **Autosave** because a floorplan is an hour of work that exists nowhere else. The voxel
 * editor can afford to lose an edit — the program it was expanded from is still on the server
 * or in the URL — but a plan is only ever in this browser until someone exports it, and a
 * refresh that emptied the canvas would be unforgivable.
 *
 * **Named saves** because one autosave slot means starting a second building destroys the
 * first. They are deliberately separate from the account library: the library stores finished
 * *builds*, and a plan is the thing you are still working on.
 *
 * Every read goes through `normalizePlan`, so a corrupt entry, a plan from a future version or
 * one hand-edited in devtools costs at most that entry.
 */

import { normalizePlan, type LayoutPlan } from './plan.js';

const AUTOSAVE_KEY = 'craftmagic.layouter.autosave';
const SAVED_KEY = 'craftmagic.layouter.plans';

/** Enough for a real project's worth of buildings, small enough not to fill the quota. */
export const MAX_SAVED = 24;

export interface SavedPlan {
  id: string;
  name: string;
  updatedAt: string;
  plan: LayoutPlan;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Quota full or storage blocked. The plan still works for this page view, and the caller
    // reports it rather than pretending the save happened.
    return false;
  }
}

export function loadAutosave(): LayoutPlan | null {
  const raw = read<unknown>(AUTOSAVE_KEY);
  return raw ? normalizePlan(raw) : null;
}

export function saveAutosave(plan: LayoutPlan): boolean {
  return write(AUTOSAVE_KEY, plan);
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // Nothing to do — the next autosave overwrites it anyway.
  }
}

/** Named plans, newest first. */
export function listSaved(): SavedPlan[] {
  const rows = read<unknown[]>(SAVED_KEY);
  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => {
      const entry = (row ?? {}) as Partial<SavedPlan>;
      if (!entry.plan) return null;
      const plan = normalizePlan(entry.plan);
      return {
        id: typeof entry.id === 'string' && entry.id ? entry.id : plan.id,
        name: plan.name,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : plan.updatedAt,
        plan,
      } satisfies SavedPlan;
    })
    .filter((entry): entry is SavedPlan => entry !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Save under the plan's own id, replacing any earlier save of the same plan.
 *
 * Keyed on the id rather than the name so renaming a building updates its save instead of
 * leaving a stale copy behind under the old name — which is the failure mode of every "save
 * as" that keys on a title.
 */
export function savePlan(plan: LayoutPlan): SavedPlan[] {
  const stamped: LayoutPlan = { ...plan, updatedAt: new Date().toISOString() };
  const rest = listSaved().filter((entry) => entry.id !== stamped.id);
  const next = [
    { id: stamped.id, name: stamped.name, updatedAt: stamped.updatedAt, plan: stamped },
    ...rest,
  ].slice(0, MAX_SAVED);
  write(SAVED_KEY, next);
  return next;
}

export function deleteSaved(id: string): SavedPlan[] {
  const next = listSaved().filter((entry) => entry.id !== id);
  write(SAVED_KEY, next);
  return next;
}

/**
 * A plan as a file.
 *
 * Separate from the `.schem` and program-JSON exports on purpose: those are the *building*,
 * and this is the drawing it came from. Someone handed a `.layout.json` can open it here and
 * carry on editing; someone handed a `.schem` has a finished object.
 */
export function planFilename(plan: LayoutPlan): string {
  const slug =
    plan.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'layout';
  return `${slug}.layout.json`;
}

export function downloadPlan(plan: LayoutPlan): { filename: string; bytes: number } {
  const json = JSON.stringify(plan, null, 2);
  const filename = planFilename(plan);

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next task rather than immediately: some browsers cancel the download if
  // the URL dies in the same tick.
  setTimeout(() => URL.revokeObjectURL(url), 0);

  return { filename, bytes: new TextEncoder().encode(json).length };
}

/** Parse an imported file. Throws with a message worth showing when it is not a plan. */
export function parsePlanFile(text: string): LayoutPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not JSON.');
  }
  const candidate = raw as Partial<LayoutPlan>;
  if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.floors)) {
    throw new Error('That JSON is not a layout — it has no floors.');
  }
  return normalizePlan(raw);
}
