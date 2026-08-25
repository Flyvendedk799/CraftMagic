/**
 * Build programs → something the viewer can draw.
 *
 * The whole point of the IR is that a program is re-expanded rather than edited, so this
 * module is deliberately stateless: change a param or the scale, call `expandBuild` again,
 * get a fresh grid. That is what makes the resize slider a real feature demo rather than a
 * stretch — walls stay walls because every coordinate is re-derived, not resampled.
 *
 * `paletteColors`/`paletteFlags` are the seam that keeps the renderer independent of
 * Minecraft: from here down, the mesher only ever sees colours and flag bytes.
 */

import {
  expand,
  isScaled,
  NO_SCALE,
  paletteColors,
  paletteFlags,
  samples,
  scaledSize,
  type BuildPart,
  type BuildProgram,
  type ExpandIssue,
  type ProgramParam,
  type ScalePercent,
  type VoxelGrid,
} from '@craftmagic/core';

export { NO_SCALE, scaledSize, type ScalePercent };

export interface BuildParam {
  name: string;
  label: string;
  value: number;
  min: number;
  max: number;
}

export interface LoadedBuild {
  id: string;
  name: string;
  /**
   * The program this was expanded from — exportable, and what makes resizing possible.
   *
   * Null for a build that arrived as raw voxels. A hand-edited build saved to the library is
   * exactly that: once a voxel has been changed by hand no program describes what is on
   * screen, so the grid is the only truthful record and there is nothing to resize.
   */
  program: BuildProgram | null;
  description: string | undefined;
  grid: VoxelGrid;
  /** 3 bytes per palette slot. */
  paletteColors: Uint8Array;
  /** 1 flag byte per palette slot; bit 0 transparent, bit 1 emissive. */
  paletteFlags: Uint8Array;
  blockCount: number;
  params: BuildParam[];
  warnings: ExpandIssue[];
  errors: ExpandIssue[];
  /**
   * Which component drew each block, for the build guide to name its steps after.
   *
   * Only populated when the caller asked for it — see `provenance` on {@link expandBuild}.
   * Always empty for a build that arrived as raw voxels: no program describes it, so there is
   * nothing to attribute the blocks to and nothing truthful the guide could call them.
   */
  parts: BuildPart[];
  origin: Uint16Array | null;
}

/**
 * A field of 100 towers, ~200k blocks over 400 chunks.
 *
 * Written as a program rather than as procedural voxels so the stress test measures the
 * real pipeline — expander included — instead of only the mesher. `repeat` nested twice is
 * what keeps it two components instead of a hundred.
 *
 * Intentionally has no params: re-expanding it is cheap (~55ms) but re-meshing all 400
 * chunks is not, so a live-dragged slider here would thrash rather than demonstrate
 * anything. The resize demo belongs on the small builds.
 */
const towerField: BuildProgram = {
  version: 1,
  meta: { name: 'Tower field', description: 'Meshing stress test — 100 towers over 400 chunks' },
  size: { x: 150, y: 60, z: 150 },
  palette: {
    foundation: 'minecraft:stone_bricks',
    path: 'minecraft:cobblestone',
    wall_primary: 'minecraft:oak_planks',
    window: 'minecraft:glass',
    roof_primary: 'minecraft:bricks',
    light: 'minecraft:glowstone',
  },
  components: [
    {
      type: 'box',
      pos: ['min', 'min', 'min'],
      size: ['max', 1, 'max'],
      fill: { type: 'checker', a: 'foundation', b: 'path', plane: 'xz' },
    },
    {
      type: 'group',
      transform: [
        { op: 'repeat', count: 10, step: [15, 0, 0] },
        { op: 'repeat', count: 10, step: [0, 0, 15] },
      ],
      children: [
        {
          type: 'hollow_box',
          pos: [2, 1, 2],
          size: [11, 40, 11],
          wallThickness: 1,
          floor: false,
          ceiling: true,
          fill: { type: 'solid', role: 'wall_primary' },
        },
        {
          type: 'window_grid',
          face: 'south',
          region: { pos: [2, 1, 12], size: [11, 40, 1] },
          rows: 4,
          cols: 2,
          windowSize: [2, 2],
          role: 'window',
        },
        {
          type: 'box',
          pos: [2, 41, 2],
          size: [11, 1, 11],
          fill: { type: 'solid', role: 'roof_primary' },
        },
      ],
    },
  ],
};

/**
 * What a first-time visitor lands on: an empty plot.
 *
 * The editor used to open on the cottage sample, which reads as "here is a building someone
 * else made" rather than "describe what you want". Nothing on screen was the user's, and the
 * one thing they came to do was the least obvious.
 *
 * It is a real program with no components rather than a special case, so it flows through the
 * same expander, mesher and editor tools as everything else — an empty grid is just a grid,
 * and the place tool works on it immediately.
 */
const blank: BuildProgram = {
  version: 1,
  meta: { name: 'Empty plot', description: 'Describe a build, or start placing blocks.' },
  size: { x: 32, y: 24, z: 32 },
  // One role, so the palette swap and block picker have something sensible to start from.
  palette: { wall_primary: 'minecraft:oak_planks' },
  components: [],
};

const PROGRAMS: Record<string, BuildProgram> = {
  blank,
  cottage: samples.cottage!,
  tower: samples.tower!,
  pavilion: samples.pavilion!,
  field: towerField,
};

/** The built-in samples, in picker order. Generated builds are tracked separately. */
export const BUILD_IDS = Object.keys(PROGRAMS);

/** The empty starting point. Exported so the UI can tell "nothing yet" from "a real build". */
export const BLANK_BUILD = 'blank';

/**
 * Programs that arrived from the generator.
 *
 * Registering them here rather than treating them as a separate kind of thing is what lets a
 * generated build behave exactly like a sample: same expander, same meshing path, and — the
 * point — the same live param sliders, because the server returns the *program* and the
 * browser expands it.
 */
const generated = new Map<string, BuildProgram>();

export const GENERATED_PREFIX = 'gen:';

/**
 * Generated builds survive a reload — and a hop to another tab.
 *
 * Every one of these cost real money, so losing them to an accidental refresh is worse than
 * the small complexity of persisting them.
 *
 * localStorage, not sessionStorage. The build guide opens through
 * `<a target="_blank">`, and in Chromium a link-opened tab starts with an *empty*
 * sessionStorage — unlike a same-tab navigation or `window.open`, which both inherit one. So
 * the guide tab had never heard of `gen:1`, could not resolve it, and printed the fallback
 * sample instead: every generated build's guide came out as the cottage. Session scope was
 * simply the wrong lifetime for something reachable by link.
 *
 * Capped, because localStorage is durable where a session store cleaned itself up. A program
 * is a few KB and a long session generates a lot of them; without a cap they would sit there
 * forever and eventually make `persist` throw.
 */
const STORAGE_KEY = 'craftmagic.generated';
const MAX_STORED = 40;

function persist(): void {
  // Oldest first, so trimming to the cap drops the ones least likely to still be open.
  while (generated.size > MAX_STORED) {
    const oldest = generated.keys().next();
    if (oldest.done) break;
    generated.delete(oldest.value);
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...generated.entries()]));
  } catch {
    // Storage full or blocked; the build still works for this page view.
  }
}

/**
 * Merge in what is on disk.
 *
 * Called at import *and* before minting an id, because localStorage is shared across tabs
 * where sessionStorage was not: two editors open at once would otherwise each mint `gen:4`
 * for a different build, and whichever persisted last would win.
 */
function restore(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    for (const [id, program] of JSON.parse(raw) as [string, BuildProgram][]) {
      generated.set(id, program);
    }
  } catch {
    // A corrupt entry must not stop the editor from loading.
  }
}

restore();

/**
 * The next free `gen:` number.
 *
 * Counted from the highest id in use rather than from `generated.size`, which stopped being
 * the same thing once the store started evicting: after a trim, `size + 1` names a build
 * somebody's open tab or bookmarked URL already means something else by.
 */
function nextGeneratedId(): string {
  let highest = 0;
  for (const id of generated.keys()) {
    const n = Number.parseInt(id.slice(GENERATED_PREFIX.length), 10);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return `${GENERATED_PREFIX}${highest + 1}`;
}

export function registerGeneratedBuild(program: BuildProgram): string {
  restore();
  const id = nextGeneratedId();
  generated.set(id, program);
  persist();
  return id;
}

/** Generated builds this browser still remembers, oldest first. */
export function generatedBuilds(): { id: string; name: string }[] {
  return [...generated.entries()].map(([id, program]) => ({ id, name: program.meta.name }));
}

export function isGeneratedId(id: string): boolean {
  return id.startsWith(GENERATED_PREFIX);
}

/**
 * Builds fetched from the server-side library, keyed by `lib:<uuid>`.
 *
 * Deliberately *not* persisted anywhere in the browser. A library build already has a durable
 * home — the database — so `?build=lib:<uuid>` survives a reload by being fetched again,
 * which is one mechanism instead of two and can never serve a stale copy of something the
 * user just renamed. Generated builds keep sessionStorage because they have no other home
 * until somebody saves them.
 *
 * An entry holds a program when one describes the build, and a grid when none does — see
 * `LoadedBuild.program`.
 */
type LibraryEntry =
  | { kind: 'program'; name: string; program: BuildProgram }
  | { kind: 'voxels'; name: string; grid: VoxelGrid };

const library = new Map<string, LibraryEntry>();

export const LIBRARY_PREFIX = 'lib:';

export function libraryBuildId(rowId: string): string {
  return `${LIBRARY_PREFIX}${rowId}`;
}

export function isLibraryId(id: string): boolean {
  return id.startsWith(LIBRARY_PREFIX);
}

/** The database id behind a `lib:` build id, or null if it is not one. */
export function libraryRowId(id: string): string | null {
  return isLibraryId(id) ? id.slice(LIBRARY_PREFIX.length) : null;
}

export function registerLibraryBuild(rowId: string, entry: LibraryEntry): string {
  const id = libraryBuildId(rowId);
  library.set(id, entry);
  return id;
}

/** Forget a build the user just deleted, so its id stops resolving. */
export function forgetLibraryBuild(rowId: string): void {
  library.delete(libraryBuildId(rowId));
}

function programOf(id: string): BuildProgram | undefined {
  const entry = library.get(id);
  if (entry) return entry.kind === 'program' ? entry.program : undefined;
  return PROGRAMS[id] ?? generated.get(id);
}

export function isBuildId(id: string | null): id is string {
  if (id === null) return false;
  return library.has(id) || programOf(id) !== undefined;
}

/** Read a program's declared params without expanding it — the UI needs them before a value exists. */
export function paramsOf(id: string): BuildParam[] {
  return toParams(programOf(id)?.params);
}

/** What the user has done to a build since it was generated: turned a dial, resized it. */
export interface BuildOverrides {
  params?: Readonly<Record<string, number>>;
  scale?: ScalePercent;
}

/** What a scale actually produced, once clamped to what the expander will accept. */
export interface ScaleOutcome {
  size: { x: number; y: number; z: number };
  /** True when an axis wanted to go past the engine's cap and was held back. */
  clamped: boolean;
}

/** Everything about an expansion that is not the user's doing. */
export interface ExpandBuildOptions {
  /**
   * Record which component drew each block.
   *
   * Off by default because the editor re-expands on every frame of a slider drag, and on the
   * 200k-block stress build the extra array and its measuring pass are pure waste there. The
   * guide expands once and names its steps from it, so the guide asks.
   */
  provenance?: boolean;
}

/**
 * Expand a build, optionally overriding param values and resizing it.
 *
 * Overrides are clamped here as well as inside the expander. The expander's clamp protects
 * the geometry; this one keeps `params` in the result truthful, so a hand-edited URL shows
 * the slider at the value that was actually built rather than the one that was asked for.
 */
export function expandBuild(
  id: string,
  overrides: BuildOverrides = {},
  options: ExpandBuildOptions = {},
): LoadedBuild {
  const stored = library.get(id);
  if (stored?.kind === 'voxels') return fromVoxels(id, stored.name, stored.grid);

  const program = programOf(id);
  if (!program) throw new Error(`unknown build "${id}"`);

  const applied = applyOverrides(program, overrides.params ?? {}, overrides.scale);
  const result = expand(applied, { provenance: options.provenance });

  return {
    id,
    name: applied.meta.name,
    program: applied,
    description: applied.meta.description,
    grid: result.grid,
    paletteColors: paletteColors(result.grid.palette),
    paletteFlags: paletteFlags(result.grid.palette),
    blockCount: result.blockCount,
    params: toParams(applied.params),
    warnings: result.warnings,
    errors: result.errors,
    parts: result.parts,
    origin: result.origin,
  };
}

/**
 * A build with no program, from stored voxels.
 *
 * The grid is copied on every call for the same reason `applyOverrides` copies: the editing
 * tools write straight into `grid.voxels`, so handing out the stored array would let one
 * session's edits leak into the next load of the same build — and "revert" would restore the
 * damage rather than undo it.
 */
function fromVoxels(id: string, name: string, source: VoxelGrid): LoadedBuild {
  const grid: VoxelGrid = {
    size: source.size,
    palette: [...source.palette],
    voxels: source.voxels.slice(),
  };

  let blockCount = 0;
  for (const v of grid.voxels) if (v !== 0) blockCount++;

  return {
    id,
    name,
    program: null,
    description: undefined,
    grid,
    paletteColors: paletteColors(grid.palette),
    paletteFlags: paletteFlags(grid.palette),
    blockCount,
    params: [],
    warnings: [],
    errors: [],
    // Hand-edited voxels have no program behind them, so nothing can say which component a
    // block came from. The guide falls back to naming steps by layer, which is the truth.
    parts: [],
    origin: null,
  };
}

/** Copies rather than mutates: `samples` is a shared module-level object. */
function applyOverrides(
  program: BuildProgram,
  overrides: Readonly<Record<string, number>>,
  scale: ScalePercent | undefined,
): BuildProgram {
  let next = program;

  // The scale rides along *in* the program rather than being baked into `size`. Rewriting the
  // size only grew the volume — every literal coordinate, radius and repeat stride inside the
  // program stayed where it was, which is why resizing used to move some of a build and not
  // the rest. The expander scales the coordinates themselves, and it needs the program's own
  // size to do it.
  if (isScaled(scale)) next = { ...next, scale };

  if (!next.params) return next;

  const params: Record<string, ProgramParam> = {};
  for (const [name, param] of Object.entries(next.params)) {
    const override = overrides[name];
    params[name] =
      override === undefined
        ? param
        : { ...param, value: Math.min(param.max, Math.max(param.min, Math.round(override))) };
  }
  return { ...next, params };
}

/** The size a scale would produce, and whether any axis hit the cap. Used to label the UI. */
export function previewScale(id: string, scale: ScalePercent): ScaleOutcome | null {
  const program = programOf(id);
  if (!program) return null;

  const size = scaledSize(program.size, scale);
  const wanted = {
    x: Math.round((program.size.x * scale.x) / 100),
    y: Math.round((program.size.y * scale.y) / 100),
    z: Math.round((program.size.z * scale.z) / 100),
  };
  return {
    size,
    clamped: wanted.x !== size.x || wanted.y !== size.y || wanted.z !== size.z,
  };
}

/** The program's own size, so the UI can show what 100% means. */
export function baseSize(id: string): { x: number; y: number; z: number } | null {
  return programOf(id)?.size ?? null;
}

function toParams(params: BuildProgram['params']): BuildParam[] {
  if (!params) return [];
  return Object.entries(params).map(([name, param]) => ({
    name,
    label: param.label ?? name,
    value: param.value,
    min: param.min,
    max: param.max,
  }));
}
