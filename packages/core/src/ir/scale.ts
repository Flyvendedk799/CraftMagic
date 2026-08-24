/**
 * Resizing a build.
 *
 * The model here is deliberately the simplest one that is also correct: **every original block
 * becomes an f×f×f cube of blocks**, where f is that axis' factor. A position at index `p`
 * maps to `p*f` and a length `w` maps to `w*f`, so two components that touched still touch and
 * a wall that ended flush with the far edge still ends flush — a block at `max` is one block
 * wide, and `(max)*f` plus `1*f` lands exactly on the new far edge.
 *
 * The alternative — remapping the inclusive index range, `p*(target-1)/(base-1)` — pins the
 * edges more exactly but scales positions and sizes by different factors, which pulls apart
 * parts of the build that were designed to meet. Alignment inside the structure is far more
 * visible than whether it touches the outside of its own bounding volume, so one factor wins.
 *
 * Anchors (`min`/`max`/`center`/`%`) are *not* special-cased here. They resolve against the
 * program's own size and are then scaled with everything else, which keeps a resized build a
 * uniform enlargement of the original rather than a mix of stretched and pinned parts.
 */

import type { ScalePercent } from './types.js';
import { LIMITS } from './types.js';

export const NO_SCALE: ScalePercent = { x: 100, y: 100, z: 100 };

export interface Size3 {
  x: number;
  y: number;
  z: number;
}

/** Whether a scale asks for anything at all — 100% on every axis is the absence of one. */
export function isScaled(scale: ScalePercent | undefined): scale is ScalePercent {
  return scale !== undefined && (scale.x !== 100 || scale.y !== 100 || scale.z !== 100);
}

/**
 * The size a scale produces, clamped to what the expander accepts.
 *
 * Clamped rather than rejected: a slider that silently stops at the cap is far better than one
 * that lets you drag into an error. The floor of 1 matters as much as the ceiling — a
 * zero-thickness axis expands to nothing at all, and "my build vanished" is a worse outcome
 * than "it stopped getting smaller".
 */
export function scaledSize(size: Size3, scale: ScalePercent | undefined): Size3 {
  if (!isScaled(scale)) return { x: size.x, y: size.y, z: size.z };

  const axis = (value: number, percent: number, max: number) =>
    Math.max(1, Math.min(max, Math.round((value * percent) / 100)));

  return {
    x: axis(size.x, scale.x, LIMITS.maxSizeX),
    y: axis(size.y, scale.y, LIMITS.maxSizeY),
    z: axis(size.z, scale.z, LIMITS.maxSizeZ),
  };
}

/**
 * The multiplier each axis' coordinates take.
 *
 * Derived from the *clamped* size rather than the requested percentage, so a build held back
 * by the engine cap is drawn at the size it was actually given instead of overflowing its own
 * volume.
 */
export function scaleFactors(size: Size3, scale: ScalePercent | undefined): Size3 {
  const target = scaledSize(size, scale);
  return {
    x: size.x > 0 ? target.x / size.x : 1,
    y: size.y > 0 ? target.y / size.y : 1,
    z: size.z > 0 ? target.z / size.z : 1,
  };
}

/** Scale a position. Out-of-range results are the canvas' problem, as they always were. */
export function scalePos(value: number, factor: number): number {
  return factor === 1 ? value : Math.round(value * factor);
}

/**
 * Scale a length.
 *
 * `min` is where shrinking stops. It defaults to 1 because structure must not round away to
 * nothing: at 25% a one-block wall would otherwise become a zero-block wall and the build would
 * come back full of holes rather than small. Pass 0 for the things a build is still itself
 * without — a roof overhang, a margin — so a cottage shrunk to five blocks across loses its
 * eaves instead of projecting them past its own foundation.
 */
export function scaleLen(value: number, factor: number, min = 1): number {
  // Zero and nonsense pass through untouched, so callers that treat a negative radius as "draw
  // nothing" keep doing exactly that.
  if (value <= 0 || factor === 1) return value;
  return Math.max(min, Math.round(value * factor));
}
