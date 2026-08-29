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
  applyStylePack,
  decodeVoxels,
  encodeVoxels,
  expand,
  isScaled,
  NO_SCALE,
  paletteColors,
  paletteFlags,
  samples,
  scaledSize,
  stylePackById,
  type EditLayer,
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

/**
 * Hand edits, per build id, as the overlay's storage form.
 *
 * In memory for every build — switching between samples and back keeps the edits — and
 * persisted alongside the program for generated builds, so a refresh no longer eats an
 * hour of detailing on a build that cost real money to make.
 */
const edits = new Map<string, EditLayer>();

export function editsOf(id: string): EditLayer | null {
  return edits.get(id) ?? null;
}

/** Remember (or forget, with null) the hand edits for a build. */
export function rememberEdits(id: string, layer: EditLayer | null): void {
  const had = edits.has(id);
  if (layer && layer.blocks.length > 0) edits.set(id, layer);
  else if (had) edits.delete(id);
  else return; // Nothing stored and nothing to store — skip the localStorage write.
  if (isGeneratedId(id)) persist();
}

function persist(): void {
  // Oldest first, so trimming to the cap drops the ones least likely to still be open.
  while (generated.size > MAX_STORED) {
    const oldest = generated.keys().next();
    if (oldest.done) break;
    edits.delete(oldest.value);
    generated.delete(oldest.value);
  }

  try {
    // A third tuple element only where edits exist: `restore` has always tolerated shape
    // drift, and two-element entries stay byte-identical to what older tabs wrote.
    const entries = [...generated.entries()].map(([id, program]) => {
      const layer = edits.get(id);
      return layer ? [id, program, layer] : [id, program];
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
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
    for (const [id, program, layer] of JSON.parse(raw) as [string, BuildProgram, EditLayer?][]) {
      generated.set(id, program);
      if (layer && !edits.has(id)) edits.set(id, layer);
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

// --- pictures rebuilt as blocks -----------------------------------------

/**
 * Murals: a picture mapped onto blocks, keyed by `img:<n>`.
 *
 * These are voxels and not a program, because nothing parametric describes them — a
 * photograph is not a structure with a wall thickness and a roof pitch, and pretending
 * otherwise would give the editor a size slider that could only degrade the picture. Changing
 * a mural's size means re-reading the picture at the new one, which the panel that made it
 * does far better than any resampler could.
 *
 * Stored gzipped rather than as a plain array: a 256x160 wall is 40k voxels, and JSON of that
 * would spend a quarter of the whole storage quota on one picture.
 */
const murals = new Map<string, { name: string; grid: VoxelGrid }>();

export const MURAL_PREFIX = 'img:';

const MURAL_STORAGE_KEY = 'craftmagic.murals';
/**
 * How many pictures are kept between visits.
 *
 * Small on purpose. Each one is tens of kilobytes even compressed, they are seconds of work to
 * rebuild from the original picture, and the durable home for one worth keeping is the
 * library — same as any other build.
 */
const MAX_STORED_MURALS = 4;

export function isMuralId(id: string): boolean {
  return id.startsWith(MURAL_PREFIX);
}

function persistMurals(): void {
  while (murals.size > MAX_STORED_MURALS) {
    const oldest = murals.keys().next();
    if (oldest.done) break;
    murals.delete(oldest.value);
  }

  try {
    const stored = [...murals.entries()].map(([id, entry]) => [
      id,
      entry.name,
      base64FromBytes(encodeVoxels(entry.grid)),
    ]);
    localStorage.setItem(MURAL_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Out of quota, or storage blocked. The picture is still on screen; it just will not
    // survive a reload, which is a far better outcome than refusing to build it.
  }
}

function restoreMurals(): void {
  try {
    const raw = localStorage.getItem(MURAL_STORAGE_KEY);
    if (!raw) return;
    for (const [id, name, encoded] of JSON.parse(raw) as [string, string, string][]) {
      murals.set(id, { name, grid: decodeVoxels(bytesFromBase64(encoded)) });
    }
  } catch {
    // One unreadable picture must not stop the editor from loading.
  }
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: `String.fromCharCode(...bytes)` on a 40k-block grid overflows the argument list.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function bytesFromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Remember a picture built out of blocks, and return the id that selects it. */
export function registerMuralBuild(name: string, grid: VoxelGrid): string {
  restoreMurals();

  let highest = 0;
  for (const id of murals.keys()) {
    const n = Number.parseInt(id.slice(MURAL_PREFIX.length), 10);
    if (Number.isFinite(n) && n > highest) highest = n;
  }

  const id = `${MURAL_PREFIX}${highest + 1}`;
  murals.set(id, { name, grid });
  persistMurals();
  return id;
}

/** Pictures this browser still remembers, oldest first. */
export function muralBuilds(): { id: string; name: string }[] {
  return [...murals.entries()].map(([id, entry]) => ({ id, name: entry.name }));
}

// Below the store it fills, not beside the one above: called any earlier this runs inside
// `murals`' temporal dead zone, and the ReferenceError disappears into its own catch — which
// looks exactly like "there was nothing saved".
restoreMurals();

// --- imported schematics ------------------------------------------------

/**
 * Builds imported from `.schem` files, keyed by `schem:<n>`.
 *
 * Voxels, not a program — a schematic is a finished object with no recipe — stored exactly
 * the way murals are and for the same reasons: gzipped, capped, and with the library as the
 * durable home for one worth keeping. A separate store rather than a flag on murals because
 * the picker labels them differently and the caps should not fight each other.
 */
const imports = new Map<string, { name: string; grid: VoxelGrid }>();

export const IMPORT_PREFIX = 'schem:';

const IMPORT_STORAGE_KEY = 'craftmagic.imports';
const MAX_STORED_IMPORTS = 6;

export function isImportedId(id: string): boolean {
  return id.startsWith(IMPORT_PREFIX);
}

function persistImports(): void {
  while (imports.size > MAX_STORED_IMPORTS) {
    const oldest = imports.keys().next();
    if (oldest.done) break;
    imports.delete(oldest.value);
  }
  try {
    const stored = [...imports.entries()].map(([id, entry]) => [
      id,
      entry.name,
      base64FromBytes(encodeVoxels(entry.grid)),
    ]);
    localStorage.setItem(IMPORT_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Out of quota, or storage blocked. The import still works for this page view.
  }
}

function restoreImports(): void {
  try {
    const raw = localStorage.getItem(IMPORT_STORAGE_KEY);
    if (!raw) return;
    for (const [id, name, encoded] of JSON.parse(raw) as [string, string, string][]) {
      imports.set(id, { name, grid: decodeVoxels(bytesFromBase64(encoded)) });
    }
  } catch {
    // One unreadable file must not stop the editor from loading.
  }
}

/** Remember an imported schematic, and return the id that selects it. */
export function registerImportedBuild(name: string, grid: VoxelGrid): string {
  restoreImports();
  let highest = 0;
  for (const id of imports.keys()) {
    const n = Number.parseInt(id.slice(IMPORT_PREFIX.length), 10);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  const id = `${IMPORT_PREFIX}${highest + 1}`;
  imports.set(id, { name, grid });
  persistImports();
  return id;
}

/** Imported schematics this browser still remembers, oldest first. */
export function importedBuilds(): { id: string; name: string }[] {
  return [...imports.entries()].map(([id, entry]) => ({ id, name: entry.name }));
}

restoreImports();

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
  return library.has(id) || murals.has(id) || imports.has(id) || programOf(id) !== undefined;
}

/** Read a program's declared params without expanding it — the UI needs them before a value exists. */
export function paramsOf(id: string): BuildParam[] {
  return toParams(programOf(id)?.params);
}

/** What the user has done to a build since it was generated: turned a dial, resized it. */
export interface BuildOverrides {
  params?: Readonly<Record<string, number>>;
  scale?: ScalePercent;
  /**
   * A style pack id, restyling the palette without touching the program.
   *
   * An unknown id is ignored rather than refused, for the same reason an unknown size is: it
   * changes how the build looks, not whether it is valid, and a stale link should degrade to
   * the build's own materials rather than to an error.
   */
  style?: string | null;
  /**
   * Component paths (`components[3]`, `components[1].children[0]`) to leave out of the
   * expansion — the outliner's hide. A path that no longer matches anything is a no-op.
   */
  hide?: readonly string[];
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

  // A picture is voxels and nothing else, so params and scale have nothing to act on here.
  const mural = murals.get(id);
  if (mural) return fromVoxels(id, mural.name, mural.grid);

  // Same for an imported schematic: a finished object, no recipe.
  const imported = imports.get(id);
  if (imported) return fromVoxels(id, imported.name, imported.grid);

  const program = programOf(id);
  if (!program) throw new Error(`unknown build "${id}"`);

  let applied = applyOverrides(program, overrides.params ?? {}, overrides.scale);
  // The restyle happens on the *applied* program and is never written back anywhere: the
  // program stays the source of truth in its own materials, and the pack rides in the URL
  // exactly as the scale does.
  const pack = stylePackById(overrides.style);
  if (pack) applied = applyStylePack(applied, pack);
  if (overrides.hide && overrides.hide.length > 0) applied = hideComponents(applied, overrides.hide);
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

/**
 * A program without the components at the given paths.
 *
 * Paths are the expander's own (`components[3].children[0]`), so what the outliner shows and
 * what this removes are one vocabulary. Repeat transforms collapse in provenance, which
 * means hiding a repeated part hides every repetition — exactly what the eye icon promises.
 */
function hideComponents(program: BuildProgram, paths: readonly string[]): BuildProgram {
  const hidden = new Set(paths);
  type AnyComponent = BuildProgram['components'][number];
  const filterList = (list: readonly AnyComponent[], prefix: string): AnyComponent[] =>
    list
      .map((component, index) => ({ component, path: `${prefix}[${index}]` }))
      .filter(({ path }) => !hidden.has(path))
      .map(({ component, path }) =>
        component.type === 'group' && Array.isArray(component.children)
          ? { ...component, children: filterList(component.children, `${path}.children`) }
          : component,
      );
  return { ...program, components: filterList(program.components, 'components') };
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
  // An explicit 100% is a real answer, not the absence of one: a generated build carries the
  // scale it was fitted to, and dragging the slider back to 100 has to take that off again
  // rather than being read as "no opinion" and leaving the build shrunk.
  if (isScaled(scale)) next = { ...next, scale };
  else if (scale && next.scale) {
    const { scale: _fitted, ...rest } = next;
    next = rest as BuildProgram;
  }

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

/**
 * The size a build was generated at, as a percentage of its own program.
 *
 * A generated program carries a scale when the user asked for a build smaller than the design
 * the model wrote: the structure is described at full detail and the scale is what brings it
 * down to the size that was asked for. The editor seeds its size control from this, so the
 * slider opens on the build's real size and dragging it to 100% shows the design at the size
 * it was actually designed at.
 */
export function programScale(id: string): ScalePercent | null {
  const scale = programOf(id)?.scale;
  return isScaled(scale) ? scale : null;
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
