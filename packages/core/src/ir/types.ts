/**
 * CraftMagic intermediate representation.
 *
 * A `BuildProgram` is what the AI emits: a parametric description of a structure.
 * The expander bakes it into a `VoxelGrid`. Both are persisted, which is what makes
 * smart resize possible — re-expanding at a new size re-derives every coordinate.
 *
 * Coordinate space matches Minecraft: right-handed, Y-up, +X east, +Y up, +Z south.
 * The origin (0,0,0) is the structure's min corner and ground level is y=0.
 */

export type Vec3 = [number, number, number];

/**
 * A coordinate expression, resolved by the expander against the structure bounds.
 *
 * Grammar:  INT | "min" | "max" | "center" | "<n>%" | "$param"
 *           each optionally followed by "*INT" then "+INT" | "-INT".
 * Examples: 4, "max-1", "center+2", "50%", "$floors*4+1"
 *
 * `max` resolves to `size.axis - 1` (inclusive), so "min".."max" spans the whole axis.
 * Using expressions rather than literals is what lets a program survive a resize.
 */
export type Coord = number | string;

export type CVec3 = [Coord, Coord, Coord];

/** Horizontal facings only. north = -Z, south = +Z, east = +X, west = -X. */
export type Face = 'north' | 'south' | 'east' | 'west';

export type Axis = 'x' | 'y' | 'z';

/**
 * A block, optionally with explicit states: `"minecraft:oak_stairs[facing=north,half=top]"`.
 * The registry canonicalizes these (sorted properties, defaults filled) so that palettes
 * dedupe correctly on export.
 */
export type BlockRef = string;

export interface WeightedBlockRef {
  block: BlockRef;
  weight: number;
}

/**
 * Palette roles are semantic, not literal blocks, so a whole structure can be
 * re-skinned by swapping the palette. These names are the recommended vocabulary
 * (stated in the generation system prompt); arbitrary role names are also legal.
 */
export type PaletteRole =
  | 'wall_primary'
  | 'wall_secondary'
  | 'wall_accent'
  | 'foundation'
  | 'floor'
  | 'frame'
  | 'roof_primary'
  | 'roof_trim'
  | 'window'
  | 'door'
  | 'trim'
  | 'path'
  | 'foliage'
  | 'light'
  | 'decoration';

/** How a component's volume is coloured. All patterns are deterministic — no RNG. */
export type Fill =
  | { type: 'solid'; role: string }
  | { type: 'checker'; a: string; b: string; plane?: 'xz' | 'xy' | 'yz' }
  | { type: 'stripes'; roles: string[]; axis: Axis; period?: number }
  | { type: 'noise'; roles: WeightedRole[]; seed?: number }
  | { type: 'border'; edge: string; inner: string };

export interface WeightedRole {
  role: string;
  weight: number;
}

/**
 * Optional identity, carried by every component variant.
 *
 * `id` exists for the things that need to point at a component from outside the program: the
 * diff-refine tool addresses its edits to `id`s, and the layouter tags each component with the
 * plan item that produced it so a click in 3D can find its way back to the plan. `label` is a
 * human name for the outliner. Both are additive — the expander ignores them, `version` stays
 * 1, and a program without them is exactly as valid as it always was.
 */
export interface ComponentTag {
  id?: string;
  label?: string;
}

export type Component = ComponentTag &
  (
  | { type: 'box'; pos: CVec3; size: CVec3; fill: Fill }
  | {
      type: 'hollow_box';
      pos: CVec3;
      size: CVec3;
      fill: Fill;
      wallThickness?: Coord;
      floor?: boolean;
      ceiling?: boolean;
    }
  | {
      type: 'cylinder';
      base: CVec3;
      radius: Coord;
      height: Coord;
      axis?: Axis;
      hollow?: boolean;
      fill: Fill;
    }
  | {
      type: 'sphere';
      center: CVec3;
      radius: Coord;
      hollow?: boolean;
      /** `top_half` is the usual choice for domes. */
      cap?: 'full' | 'top_half' | 'bottom_half';
      fill: Fill;
    }
  | {
      type: 'pyramid';
      pos: CVec3;
      baseSize: [Coord, Coord];
      /** How much each tier insets per level. Default 1. */
      step?: Coord;
      hollow?: boolean;
      fill: Fill;
    }
  | {
      type: 'gable_roof';
      pos: CVec3;
      size: CVec3;
      ridgeAxis: 'x' | 'z';
      overhang?: Coord;
      style?: 'stairs' | 'slabs' | 'full';
      roofRole: string;
      trimRole?: string;
    }
  | {
      type: 'hip_roof';
      pos: CVec3;
      size: CVec3;
      overhang?: Coord;
      style?: 'stairs' | 'full';
      roofRole: string;
    }
  | {
      type: 'arch';
      pos: CVec3;
      width: Coord;
      height: Coord;
      depth: Coord;
      axis: 'x' | 'z';
      style?: 'round' | 'pointed';
      fill: Fill;
      /** Carve the opening out of existing geometry before drawing the frame. */
      carve?: boolean;
    }
  | {
      type: 'window_grid';
      face: Face;
      region: { pos: CVec3; size: CVec3 };
      rows: Coord;
      cols: Coord;
      windowSize: [Coord, Coord];
      margin?: Coord;
      role: string;
      sill?: boolean;
    }
  | { type: 'door'; face: Face; at: CVec3; width?: 1 | 2; height?: 2 | 3; role: string }
  | { type: 'line'; from: CVec3; to: CVec3; thickness?: Coord; fill: Fill }
  | {
      type: 'stairs_run';
      pos: CVec3;
      direction: Face;
      width: Coord;
      steps: Coord;
      role: string;
      style?: 'stairs' | 'blocks';
    }
  | { type: 'group'; children: Component[]; transform?: Transform[] }
  );

export type ComponentType = Component['type'];

/**
 * Every component type, at runtime.
 *
 * The JSON Schema handed to the model and the expander's dispatch both have to cover this
 * list exactly. Nothing in TypeScript reflects a union at runtime, so `COMPONENT_TYPE_GUARD`
 * below closes the gap: adding a component to the union without adding it here is a
 * compile error, and a test asserts the schema covers the same set.
 */
export const COMPONENT_TYPES = [
	'box',
	'hollow_box',
	'cylinder',
	'sphere',
	'pyramid',
	'gable_roof',
	'hip_roof',
	'arch',
	'window_grid',
	'door',
	'line',
	'stairs_run',
	'group',
] as const satisfies readonly ComponentType[];

/** Fails to compile if a `ComponentType` is missing from `COMPONENT_TYPES`. */
const COMPONENT_TYPE_GUARD: Record<ComponentType, true> = {
	box: true,
	hollow_box: true,
	cylinder: true,
	sphere: true,
	pyramid: true,
	gable_roof: true,
	hip_roof: true,
	arch: true,
	window_grid: true,
	door: true,
	line: true,
	stairs_run: true,
	group: true,
};
void COMPONENT_TYPE_GUARD;

export type Transform =
  | { op: 'translate'; by: Vec3 }
  /** Rotation is around Y and remaps directional blockstates via the registry. */
  | { op: 'rotate90'; times: 1 | 2 | 3; pivot?: 'center' | CVec3 }
  | { op: 'mirror'; axis: 'x' | 'z'; pivot?: 'center' | CVec3 }
  | { op: 'repeat'; count: number; step: Vec3; alternateMirror?: boolean };

/** Raw voxel patches, applied after all components. For small accents only. */
export type DetailOp =
  | { op: 'set'; at: CVec3; block: BlockRef }
  | { op: 'fill'; from: CVec3; to: CVec3; block: BlockRef }
  | { op: 'clear'; from: CVec3; to: CVec3 };

export interface ProgramParam {
  value: number;
  min: number;
  max: number;
  label?: string;
}

/**
 * Per-axis resize, as a percentage of the program's own `size`. 100 leaves an axis alone.
 *
 * Part of the program rather than an argument to the expander so that a resized build is a
 * *program* like any other: it downloads, saves to the library, and re-expands to exactly what
 * was on screen. A scale kept outside the program would be lost by every one of those paths.
 */
export interface ScalePercent {
  x: number;
  y: number;
  z: number;
}

export interface BuildProgram {
  version: 1;
  meta: { name: string; description?: string; style?: string };
  size: { x: number; y: number; z: number };
  /**
   * Resize the whole build, as a percentage per axis. Written by the editor's scale control,
   * not by the generator: a program describes a structure at its natural size, and the scale
   * is what the user did to it afterwards.
   */
  scale?: ScalePercent;
  /** Named numbers referenced by coordinate expressions as `$name`. Drive the UI sliders. */
  params?: Record<string, ProgramParam>;
  palette: Record<string, BlockRef | WeightedBlockRef[]>;
  /** Painter's order: later components overwrite earlier ones. `minecraft:air` carves. */
  components: Component[];
  details?: DetailOp[];
}

/**
 * Baked voxels.
 *
 * Index order is YZX (`x + z*size.x + y*size.x*size.z`) — deliberately identical to the
 * Sponge schematic `BlockData` order, so `.schem` export is a straight varint encode and
 * a build-guide layer is a contiguous slice.
 */
export interface VoxelGrid {
  size: { x: number; y: number; z: number };
  /** Canonical blockstate strings. Index 0 is always `minecraft:air`. */
  palette: string[];
  voxels: Uint16Array;
}

export const AIR_INDEX = 0;
export const AIR_BLOCK: BlockRef = 'minecraft:air';

/** Validator limits. Kept here so the expander, the JSON Schema and the prompt agree. */
export const LIMITS = {
  maxSizeX: 256,
  maxSizeY: 160,
  maxSizeZ: 256,
  maxBlocks: 500_000,
  maxComponents: 400,
  maxDetailOps: 5_000,
  /** A single `fill` detail op may not cover more than this many blocks. */
  maxDetailFillVolume: 512,
  /**
   * Distinct parts provenance can track.
   *
   * Bounded by the `Uint16Array` that stores them: 0 means "unowned", so the last usable id
   * is 65534. Components past this draw normally and simply report no part, which is the
   * right failure — a guide with unnamed steps beats an expander that refuses to run.
   */
  maxParts: 65_534,
} as const;

export type ExpandIssueCode =
  | 'UNKNOWN_BLOCK'
  | 'UNDEFINED_ROLE'
  | 'OUT_OF_BOUNDS'
  | 'BAD_COORD_EXPR'
  | 'SIZE_CAP'
  | 'DETAIL_CAP'
  | 'BAD_STATE'
  | 'EMPTY_COMPONENT'
  /** A diff-refine op that could not be applied (unknown id, malformed shape). */
  | 'BAD_PATCH';

/**
 * A structured problem, addressed to both the user and the model. `path` is a JSON
 * pointer-ish locator (`components[3].size`) so the repair round can be specific.
 */
export interface ExpandIssue {
  path: string;
  code: ExpandIssueCode;
  message: string;
}

/**
 * One drawable component of a program, and what it still owns once the build is baked.
 *
 * "Still owns" is the load-bearing word. Components are painted in order and later ones
 * overwrite earlier ones, so a part's `blocks` counts what survived to the finished grid, not
 * what it drew. A wall entirely hidden behind a later wall reports zero — which is what the
 * build guide wants, since naming a step after something invisible helps nobody.
 *
 * Repeats collapse. A `repeat` transform draws its children many times but they remain *one*
 * part, so a courtyard of 100 identical towers yields "Tower walls" once rather than a
 * hundred indistinguishable entries.
 */
export interface BuildPart {
  /** 1-based, matching the values stored in {@link ExpandResult.origin}. Never 0. */
  id: number;
  /** Where the component sits in the program: `components[3].children[0]`. */
  path: string;
  /**
   * The component that drew it, or `'details'` for the raw voxel patches applied last.
   *
   * No human-readable name here on purpose. What a part is *called* is a presentation
   * decision — it depends on the build's proportions and on which document is asking — so it
   * lives in the build guide's design system rather than being frozen at expansion time.
   */
  type: ComponentType | 'details';
  /** The palette role it draws in, when the component names exactly one. */
  role?: string;
  /**
   * The wall the component declared itself against, for the types that name one.
   *
   * Carried through rather than re-derived from bounds because it is the author's own word:
   * a window grid on a two-block-thick wall is ambiguous by geometry and unambiguous here.
   */
  face?: Face;
  /** Voxels this part still owns in the finished grid. */
  blocks: number;
  /** Bounds of what it owns, or undefined when `blocks` is 0. */
  min?: Vec3;
  max?: Vec3;
}

export interface ExpandOptions {
  /**
   * Record which component each voxel came from.
   *
   * Off by default, and deliberately so: it costs a second `Uint16Array` the size of the grid
   * plus a full pass to measure the parts. The editor re-expands on every frame of a slider
   * drag — on the 200k-block stress build that is 2.7MB of churn per frame for something it
   * never reads. The build guide expands once and needs it, so it asks.
   */
  provenance?: boolean;
}

export interface ExpandResult {
  grid: VoxelGrid;
  /** Non-air block count. */
  blockCount: number;
  /** Non-fatal: the component was clipped or partially skipped. */
  warnings: ExpandIssue[];
  /** Fatal for the component that produced them; empty means a clean expansion. */
  errors: ExpandIssue[];
  /**
   * Per-voxel part id, parallel to `grid.voxels`; 0 where nothing owns the cell.
   *
   * Null unless {@link ExpandOptions.provenance} was set. Index with `voxelIndex`, exactly
   * like the voxels themselves.
   */
  origin: Uint16Array | null;
  /** The parts `origin` refers to, in program order. Empty when provenance is off. */
  parts: BuildPart[];
}

/** An undo/redo unit. Typed arrays keep large edits cheap (~10 bytes per voxel). */
export interface EditOp {
  indices: Uint32Array;
  before: Uint16Array;
  after: Uint16Array;
}

/** Index helpers — the YZX convention lives here and nowhere else. */
export function voxelIndex(size: VoxelGrid['size'], x: number, y: number, z: number): number {
  return x + z * size.x + y * size.x * size.z;
}

export function voxelPosition(size: VoxelGrid['size'], index: number): Vec3 {
  const layer = size.x * size.z;
  const y = Math.floor(index / layer);
  const rem = index - y * layer;
  const z = Math.floor(rem / size.x);
  const x = rem - z * size.x;
  return [x, y, z];
}

export function voxelCount(size: VoxelGrid['size']): number {
  return size.x * size.y * size.z;
}
