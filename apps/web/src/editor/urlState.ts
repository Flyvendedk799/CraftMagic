/**
 * The query-string convention for "which build, at what settings".
 *
 * Shared rather than duplicated because the editor and the build guide have to agree on it
 * exactly: the guide is reached by a link from the editor and is supposed to print the build
 * that was on screen. When the two drifted apart, `?p.floors=2` opened a one-floor guide and
 * a resized build printed at its original size — the link looked right and the page was wrong.
 */

import { NO_SCALE, type ScalePercent } from './builds.js';

/** Namespaced so a param can never collide with `build` or `layer`. */
export const PARAM_PREFIX = 'p.';

/** Scale lives in the URL too, so a resized build is shareable and survives a reload. */
export const SCALE_PREFIX = 's.';

/**
 * The style pack applied over the build's own palette, by id. Absent means the program's
 * own materials. In the URL for the same reason scale is: a restyled build is a different
 * *look* at the same program, and a look worth sharing needs a link that reproduces it.
 */
export const STYLE_PARAM = 'style';

/** Slider bounds, in percent. Below a quarter a small build loses its features entirely. */
export const SCALE_MIN = 25;
export const SCALE_MAX = 400;

/**
 * The scale as a single string, so a memo can depend on it.
 *
 * A `URLSearchParams` is a fresh object on every render and an object literal is a new
 * identity every time; re-expanding and re-meshing a build is not something to do 60 times a
 * second because a dependency looked new.
 */
export function scaleKey(params: URLSearchParams): string {
  return (['x', 'y', 'z'] as const).map((axis) => params.get(SCALE_PREFIX + axis) ?? '100').join('/');
}

/**
 * Scale percentages from a `scaleKey`, clamped to the slider's own range.
 *
 * Clamped rather than trusted: `?s.x=100000` would otherwise ask the expander for a build
 * larger than the engine allows, and a hand-edited or stale link should degrade to something
 * sensible rather than to an error page.
 */
export function parseScale(key: string): ScalePercent {
  const [x, y, z] = key.split('/');
  const axis = (raw: string | undefined) => {
    const value = Number.parseInt(raw ?? '', 10);
    if (!Number.isFinite(value)) return 100;
    return Math.max(SCALE_MIN, Math.min(SCALE_MAX, value));
  };
  return { x: axis(x), y: axis(y), z: axis(z) };
}

/** Copy a build's settings onto a link to the same build elsewhere in the app. */
export function carrySettings(from: URLSearchParams, to: URLSearchParams): void {
  for (const [key, value] of from.entries()) {
    if (key.startsWith(PARAM_PREFIX) || key.startsWith(SCALE_PREFIX) || key === STYLE_PARAM) {
      to.set(key, value);
    }
  }
}

/** 100% on every axis is the absence of a setting, which keeps a shared link clean. */
export function writeScale(search: URLSearchParams, scale: ScalePercent | null): void {
  for (const axis of ['x', 'y', 'z'] as const) {
    const percent = scale?.[axis] ?? NO_SCALE[axis];
    if (percent === 100) search.delete(SCALE_PREFIX + axis);
    else search.set(SCALE_PREFIX + axis, String(percent));
  }
}
