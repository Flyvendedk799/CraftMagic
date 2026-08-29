/**
 * Resizing a build.
 *
 * The model here is a **cell map**: every block of the program's own coordinate space becomes
 * a cell of the drawn space, and everything the program says is re-expressed in terms of those
 * cells. A run of blocks becomes the cells it covered, a single block becomes one block inside
 * its cell, and a radius becomes whatever fits the cells its diameter covered.
 *
 * Cells are described by their *edges* — `edge(k)` is where the boundary between base block
 * `k-1` and base block `k` lands — because edges are what makes a resize hold together:
 *
 *  - two components that touched still touch, since one's far edge *is* the other's near edge;
 *  - nothing gains a gap or an overlap that the program did not ask for;
 *  - a wall flush with the far edge stays flush, because `edge(base)` is exactly `target`.
 *
 * The alternative — remapping the inclusive index range, `p*(target-1)/(base-1)` — pins the
 * outer edges just as well but scales positions and sizes by different factors, so parts
 * designed to meet drift apart in the middle of the build, which is far more visible.
 *
 * ## Why the edge map is built from both ends
 *
 * `round(k*factor)` alone is not symmetric: rounding breaks ties one way (upwards), so a
 * feature two blocks from the west wall and its mirror two blocks from the east wall could
 * land at different distances from their walls. A build whose whole design is symmetry —
 * which is most builds — came back subtly lopsided, and shrinking made it worse.
 *
 * So the low half of an axis is rounded directly and the high half is defined as the *mirror*
 * of the low half. That makes `edge(base-k) === target - edge(k)` exactly, for every k, and
 * every mapping below is derived from `edge`, so all of them inherit that symmetry: mirrored
 * geometry scales to mirrored geometry, at any factor, on any axis.
 *
 * Anchors (`min`/`max`/`center`/`%`) are *not* special-cased. They resolve against the
 * program's own size and are then mapped with everything else, which keeps a resized build a
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

/** A run of blocks in drawn space: where it starts and how long it is. */
export interface Span {
  pos: number;
  len: number;
}

/** A centred run: the block its middle sits on, and how far it reaches either side. */
export interface Centred {
  centre: number;
  radius: number;
}

/**
 * One axis' map from the program's coordinate space into the drawn one.
 *
 * Every method is derived from {@link edge}, which is what keeps them consistent with each
 * other: a box drawn over a run of cells and a lantern placed on one block of that run agree
 * about where the run is, whatever the factor.
 */
export class AxisScale {
  readonly factor: number;

  constructor(
    /** Length of the axis in the program's own space. */
    readonly base: number,
    /** Length of the axis actually drawn. */
    readonly target: number,
    /**
     * Whether builds are mirrored across this axis — true of X and Z, false of Y.
     *
     * It decides where a single block sits inside the several cells it now covers, and the two
     * answers are in genuine conflict. Horizontally, a block in the high half of the axis has
     * to take the far end of its cell or it stops being the mirror image of its opposite
     * number, and symmetry across X and Z is what most builds are made of. Vertically nobody
     * mirrors anything, and what matters instead is that a lantern set on top of a wall stays
     * on top of that wall rather than floating a block above it — so Y always takes the near
     * end, which is the block immediately above whatever it was standing on.
     */
    readonly mirrors = true,
  ) {
    this.factor = base > 0 ? target / base : 1;
  }

  /** True when this axis is drawn exactly as written, so callers can skip the arithmetic. */
  get identity(): boolean {
    return this.base === this.target;
  }

  /**
   * Where the boundary before base block `k` lands, for `k` in `0..base`.
   *
   * `edge(0)` is 0 and `edge(base)` is `target`, exactly. Coordinates outside the program's
   * own volume — a roof overhang, a deliberately oversized footprint — extrapolate at the
   * plain factor, symmetrically about whichever end they left.
   */
  edge(k: number): number {
    if (this.identity) return k;
    if (k <= 0) return -this.away(-k);
    if (k >= this.base) return this.target + this.away(k - this.base);
    // The high half is the mirror of the low half rather than its own rounding, which is what
    // makes `edge(base-k) === target - edge(k)` hold for every k.
    return 2 * k <= this.base
      ? Math.round(k * this.factor)
      : this.target - Math.round((this.base - k) * this.factor);
  }

  /** The cells base block `p` covers, as an inclusive pair. `hi < lo` means it collapsed. */
  cell(p: number): [number, number] {
    const lo = this.edge(p);
    return [lo, this.edge(p + 1) - 1];
  }

  /**
   * Where a single block lands.
   *
   * A block is one block after a resize too — a lantern does not become a 2x2 slab of
   * lanterns when the build doubles — so this picks one cell out of the several the block now
   * covers. Which one is not arbitrary: on a mirroring axis, blocks in the low half take the
   * near end of their cell and blocks in the high half take the far end, so a mirrored pair of
   * details lands on a mirrored pair of blocks instead of drifting a block apart — and each of
   * them ends up on the outward side of whatever it is attached to, which is where a detail
   * hung on a wall belongs. See {@link mirrors} for the axis where that rule is wrong.
   */
  point(p: number): number {
    if (this.identity) return p;
    const [lo, hi] = this.cell(p);
    // The near or far end of the cell rather than its middle, so a detail that was touching
    // something goes on touching it instead of drifting half a cell away from it. A cell a
    // shrink has squeezed to nothing takes the same end, which is what keeps even a squeezed
    // pair of details mirror images of each other.
    return this.hold(p, this.low(p) ? lo : hi);
  }

  /**
   * A run of `len` blocks starting at `p`, as the cells it covers.
   *
   * With no `min`, the length is the honest scaled one, which can be 0 when a shrink collapses
   * the run — trim is allowed to disappear that way. Structure passes `min = 1`, because a
   * wall that rounds away to nothing leaves a hole rather than a smaller build, and the run is
   * then held against the same end of its cells that a single block would take: a pillar two
   * in from the west wall and its opposite number two in from the east wall are squeezed onto
   * blocks that are still each other's mirror image.
   */
  span(p: number, len: number, min = 0): Span {
    if (len <= 0) return { pos: this.edge(p), len: 0 };
    if (this.identity) return { pos: p, len: Math.max(min, len) };
    const lo = this.edge(p);
    const scaled = this.edge(p + len) - lo;
    if (scaled >= min) return { pos: lo, len: scaled };
    return { pos: this.low(p) ? lo : lo - (min - scaled), len: min };
  }

  /**
   * A run centred on block `p` reaching `radius` blocks either side — a cylinder's or
   * sphere's cross-section.
   *
   * The radius comes from the *diameter's* scaled span rather than from scaling the radius on
   * its own, so the circle covers the ground its original covered instead of drifting a block
   * wide or narrow, and `cap` lets a caller hold every axis of a sphere to one radius.
   */
  centred(p: number, radius: number, cap = Number.POSITIVE_INFINITY): Centred {
    if (this.identity) return { centre: p, radius: Math.min(radius, cap) };
    const lo = this.edge(p - radius);
    const hi = this.edge(p + radius + 1) - 1;
    const r = Math.max(0, Math.min(cap, Math.floor((hi - lo) / 2)));
    return { centre: this.hold(p, this.low(p) ? lo + r : hi - r), radius: r };
  }

  /**
   * Scale a free length — one with no position to anchor it to: a wall's thickness, a roof's
   * overhang, a window's height.
   *
   * `min` is where shrinking stops. It defaults to 1 because structure must not round away to
   * nothing: at 25% a one-block wall would otherwise become a zero-block wall and the build
   * would come back full of holes rather than small. Pass 0 for the things a build is still
   * itself without — a roof overhang, a margin — so a cottage shrunk to five blocks across
   * loses its eaves instead of projecting them past its own foundation.
   */
  length(value: number, min = 1): number {
    // Zero and nonsense pass through untouched, so callers that treat a negative radius as
    // "draw nothing" keep doing exactly that.
    if (value <= 0 || this.identity) return value;
    return Math.max(min, Math.round(value * this.factor));
  }

  /** Scale a distance a group is translated by, keeping the two directions symmetric. */
  offset(distance: number): number {
    if (this.identity || distance === 0) return distance;
    const scaled = Math.round(Math.abs(distance) * this.factor);
    return distance < 0 ? -scaled : scaled;
  }

  /** The exact middle of the drawn axis. Half-integer on an even axis, deliberately. */
  get centre(): number {
    return (this.target - 1) / 2;
  }

  /** Whether base block `p` takes the near end of its cell — see {@link mirrors}. */
  private low(p: number): boolean {
    return !this.mirrors || 2 * p + 1 <= this.base;
  }

  /** How far a coordinate outside the volume stays outside it. */
  private away(distance: number): number {
    return Math.round(distance * this.factor);
  }

  /**
   * Keep a block that was inside the program's volume inside the drawn one.
   *
   * Below half scale the last block of an axis can map past the far edge, and a component
   * pushed out there is not clipped a little — it disappears entirely. Landing it on the last
   * cell instead means a shrunk build loses detail to crowding, which is what shrinking is,
   * rather than losing its end wall.
   */
  private hold(p: number, value: number): number {
    if (p < 0 || p >= this.base) return value;
    return Math.max(0, Math.min(this.target - 1, value));
  }
}

/** The three axis maps a program is drawn through. */
export interface Scale3 {
  x: AxisScale;
  y: AxisScale;
  z: AxisScale;
}

export function axisScales(base: Size3, target: Size3): Scale3 {
  return {
    x: new AxisScale(base.x, target.x),
    // Y does not mirror: gravity is not symmetric, and neither is anything built under it.
    y: new AxisScale(base.y, target.y, false),
    z: new AxisScale(base.z, target.z),
  };
}

// --- choosing a size up front -------------------------------------------

/**
 * How big the finished build should be, chosen before anything is generated.
 *
 * Measured in **placed blocks**, which is how a builder thinks about the size of a build: a
 * shed is a hundred blocks and a castle is tens of thousands, and neither of those is a fact
 * about how many blocks wide it is. A footprint measurement gets this wrong in both
 * directions — a 30-block tower and a 30-block barn are nothing like the same amount of
 * building — and it is not a number anyone can picture from the word "medium".
 *
 * A size choice is deliberately *not* a brief for how much detail to design. The model is
 * asked to write the structure at whatever size it needs to read properly, and the build is
 * then scaled down to the chosen size — so a small cottage is the detailed cottage seen small,
 * and the detail is still there at 100% for anyone who drags the slider back up. Designing
 * down to a small number instead is what produced the flat, featureless little boxes.
 */
export type SizeChoice = 'natural' | 'tiny' | 'small' | 'medium' | 'large' | 'huge';

/** How many blocks a size choice asks for. `max` is null on the open-ended top end. */
export interface BlockBudget {
  min: number;
  max: number | null;
}

export interface SizeOption {
  id: SizeChoice;
  label: string;
  /** The block count this size means. Null on "natural", which asks for nothing. */
  blocks: BlockBudget | null;
  /** What a build of this size is, in a builder's words — the anchor for the number. */
  example: string;
}

export const SIZE_OPTIONS: readonly SizeOption[] = [
  { id: 'natural', label: 'Natural', blocks: null, example: 'whatever the design wants' },
  { id: 'tiny', label: 'Tiny', blocks: { min: 20, max: 150 }, example: 'a shrine or a market stall' },
  { id: 'small', label: 'Small', blocks: { min: 150, max: 300 }, example: 'a hut or a watchpost' },
  { id: 'medium', label: 'Medium', blocks: { min: 300, max: 800 }, example: 'a cottage or a small tower' },
  { id: 'large', label: 'Large', blocks: { min: 800, max: 2_000 }, example: 'a house, a hall or a keep' },
  { id: 'huge', label: 'Huge', blocks: { min: 2_000, max: null }, example: 'a castle or a cathedral' },
];

export function isSizeChoice(value: unknown): value is SizeChoice {
  return typeof value === 'string' && SIZE_OPTIONS.some((option) => option.id === value);
}

/** The block count a choice asks for, or null when it asks for nothing. */
export function blockBudget(choice: SizeChoice | undefined): BlockBudget | null {
  return SIZE_OPTIONS.find((option) => option.id === choice)?.blocks ?? null;
}

/** A block budget as a person reads it: "300–800 blocks", "2,000 blocks or more". */
export function describeBudget(budget: BlockBudget): string {
  const count = (n: number) => n.toLocaleString('en-US');
  return budget.max === null
    ? `${count(budget.min)} blocks or more`
    : `${count(budget.min)}–${count(budget.max)} blocks`;
}

/** One line naming a size, for a chooser: "a cottage or a small tower · 300–800 blocks". */
export function describeSize(option: SizeOption): string {
  return option.blocks === null
    ? 'Whatever size the design wants'
    : `${option.example} · ${describeBudget(option.blocks)}`;
}

/**
 * The floor a fitted scale stops at, in percent.
 *
 * Matches the editor's own slider so a generated build always opens on a value the user can
 * drag back and forth from. It is also the point below which a structure stops being a smaller
 * version of itself and starts being a pile of the same blocks: a size choice may ask a build
 * to shrink, but not to dissolve.
 */
export const MIN_FIT_PERCENT = 25;
