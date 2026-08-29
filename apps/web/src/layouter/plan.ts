/**
 * The layout document.
 *
 * The layouter is a floorplan tool, so its document is a plan rather than a grid: a stack of
 * storeys, each holding rooms, partitions, apertures and vertical circulation, all in whole
 * blocks. Nothing here knows about voxels — `compile.ts` turns a plan into a `BuildProgram`
 * and the ordinary CraftMagic expander turns that into blocks. Keeping the plan as the source
 * of truth is what makes the tool worth having: a wall you drew stays a wall you can move,
 * re-skin or delete, instead of becoming a smear of voxels the moment it is drawn.
 *
 * Shape and vocabulary follow the level editor engine this is ported from
 * (`src/customMaps/schema.js` in flyvendedk799/firstpgame): a versioned document, `normalize`
 * for anything arriving from disk or another tab, `create*` for anything new, and ids minted
 * with a short prefix so a serialized plan reads. That engine's map is a single ground plane
 * of placed prefabs; the change made here is that a plan is a *stack* of storeys, because
 * indoor architecture is the thing this tool is for and one floor is not architecture.
 *
 * Every coordinate is an integer block coordinate in plan space: +x east, +z south, matching
 * Minecraft and the IR. Rectangles are min-corner plus size, both in blocks, so a 5×4 room at
 * (10, 12) covers x 10–14 and z 12–15 inclusive. Nothing is stored in floats: half a block is
 * not a thing you can build.
 */

import type { Face } from '@craftmagic/core';

export const PLAN_VERSION = 1;

/** Kinds of thing that can sit on a storey. */
export type ItemKind =
  | 'room'
  | 'wall'
  | 'door'
  | 'window'
  | 'stair'
  | 'opening'
  | 'platform'
  | 'column';

/** Min corner plus size, in blocks. `w` runs along x, `d` along z. */
export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

/** The horizontal run of a wall-ish thing. `x` means it runs east–west. */
export type PlanAxis = 'x' | 'z';

/**
 * An enclosed space: a floor slab and a ring of wall around it.
 *
 * The rect is the room's *outer* footprint, walls included, because that is what someone
 * drawing a plan is thinking about — the line on the paper is the wall. Two rooms whose rects
 * overlap by the wall thickness therefore share one wall rather than growing two, which is
 * what `snapRoomRect` in `geometry.ts` nudges a drag towards.
 */
export interface RoomItem {
  kind: 'room';
  id: string;
  rect: Rect;
  label: string;
  /** Palette role for the wall ring. Defaults to the kit's primary. */
  wallRole?: string;
  /** Palette role for the slab. Defaults to the kit's floor. */
  floorRole?: string;
  /** Off for a room that should open onto the storey below — a void, a light well. */
  slab: boolean;
}

/** A free-standing partition: a run of wall not tied to any room's perimeter. */
export interface WallItem {
  kind: 'wall';
  id: string;
  axis: PlanAxis;
  /** Min corner of the run. Thickness comes from the plan. */
  x: number;
  z: number;
  /** Blocks along `axis`. */
  length: number;
  role?: string;
}

/**
 * A doorway through a wall.
 *
 * `x`/`z` is the min corner of the opening and `facing` is the direction the door faces,
 * which also says which way the wall runs: a north- or south-facing door sits in a wall
 * running east–west. The opening is cut through the full wall thickness at compile time, so a
 * door placed on a shared two-room wall works without the user thinking about thickness.
 */
export interface DoorItem {
  kind: 'door';
  id: string;
  x: number;
  z: number;
  facing: Face;
  width: 1 | 2;
  height: 2 | 3;
  /** A doorway with no door in it — an archway between two rooms. */
  open: boolean;
}

/** A glazed opening in a wall, at a sill height above the storey's floor. */
export interface WindowItem {
  kind: 'window';
  id: string;
  axis: PlanAxis;
  x: number;
  z: number;
  /** Blocks along `axis`. */
  length: number;
  /** Blocks above the walking surface. */
  sill: number;
  /** Blocks tall. */
  height: number;
}

/**
 * A staircase climbing from this storey to the one above.
 *
 * One item, not two: the run, the well it needs in the slab above and the headroom are all
 * consequences of the same decision, and making the user cut their own stairwell is the kind
 * of bookkeeping a layout tool exists to remove.
 */
export interface StairItem {
  kind: 'stair';
  id: string;
  x: number;
  z: number;
  /** The direction of travel going up. */
  facing: Face;
  /** Blocks across the run. */
  width: number;
}

/** A hole in this storey's slab: an atrium, a mezzanine edge, a hatch. */
export interface OpeningItem {
  kind: 'opening';
  id: string;
  rect: Rect;
}

/** A raised floor inside a storey — a dais, a split level, a stage. */
export interface PlatformItem {
  kind: 'platform';
  id: string;
  rect: Rect;
  /** Blocks above the storey's walking surface. */
  raise: number;
  role?: string;
}

/** A structural post, full storey height. */
export interface ColumnItem {
  kind: 'column';
  id: string;
  x: number;
  z: number;
  /** Square, in blocks. */
  size: number;
  role?: string;
}

export type PlanItem =
  | RoomItem
  | WallItem
  | DoorItem
  | WindowItem
  | StairItem
  | OpeningItem
  | PlatformItem
  | ColumnItem;

export interface Floor {
  id: string;
  name: string;
  items: PlanItem[];
}

export type RoofStyle = 'flat' | 'gable' | 'hip' | 'none';

/** How steeply a pitched roof climbs: rise ≈ span/4, span/2, or span. */
export type RoofPitch = 'low' | 'classic' | 'steep';

export interface LayoutPlan {
  version: typeof PLAN_VERSION;
  id: string;
  name: string;
  /** The buildable plot, in blocks. Everything is clamped to it. */
  site: { x: number; z: number };
  /**
   * Slab plus clear height, in blocks. A storey of 5 gives a 4-block ceiling, which is the
   * smallest that does not feel like a crawlspace once furniture is in.
   */
  storeyHeight: number;
  wallThickness: number;
  /** Blocks of plinth below the ground floor slab. Zero sits the building straight on grade. */
  foundation: number;
  roof: RoofStyle;
  /** Only meaningful for gable and hip. Older plans have no field and read as 'classic'. */
  roofPitch: RoofPitch;
  /** Eave projection past the wall, 0–2 blocks. */
  roofOverhang: number;
  kitId: string;
  floors: Floor[];
  updatedAt: string;
}

export const LIMITS = {
  minSite: 16,
  maxSite: 192,
  minStorey: 3,
  maxStorey: 16,
  maxWallThickness: 3,
  maxFoundation: 8,
  maxFloors: 12,
  /** Guards a plan file from another tab or a hand-edited import. */
  maxItemsPerFloor: 400,
} as const;

let idCounter = 0;

/**
 * A readable, collision-proof id.
 *
 * Time plus a counter rather than `Math.random`, so a plan serialized in a test is stable
 * enough to assert on and two items minted in the same millisecond still differ.
 */
export function planId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const FACES: Face[] = ['north', 'south', 'east', 'west'];

export function isFace(value: unknown): value is Face {
  return typeof value === 'string' && (FACES as string[]).includes(value);
}

/** The axis a wall runs along, for a door or window that faces `face`. */
export function axisForFace(face: Face): PlanAxis {
  return face === 'north' || face === 'south' ? 'x' : 'z';
}

export function createRoom(rect: Rect, options: Partial<RoomItem> = {}): RoomItem {
  return normalizeItem({ kind: 'room', id: planId('room'), rect, label: '', slab: true, ...options }) as RoomItem;
}

export function createWall(
  axis: PlanAxis,
  x: number,
  z: number,
  length: number,
  options: Partial<WallItem> = {},
): WallItem {
  return normalizeItem({ kind: 'wall', id: planId('wall'), axis, x, z, length, ...options }) as WallItem;
}

export function createDoor(x: number, z: number, facing: Face, options: Partial<DoorItem> = {}): DoorItem {
  return normalizeItem({
    kind: 'door',
    id: planId('door'),
    x,
    z,
    facing,
    width: 1,
    height: 2,
    open: false,
    ...options,
  }) as DoorItem;
}

export function createWindow(
  axis: PlanAxis,
  x: number,
  z: number,
  options: Partial<WindowItem> = {},
): WindowItem {
  return normalizeItem({
    kind: 'window',
    id: planId('win'),
    axis,
    x,
    z,
    length: 2,
    sill: 1,
    height: 2,
    ...options,
  }) as WindowItem;
}

export function createStair(x: number, z: number, facing: Face, options: Partial<StairItem> = {}): StairItem {
  return normalizeItem({ kind: 'stair', id: planId('stair'), x, z, facing, width: 2, ...options }) as StairItem;
}

export function createOpening(rect: Rect, options: Partial<OpeningItem> = {}): OpeningItem {
  return normalizeItem({ kind: 'opening', id: planId('void'), rect, ...options }) as OpeningItem;
}

export function createPlatform(rect: Rect, options: Partial<PlatformItem> = {}): PlatformItem {
  return normalizeItem({ kind: 'platform', id: planId('plat'), rect, raise: 1, ...options }) as PlatformItem;
}

export function createColumn(x: number, z: number, options: Partial<ColumnItem> = {}): ColumnItem {
  return normalizeItem({ kind: 'column', id: planId('col'), x, z, size: 1, ...options }) as ColumnItem;
}

export function createFloor(name: string, items: PlanItem[] = []): Floor {
  return { id: planId('floor'), name, items };
}

/** The name a storey gets from its index — the convention every floor selector uses. */
export function floorName(index: number): string {
  if (index === 0) return 'Ground floor';
  return `Floor ${index}`;
}

export function createPlan(options: Partial<LayoutPlan> = {}): LayoutPlan {
  return normalizePlan({
    version: PLAN_VERSION,
    id: planId('plan'),
    name: 'Untitled layout',
    site: { x: 48, z: 48 },
    storeyHeight: 5,
    wallThickness: 1,
    foundation: 1,
    roof: 'gable',
    roofPitch: 'classic',
    roofOverhang: 1,
    kitId: 'oak-cottage',
    floors: [createFloor(floorName(0))],
    updatedAt: new Date().toISOString(),
    ...options,
  });
}

function normalizeRect(raw: unknown, site: { x: number; z: number }): Rect {
  const r = (raw ?? {}) as Partial<Rect>;
  const x = clampInt(r.x, 0, Math.max(0, site.x - 1), 0);
  const z = clampInt(r.z, 0, Math.max(0, site.z - 1), 0);
  return {
    x,
    z,
    w: clampInt(r.w, 1, Math.max(1, site.x - x), 1),
    d: clampInt(r.d, 1, Math.max(1, site.z - z), 1),
  };
}

const DEFAULT_SITE = { x: LIMITS.maxSite, z: LIMITS.maxSite };

/**
 * Coerce one item into something the compiler can trust.
 *
 * Anything unrecognised returns null rather than throwing: a plan is loaded from localStorage
 * and from files people pass around, and one unknown item from a future version must cost
 * that item, not the whole layout.
 */
export function normalizeItem(raw: unknown, site: { x: number; z: number } = DEFAULT_SITE): PlanItem | null {
  const item = (raw ?? {}) as Record<string, unknown> & { kind?: string };
  const id = typeof item.id === 'string' && item.id ? item.id : planId('item');

  switch (item.kind) {
    case 'room':
      return {
        kind: 'room',
        id,
        rect: normalizeRect(item.rect, site),
        label: typeof item.label === 'string' ? item.label.slice(0, 40) : '',
        wallRole: optionalRole(item.wallRole),
        floorRole: optionalRole(item.floorRole),
        slab: item.slab !== false,
      };

    case 'wall': {
      const axis: PlanAxis = item.axis === 'z' ? 'z' : 'x';
      const x = clampInt(item.x, 0, site.x - 1, 0);
      const z = clampInt(item.z, 0, site.z - 1, 0);
      const span = axis === 'x' ? site.x - x : site.z - z;
      return {
        kind: 'wall',
        id,
        axis,
        x,
        z,
        length: clampInt(item.length, 1, Math.max(1, span), 1),
        role: optionalRole(item.role),
      };
    }

    case 'door':
      return {
        kind: 'door',
        id,
        x: clampInt(item.x, 0, site.x - 1, 0),
        z: clampInt(item.z, 0, site.z - 1, 0),
        facing: isFace(item.facing) ? item.facing : 'south',
        width: item.width === 2 ? 2 : 1,
        height: item.height === 3 ? 3 : 2,
        open: item.open === true,
      };

    case 'window': {
      const axis: PlanAxis = item.axis === 'z' ? 'z' : 'x';
      const x = clampInt(item.x, 0, site.x - 1, 0);
      const z = clampInt(item.z, 0, site.z - 1, 0);
      const span = axis === 'x' ? site.x - x : site.z - z;
      return {
        kind: 'window',
        id,
        axis,
        x,
        z,
        length: clampInt(item.length, 1, Math.max(1, span), 2),
        sill: clampInt(item.sill, 0, LIMITS.maxStorey, 1),
        height: clampInt(item.height, 1, LIMITS.maxStorey, 2),
      };
    }

    case 'stair':
      return {
        kind: 'stair',
        id,
        x: clampInt(item.x, 0, site.x - 1, 0),
        z: clampInt(item.z, 0, site.z - 1, 0),
        facing: isFace(item.facing) ? item.facing : 'south',
        width: clampInt(item.width, 1, 6, 2),
      };

    case 'opening':
      return { kind: 'opening', id, rect: normalizeRect(item.rect, site) };

    case 'platform':
      return {
        kind: 'platform',
        id,
        rect: normalizeRect(item.rect, site),
        raise: clampInt(item.raise, 1, LIMITS.maxStorey - 1, 1),
        role: optionalRole(item.role),
      };

    case 'column':
      return {
        kind: 'column',
        id,
        x: clampInt(item.x, 0, site.x - 1, 0),
        z: clampInt(item.z, 0, site.z - 1, 0),
        size: clampInt(item.size, 1, 4, 1),
        role: optionalRole(item.role),
      };

    default:
      return null;
  }
}

function optionalRole(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 40) : undefined;
}

export function normalizeFloor(raw: unknown, index: number, site: { x: number; z: number }): Floor {
  const floor = (raw ?? {}) as Partial<Floor>;
  const items = Array.isArray(floor.items) ? floor.items : [];
  return {
    id: typeof floor.id === 'string' && floor.id ? floor.id : planId('floor'),
    name: typeof floor.name === 'string' && floor.name.trim() ? floor.name.slice(0, 40) : floorName(index),
    items: items
      .slice(0, LIMITS.maxItemsPerFloor)
      .map((item) => normalizeItem(item, site))
      .filter((item): item is PlanItem => item !== null),
  };
}

/**
 * Coerce a whole plan.
 *
 * Called on everything that did not come from this module: autosave, an imported file, a plan
 * another tab wrote. The site is resolved first because every item is clamped against it, so
 * a plan claiming a 4000-block site cannot smuggle in coordinates the compiler would then
 * have to defend against.
 */
export function normalizePlan(raw: unknown): LayoutPlan {
  const plan = (raw ?? {}) as Partial<LayoutPlan>;
  const site = {
    x: clampInt(plan.site?.x, LIMITS.minSite, LIMITS.maxSite, 48),
    z: clampInt(plan.site?.z, LIMITS.minSite, LIMITS.maxSite, 48),
  };

  const floors = (Array.isArray(plan.floors) ? plan.floors : [])
    .slice(0, LIMITS.maxFloors)
    .map((floor, index) => normalizeFloor(floor, index, site));

  return {
    version: PLAN_VERSION,
    id: typeof plan.id === 'string' && plan.id ? plan.id : planId('plan'),
    name: typeof plan.name === 'string' && plan.name.trim() ? plan.name.slice(0, 60) : 'Untitled layout',
    site,
    storeyHeight: clampInt(plan.storeyHeight, LIMITS.minStorey, LIMITS.maxStorey, 5),
    wallThickness: clampInt(plan.wallThickness, 1, LIMITS.maxWallThickness, 1),
    foundation: clampInt(plan.foundation, 0, LIMITS.maxFoundation, 1),
    roof: (['flat', 'gable', 'hip', 'none'] as const).includes(plan.roof as RoofStyle)
      ? (plan.roof as RoofStyle)
      : 'gable',
    roofPitch: (['low', 'classic', 'steep'] as const).includes(plan.roofPitch as RoofPitch)
      ? (plan.roofPitch as RoofPitch)
      : 'classic',
    roofOverhang: clampInt(plan.roofOverhang, 0, 2, 1),
    kitId: typeof plan.kitId === 'string' && plan.kitId ? plan.kitId : 'oak-cottage',
    floors: floors.length > 0 ? floors : [createFloor(floorName(0))],
    updatedAt: typeof plan.updatedAt === 'string' ? plan.updatedAt : new Date().toISOString(),
  };
}

/** Find an item anywhere in the plan, with the storey it sits on. */
export function findItem(plan: LayoutPlan, id: string): { floorIndex: number; item: PlanItem } | null {
  for (let i = 0; i < plan.floors.length; i++) {
    const item = plan.floors[i]!.items.find((entry) => entry.id === id);
    if (item) return { floorIndex: i, item };
  }
  return null;
}

/** Replace one item in place, returning a new plan. Unknown ids leave the plan alone. */
export function replaceItem(plan: LayoutPlan, id: string, next: PlanItem): LayoutPlan {
  return {
    ...plan,
    floors: plan.floors.map((floor) => ({
      ...floor,
      items: floor.items.map((item) => (item.id === id ? next : item)),
    })),
  };
}

export function removeItem(plan: LayoutPlan, id: string): LayoutPlan {
  return {
    ...plan,
    floors: plan.floors.map((floor) => ({
      ...floor,
      items: floor.items.filter((item) => item.id !== id),
    })),
  };
}

export function addItem(plan: LayoutPlan, floorIndex: number, item: PlanItem): LayoutPlan {
  return {
    ...plan,
    floors: plan.floors.map((floor, index) =>
      index === floorIndex
        ? { ...floor, items: [...floor.items, item].slice(0, LIMITS.maxItemsPerFloor) }
        : floor,
    ),
  };
}

/** Every item on the plan, paired with its storey index. */
export function allItems(plan: LayoutPlan): { floorIndex: number; item: PlanItem }[] {
  return plan.floors.flatMap((floor, floorIndex) => floor.items.map((item) => ({ floorIndex, item })));
}

export function countItems(plan: LayoutPlan): number {
  return plan.floors.reduce((sum, floor) => sum + floor.items.length, 0);
}
