/**
 * Where region *n* of a map goes, once region 0 has been placed by a player.
 *
 * The mod does exactly one sum for a continuation region: `anchor + turn(offset)`, where
 * `anchor` is the corner region 0 was built from and `turn` is the quarter-turn the player
 * gave it (see `Footprint.turn` in the mod). That sum is exact while every region shares a
 * footprint — which a map whose extent divides evenly by its region size gives you — and off
 * by a constant for the truncated regions along the far edges of any map that does not.
 *
 * ## Why an edge region lands wrong
 *
 * The mod's `BuildTask.plan()` maps a quarter-turned schematic back into a box that still
 * starts at its origin: a `w×d` footprint turned clockwise occupies `d×w` and its cells run
 * `[0, d) × [0, w)` from the origin, not `[-(d-1), 0] × [0, w)` as the raw rotation would put
 * them. So the corner a build is built from is the *low corner of its turned box*, and the
 * anchor region 0 reports is that corner for region 0's own size. A region with a different
 * size has a different shift between "turned position of its first block" and "low corner of
 * its turned box", and adding the turned offset to the anchor ignores the difference. The
 * error is exactly `shift(regionN) − shift(region0)`, in the turned frame.
 *
 * ## The fix is on the server, in the unturned frame
 *
 * The mod's arithmetic is right for what it knows and does not need a new field; what it is
 * handed can simply be pre-corrected. `turn` is linear and invertible, so the difference is
 * carried back into the world's own frame and added to the offset before it is sent. A mod
 * that predates worlds is unaffected — it never reads the field — and a mod running today
 * gets the right answer from the same sum it has always done. Unrotated maps get `offset`
 * back untouched, byte for byte.
 */

import { turnedPrefabOffset } from '../ir/prefab.js';

/** A build's footprint before any rotation: the schematic's width (x) and length (z). */
export interface Footprint {
  x: number;
  z: number;
}

export interface Offset3 {
  x: number;
  y: number;
  z: number;
}

/** A displacement turned by `turns` quarter-turns clockwise: (x, z) → (−z, x) per turn. */
export function turnOffset(dx: number, dz: number, turns: number): { x: number; z: number } {
  let x = dx;
  let z = dz;
  for (let i = 0; i < ((turns % 4) + 4) % 4; i++) {
    const nx = -z;
    z = x;
    x = nx;
  }
  // `-0` is what negating a zero gives, and it survives into JSON as `0` but fails a strict
  // equality on the way there. Nobody downstream wants a signed zero in a block coordinate.
  return { x: x === 0 ? 0 : x, z: z === 0 ? 0 : z };
}

/** The inverse of `turnOffset`, so a correction found in the turned frame can be sent unturned. */
export function unturnOffset(dx: number, dz: number, turns: number): { x: number; z: number } {
  return turnOffset(dx, dz, (4 - (((turns % 4) + 4) % 4)) % 4);
}

/**
 * How far a turned box's low corner sits from the turned position of its first block.
 *
 * `turnedPrefabOffset` is the shift the expander applies to pull a turned prefab back to a
 * min corner at the origin; the mod's `BuildTask` applies the same shift, which is what makes
 * this the right number here. Negated, because that function answers "how far to move the
 * turned box" and this one answers "where the box's corner is".
 */
export function turnedCornerShift(size: Footprint, turns: number): { x: number; z: number } {
  const shift = turnedPrefabOffset({ x: size.x, y: 1, z: size.z }, turns);
  return { x: -shift.x, z: -shift.z };
}

/**
 * The offset to send for a continuation region so that `anchor + turn(offset)` is exact.
 *
 * `first` is the footprint of the region the anchor was measured against — region 0 — and
 * `region` is this region's own. Identical footprints return `offset` itself, so the common
 * case (a map that divides into whole regions, or any unrotated map) is a no-op and the
 * wire stays byte-identical to what it was before this existed.
 */
export function deliveryOffset(
  offset: Offset3,
  rotation: number,
  first: Footprint,
  region: Footprint,
): Offset3 {
  const own = turnedCornerShift(region, rotation);
  const reference = turnedCornerShift(first, rotation);
  const dx = own.x - reference.x;
  const dz = own.z - reference.z;
  if (dx === 0 && dz === 0) return offset;
  const back = unturnOffset(dx, dz, rotation);
  return { x: offset.x + back.x, y: offset.y, z: offset.z + back.z };
}
