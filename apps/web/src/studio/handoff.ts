/**
 * The verbs that carry a build from one part of the product to another, as URLs.
 *
 * Every mode reads its state from the query string, so a handoff is a link — and until this
 * file existed each page wrote its own: the dashboard, the library and the editor all spelled
 * `?build=lib:<id>` by hand, the guide link was assembled in two places, and World mode had no
 * way in at all except the mode pill. Three copies of a URL convention is how one of them ends
 * up `/editor?…` while the studio has moved on.
 *
 * Two rules:
 *
 *   * **Handoffs carry identity.** A `lib:` id is durable — it survives a reload, a new device,
 *     and being pasted to someone else. A `gen:` id is a bridge that lives in one browser's
 *     localStorage, and a link built from one should say so where it can (see `isDurable`).
 *   * **Only the studio's real parameters.** `mode`, `build`, `plan`, `world`, `place` — the
 *     ones `StudioPage` and its modes read. Nothing here mints a new convention.
 */

import { libraryBuildId, isLibraryId } from '../editor/builds.js';
import { modeParam, type StudioMode } from './mode.js';

/** Any id the editor can open: `lib:<row>`, `gen:<n>`, `schem:<n>`, `img:<n>` or a sample. */
export type BuildRef = string;

/** A library row id, with or without the `lib:` prefix, normalised to the prefixed form. */
export function libRef(rowId: string): BuildRef {
  return isLibraryId(rowId) ? rowId : libraryBuildId(rowId);
}

/** The bare row id behind a `lib:` ref, or null for anything that is not one. */
export function libRowId(ref: BuildRef): string | null {
  return isLibraryId(ref) ? ref.slice('lib:'.length) : null;
}

/** True when the link will still resolve on another device tomorrow. */
export function isDurable(ref: BuildRef): boolean {
  return isLibraryId(ref);
}

function studio(mode: StudioMode, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  const value = modeParam(mode);
  if (value !== null) search.set('mode', value);
  for (const [key, entry] of Object.entries(params)) {
    if (entry !== null && entry !== undefined && entry !== '') search.set(key, entry);
  }
  const query = search.toString();
  return `/studio${query ? `?${query}` : ''}`;
}

/** Open a build in Build mode. */
export function openInBuild(ref: BuildRef): string {
  return studio('build', { build: ref });
}

/** Open a saved plan in Architecture. Only library rows carry a plan the server can return. */
export function openPlan(rowId: string): string {
  return studio('arch', { plan: libRef(rowId) });
}

/** A fresh floorplan. */
export function drawFloorplan(): string {
  return studio('arch', {});
}

/**
 * World mode with a saved build armed in the Place tool.
 *
 * Takes the bare row id — the World shelf is keyed by library row, not by editor ref — and
 * optionally the map to open first. Without a map the draft opens, which is what "put this on
 * a map" means to someone who has not made one yet.
 */
export function placeOnMap(rowId: string, worldId?: string | null): string {
  return studio('world', { world: worldId ?? null, place: libRowId(rowId) ?? rowId });
}

/** Open a named map in World mode. */
export function openMap(worldId: string): string {
  return studio('world', { world: worldId });
}

/** World mode on whatever draft is in this browser. */
export function composeMap(): string {
  return studio('world', {});
}

/**
 * The printable guide for a build, at the settings it is currently shown at.
 *
 * `settings` is the editor's own query (`p.*`, `s.*`, `style`), carried across so the guide
 * prints the build on screen rather than the program's defaults. Callers with no view pass
 * nothing.
 */
export function openGuide(ref: BuildRef, settings?: URLSearchParams): string {
  const search = new URLSearchParams();
  search.set('build', ref);
  if (settings) {
    for (const [key, value] of settings.entries()) {
      if (key.startsWith('p.') || key.startsWith('s.') || key === 'style') search.set(key, value);
    }
  }
  return `/guide?${search.toString()}`;
}
