/**
 * Build programs → something the viewer can draw.
 *
 * The whole point of the IR is that a program is re-expanded rather than edited, so this
 * module is deliberately stateless: change a param, call `expandBuild` again, get a fresh
 * grid. That is what makes the resize slider a real feature demo rather than a stretch —
 * walls stay walls because every coordinate is re-derived from the new param value.
 *
 * `paletteColors`/`paletteFlags` are the seam that keeps the renderer independent of
 * Minecraft: from here down, the mesher only ever sees colours and flag bytes.
 */

import {
  expand,
  paletteColors,
  paletteFlags,
  samples,
  type BuildProgram,
  type ExpandIssue,
  type ProgramParam,
  type VoxelGrid,
} from '@imaginecraft/core';

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

const PROGRAMS: Record<string, BuildProgram> = {
  cottage: samples.cottage!,
  tower: samples.tower!,
  pavilion: samples.pavilion!,
  field: towerField,
};

/** The built-in samples, in picker order. Generated builds are tracked separately. */
export const BUILD_IDS = Object.keys(PROGRAMS);

/**
 * Programs that arrived from the generator this session.
 *
 * Registering them here rather than treating them as a separate kind of thing is what lets a
 * generated build behave exactly like a sample: same expander, same meshing path, and — the
 * point — the same live param sliders, because the server returns the *program* and the
 * browser expands it.
 */
const generated = new Map<string, BuildProgram>();

export const GENERATED_PREFIX = 'gen:';

/**
 * Generated builds survive a reload.
 *
 * Every one of these cost real money, so losing them to an accidental refresh is worse than
 * the small complexity of persisting them. sessionStorage rather than localStorage: they are
 * scoped to this tab's session until builds are properly saved server-side (M5).
 */
const STORAGE_KEY = 'imaginecraft.generated';

function persist(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...generated.entries()]));
  } catch {
    // Storage full or blocked; the build still works for this page view.
  }
}

function restore(): void {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    for (const [id, program] of JSON.parse(raw) as [string, BuildProgram][]) {
      generated.set(id, program);
    }
  } catch {
    // A corrupt entry must not stop the editor from loading.
  }
}

restore();

export function registerGeneratedBuild(program: BuildProgram): string {
  const id = `${GENERATED_PREFIX}${generated.size + 1}`;
  generated.set(id, program);
  persist();
  return id;
}

/** Generated builds from this session, newest last. */
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

/**
 * Expand a build, optionally overriding param values.
 *
 * Overrides are clamped here as well as inside the expander. The expander's clamp protects
 * the geometry; this one keeps `params` in the result truthful, so a hand-edited URL shows
 * the slider at the value that was actually built rather than the one that was asked for.
 */
export function expandBuild(id: string, overrides: Readonly<Record<string, number>> = {}): LoadedBuild {
  const stored = library.get(id);
  if (stored?.kind === 'voxels') return fromVoxels(id, stored.name, stored.grid);

  const program = programOf(id);
  if (!program) throw new Error(`unknown build "${id}"`);

  const applied = applyOverrides(program, overrides);
  const result = expand(applied);

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
  };
}

/** Copies rather than mutates: `samples` is a shared module-level object. */
function applyOverrides(
  program: BuildProgram,
  overrides: Readonly<Record<string, number>>,
): BuildProgram {
  if (!program.params) return program;

  const params: Record<string, ProgramParam> = {};
  for (const [name, param] of Object.entries(program.params)) {
    const override = overrides[name];
    params[name] =
      override === undefined
        ? param
        : { ...param, value: Math.min(param.max, Math.max(param.min, Math.round(override))) };
  }
  return { ...program, params };
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
