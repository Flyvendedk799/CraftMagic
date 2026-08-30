/**
 * Plans: several saved builds arranged on one plot.
 *
 * A build is a *structure*. A plan is a *site* — a row of cottages along a road, a keep with
 * four corner towers, the same watchtower repeated eight times. Nothing in the IR could say
 * that before: every build was a world unto itself with its own origin, and the only way to
 * put two of them near each other was to send them into Minecraft separately and hope.
 *
 * The unit of reuse is deliberately the **voxel grid**, not the program. Programs re-expand
 * and that is their whole point, but a plan is about arrangement, not about parametrics: the
 * thing you dragged into place has to stay exactly the shape you saw. It also means a
 * hand-edited build — one with no program left — is as placeable as any other, which is the
 * only answer that would not have been arbitrary.
 */

import type { VoxelGrid } from '../ir/types.js';

/** Quarter turns clockwise around Y, viewed from above. */
export type Quarter = 0 | 1 | 2 | 3;

/**
 * One instance of a component on the plot.
 *
 * `at` is the min corner of the *placed* footprint, so it already accounts for rotation —
 * moving a rotated building does not have to reason about where its origin ended up.
 */
export interface Placement {
  /** Identity of this instance. A component may be placed many times. */
  id: string;
  /** The library build this instance is an instance *of*. */
  sourceId: string;
  at: { x: number; y: number; z: number };
  rotation: Quarter;
}

/** A library build, fetched once and reused by every placement that names it. */
export interface PlanComponent {
  sourceId: string;
  name: string;
  grid: VoxelGrid;
}

/** The axis-aligned box a placement occupies, inclusive of `max`. */
export interface PlacementBox {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface ComposeResult {
  grid: VoxelGrid;
  /** Non-air blocks in the composed grid. */
  blockCount: number;
  /**
   * Where the composed grid's origin sits in plan space.
   *
   * Compose trims to what is actually occupied, so a plan built in the middle of the plot
   * does not export 200 blocks of air on every side. Anything that has to map a plan
   * coordinate onto the composed grid — a selection outline, a picked voxel — needs this.
   */
  offset: { x: number; y: number; z: number };
  /**
   * Cells where a later placement's block replaced an earlier placement's block.
   *
   * Not an error: overlapping is a legitimate way to join two structures, and forbidding it
   * would make a courtyard impossible. It is reported because it is also the shape of an
   * accident, and a number on screen is the difference between the two.
   */
  overlaps: number;
  /** Placements dropped entirely, with the reason. Never silent. */
  errors: string[];
}

/**
 * The plot. Fixed at the engine's own size caps rather than growing to fit.
 *
 * Making the plot a constant is what lets the planner clamp a drag instead of discovering
 * afterwards that the arrangement cannot be expanded, exported or sent. The alternative —
 * unbounded plan space, validated on compose — means dragging one building too far empties
 * the whole viewport, which reads as a crash rather than as a limit.
 */
export const PLAN_SIZE = { x: 256, y: 160, z: 256 } as const;
