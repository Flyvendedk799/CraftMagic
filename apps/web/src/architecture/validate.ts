/**
 * Does this layout work as a building?
 *
 * Ported in spirit from `customMapValidation.js` in the level editor engine
 * (flyvendedk799/firstpgame), whose best idea is that a level is not valid because its JSON
 * parses — it is valid because a player can actually walk from the spawn to the exit. It
 * proves that by rasterising the walls into a nav grid and flood-filling through the doors.
 *
 * The same question is the one an indoor layout has to answer, and it is the one a 3D preview
 * is worst at: a sealed-off room looks perfectly good from the outside, and a first floor with
 * no stair to it looks like a first floor. So the checks below are mostly about *circulation*
 * — every room reachable from an entrance, every storey reachable from the one below — with
 * the geometric checks (an aperture floating in mid-air, a room with no interior) alongside.
 *
 * Nothing here blocks a build. An error is a statement that the building does not work, not a
 * refusal to compile it: half-drawn layouts are the normal state of a layout in progress, and
 * a tool that refused to show them would be unusable.
 */

import { floorHeight, type LayoutPlan, type PlanItem, type Rect, type RoomItem } from './plan.js';
import {
  containsRect,
  intersectRect,
  itemFootprint,
  overlapArea,
  rectBottom,
  rectRight,
  runFootprint,
  stairFootprint,
  wallRuns,
} from './geometry.js';

export type IssueLevel = 'error' | 'warning' | 'info';

export interface PlanIssue {
  level: IssueLevel;
  /** Stable enough to test against and to key a list by. */
  code: string;
  message: string;
  floorIndex?: number;
  /** The item to select when the issue is clicked. */
  itemId?: string;
}

export interface ValidationResult {
  issues: PlanIssue[];
  /** Ids of rooms nothing can walk to. Drawn hatched on the canvas. */
  unreachable: Set<string>;
  /** Rooms per storey, for the readout. */
  roomCount: number;
}

export function validatePlan(plan: LayoutPlan): ValidationResult {
  const issues: PlanIssue[] = [];
  const unreachable = new Set<string>();
  let roomCount = 0;

  for (let index = 0; index < plan.floors.length; index++) {
    const floor = plan.floors[index]!;
    const items = floor.items;
    const rooms = items.filter((item): item is RoomItem => item.kind === 'room');
    roomCount += rooms.length;
    const runs = wallRuns(items, plan.wallThickness);

    if (items.length === 0) {
      issues.push({
        level: 'info',
        code: 'empty_floor',
        message: `${floor.name} is empty.`,
        floorIndex: index,
      });
    }

    for (const room of rooms) {
      const inset = interiorRect(room, plan.wallThickness);
      if (!inset) {
        issues.push({
          level: 'warning',
          code: 'room_solid',
          message: `${label(room)} is ${room.rect.w}×${room.rect.d}, too small to have an inside once its walls are built.`,
          floorIndex: index,
          itemId: room.id,
        });
      }

      for (const other of rooms) {
        if (other.id <= room.id) continue;
        const shared = intersectRect(room.rect, other.rect);
        if (!shared) continue;
        // A room wholly inside another is a service core, not a mistake, and it builds
        // correctly: the inner walls are painted after the outer floor.
        if (containsRect(room.rect, other.rect) || containsRect(other.rect, room.rect)) continue;
        // Two rooms placed side by side share exactly a wall's worth of footprint — that is
        // what the edge snapping produces and what makes them share one wall. An overlap
        // thicker than a wall in *both* directions is one room eating into another, which
        // builds as masonry through the middle of a space.
        if (Math.min(shared.w, shared.d) > plan.wallThickness) {
          issues.push({
            level: 'warning',
            code: 'rooms_overlap',
            message: `${label(room)} and ${label(other)} overlap by ${shared.w}×${shared.d} blocks — one of them will be built through the other.`,
            floorIndex: index,
            itemId: room.id,
          });
        }
      }
    }

    for (const item of items) {
      if (item.kind === 'door' || item.kind === 'window') {
        const footprint = itemFootprint(item, plan.wallThickness, floorHeight(plan, index));
        if (!runs.some((run) => overlapArea(runFootprint(run), footprint) > 0)) {
          issues.push({
            level: 'error',
            code: item.kind === 'door' ? 'door_floating' : 'window_floating',
            message: `A ${item.kind} on ${floor.name} is not in a wall — it will be a hole in mid-air.`,
            floorIndex: index,
            itemId: item.id,
          });
        }
      }

      if (item.kind === 'window' && item.sill + item.height > floorHeight(plan, index) - 1) {
        issues.push({
          level: 'warning',
          code: 'window_tall',
          message: `A window on ${floor.name} reaches above the ceiling and will be cut off.`,
          floorIndex: index,
          itemId: item.id,
        });
      }

      if (item.kind === 'door' && item.height > floorHeight(plan, index) - 1) {
        issues.push({
          level: 'warning',
          code: 'door_tall',
          message: `A door on ${floor.name} is taller than the storey and will be cut off.`,
          floorIndex: index,
          itemId: item.id,
        });
      }

      if (item.kind === 'stair') {
        const run = stairFootprint(item.x, item.z, item.facing, item.width, floorHeight(plan, index));
        if (run.x < 0 || run.z < 0 || rectRight(run) > plan.site.x || rectBottom(run) > plan.site.z) {
          issues.push({
            level: 'error',
            code: 'stair_offsite',
            message: `A staircase on ${floor.name} runs off the edge of the site. Turn it, or move it inwards.`,
            floorIndex: index,
            itemId: item.id,
          });
        }
        if (index === plan.floors.length - 1 && plan.roof !== 'none') {
          issues.push({
            level: 'warning',
            code: 'stair_to_roof',
            message: `A staircase on ${floor.name} climbs into the roof. Add a storey, or set the roof to open.`,
            floorIndex: index,
            itemId: item.id,
          });
        }
      }
    }

    // A storey nothing climbs to is the mistake this tool exists to catch: it looks entirely
    // finished in plan and in the 3D preview, and is a sealed box in the world.
    if (index > 0) {
      const below = plan.floors[index - 1]!.items;
      if (!below.some((item) => item.kind === 'stair')) {
        issues.push({
          level: 'error',
          code: 'floor_unreachable',
          message: `Nothing climbs to ${floor.name} — ${plan.floors[index - 1]!.name} has no staircase.`,
          floorIndex: index - 1,
        });
      }
    }
  }

  const ground = plan.floors[0];
  if (ground && ground.items.some((item) => item.kind === 'room')) {
    const doors = ground.items.filter((item) => item.kind === 'door');
    if (doors.length === 0) {
      issues.push({
        level: 'error',
        code: 'no_entrance',
        message: 'The building has no door on the ground floor — there is no way in.',
        floorIndex: 0,
      });
    } else {
      for (const room of reachabilityCheck(plan)) {
        unreachable.add(room.item.id);
        issues.push({
          level: 'warning',
          code: 'room_unreachable',
          message: `${label(room.item)} cannot be walked to from any door.`,
          floorIndex: room.floorIndex,
          itemId: room.item.id,
        });
      }
    }
  }

  return { issues, unreachable, roomCount };
}

function label(room: RoomItem): string {
  return room.label.trim() || `The ${room.rect.w}×${room.rect.d} room`;
}

/** The walkable inside of a room, or null when its walls meet in the middle. */
export function interiorRect(room: RoomItem, thickness: number): Rect | null {
  const t = Math.max(1, Math.min(thickness, Math.floor(Math.min(room.rect.w, room.rect.d) / 2) || 1));
  const w = room.rect.w - t * 2;
  const d = room.rect.d - t * 2;
  if (w < 1 || d < 1) return null;
  return { x: room.rect.x + t, z: room.rect.z + t, w, d };
}

interface FoundRoom {
  floorIndex: number;
  item: RoomItem;
}

/**
 * Which rooms you cannot walk to.
 *
 * The nav grid is the level editor engine's trick, at block resolution rather than half-metre
 * cells: rasterise every wall and column as blocked, punch the doorways back open, then flood
 * fill from the entrance. A room is reachable if any of its interior cells were visited.
 *
 * Storeys chain through staircases. After a floor is filled, every staircase whose foot was
 * reached seeds the floor above at its landing, and that floor is filled in turn. Windows are
 * never openings — you do not get to the sealed room through the glass.
 */
function reachabilityCheck(plan: LayoutPlan): FoundRoom[] {
  const { x: width, z: depth } = plan.site;
  const cells = width * depth;
  const unreached: FoundRoom[] = [];

  let seeds: { x: number; z: number }[] = [];
  for (const item of plan.floors[0]!.items) {
    if (item.kind !== 'door') continue;
    const footprint = itemFootprint(item, plan.wallThickness, plan.storeyHeight);
    // Both sides of the doorway, so an entrance seeds the inside as well as the street.
    for (let z = footprint.z; z < rectBottom(footprint); z++) {
      for (let x = footprint.x; x < rectRight(footprint); x++) seeds.push({ x, z });
    }
  }

  for (let index = 0; index < plan.floors.length; index++) {
    const floor = plan.floors[index]!;
    const blocked = occupancy(plan, floor.items, width, depth);
    const visited = new Uint8Array(cells);
    const queue: number[] = [];

    for (const seed of seeds) {
      if (seed.x < 0 || seed.z < 0 || seed.x >= width || seed.z >= depth) continue;
      const at = seed.x + seed.z * width;
      if (blocked[at] || visited[at]) continue;
      visited[at] = 1;
      queue.push(at);
    }

    for (let head = 0; head < queue.length; head++) {
      const at = queue[head]!;
      const x = at % width;
      const z = (at - x) / width;
      const neighbours = [
        x > 0 ? at - 1 : -1,
        x < width - 1 ? at + 1 : -1,
        z > 0 ? at - width : -1,
        z < depth - 1 ? at + width : -1,
      ];
      for (const next of neighbours) {
        if (next < 0 || visited[next] || blocked[next]) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    for (const item of floor.items) {
      if (item.kind !== 'room') continue;
      const inside = interiorRect(item, plan.wallThickness);
      if (!inside) continue;
      let reached = false;
      for (let z = inside.z; z < rectBottom(inside) && !reached; z++) {
        for (let x = inside.x; x < rectRight(inside); x++) {
          if (visited[x + z * width]) {
            reached = true;
            break;
          }
        }
      }
      if (!reached) unreached.push({ floorIndex: index, item });
    }

    // Seed the storey above from every staircase whose foot we actually got to.
    seeds = [];
    for (const item of floor.items) {
      if (item.kind !== 'stair') continue;
      const foot = item.x + item.z * width;
      if (foot < 0 || foot >= cells || !visited[foot]) continue;
      const run = stairFootprint(item.x, item.z, item.facing, item.width, floorHeight(plan, index));
      for (let z = run.z; z < rectBottom(run); z++) {
        for (let x = run.x; x < rectRight(run); x++) seeds.push({ x, z });
      }
    }
  }

  return unreached;
}

/** Walls and columns as a blocked/open grid, with the doorways punched back open. */
function occupancy(
  plan: LayoutPlan,
  items: readonly PlanItem[],
  width: number,
  depth: number,
): Uint8Array {
  const blocked = new Uint8Array(width * depth);

  const paint = (rect: Rect, value: number) => {
    for (let z = Math.max(0, rect.z); z < Math.min(depth, rectBottom(rect)); z++) {
      for (let x = Math.max(0, rect.x); x < Math.min(width, rectRight(rect)); x++) {
        blocked[x + z * width] = value;
      }
    }
  };

  for (const run of wallRuns(items, plan.wallThickness)) paint(runFootprint(run), 1);
  for (const item of items) if (item.kind === 'column') paint(itemFootprint(item, plan.wallThickness, plan.storeyHeight), 1);
  // Last, so a doorway always wins over the wall it was cut into.
  for (const item of items) if (item.kind === 'door') paint(itemFootprint(item, plan.wallThickness, plan.storeyHeight), 0);

  return blocked;
}
