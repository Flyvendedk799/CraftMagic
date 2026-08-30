/**
 * Plan → `BuildProgram`.
 *
 * This is Architecture mode's counterpart to `customMapCompiler.js` in the level editor engine it
 * is ported from: the authored document is a list of intentions, and the compiler turns it
 * into the thing the runtime actually consumes. There, that meant collision boxes and meshes;
 * here it means CraftMagic's IR — which is the whole reason Architecture mode gets every export
 * the editor has for free. A compiled plan is a program like any other, so `.schem` download,
 * program JSON, the printable guide, the library and "Send to game" all work unchanged, with
 * no export code written twice.
 *
 * Two decisions shape everything below.
 *
 * **Painting order, not booleans.** The IR paints components in order and later ones overwrite
 * earlier ones, with `minecraft:air` carving. So the compiler runs in passes: all structure
 * first, then the carves (floor voids, stairwells), then the apertures, then the stairs
 * themselves. A door does not have to know which walls it crosses and a stairwell does not
 * have to know which slab it pierces — each is simply painted after whatever it interrupts.
 * Get the passes in the wrong order and a doorway comes out bricked up; get them right and
 * the geometry needs no intersection tests at all.
 *
 * **The plan is cropped, not padded.** Plan space is a fixed site so the canvas has somewhere
 * to draw, but a build that carried the site's empty margin would export a mostly-air
 * schematic and paste into a world offset from where the user expects. So the compiler finds
 * what is actually drawn, pads it for the roof overhang, and emits a program that starts at
 * the building's own corner.
 *
 * Vertical convention, for the whole file (heights are per storey now, so the arithmetic
 * lives in `slabY`/`deckY` in plan.ts rather than in a multiplication here):
 *
 *     y = 0                     bottom of the foundation
 *     y = slabY(i)              storey i's floor slab (one block)
 *     y = slabY(i) + 1          storey i's walking surface, and the base of its walls
 *     y = deckY                 the top ceiling — the roof deck
 */

import {
  LIMITS as IR_LIMITS,
  type BuildProgram,
  type Component,
  type DetailOp,
  type Prefab,
} from '@craftmagic/core';
import type { Catalogue } from './components.js';
import { furnishingById, furnishingCells } from './furniture.js';
import { paletteFor } from './kits.js';
import { deckY as roofDeckY, floorHeight, slabY as slabYOf, type LayoutPlan, type PlanItem, type Rect, type RoomItem } from './plan.js';
import { planFootprint, rectBottom, rectRight, stairFootprint, unionRect } from './geometry.js';

export interface CompileResult {
  program: BuildProgram;
  /** Plan coordinate of the program's origin, so build space can be talked about in plan terms. */
  origin: { x: number; z: number };
  /** Non-fatal problems: something was clipped, capped or skipped. */
  warnings: string[];
}

/** How far a pitched roof climbs per unit of half-span, by the plan's pitch setting. */
const PITCH_RISE: Record<string, number> = { low: 0.5, classic: 1, steep: 2 };

/**
 * Held below the IR's own component cap so the expander is never the thing that refuses.
 *
 * A plan that hits this is enormous by the standards of a hand-drawn floorplan, and the
 * failure has to be a message rather than a broken build: the compiler stops adding and says
 * how many items it dropped.
 */
const MAX_COMPONENTS = IR_LIMITS.maxComponents - 8;

/**
 * Compile a plan.
 *
 * `catalogue` carries the blocks of any saved builds the plan places. It is a parameter rather
 * than something fetched here because compiling has to stay pure and synchronous — it runs on
 * every keystroke that changes the plan — while the builds arrive over the network. A plan
 * whose components have not landed yet compiles without them and says so, which is the right
 * behaviour: the alternative is a blank page for as long as the request takes.
 */
export function compilePlan(plan: LayoutPlan, catalogue: Catalogue = new Map()): CompileResult {
  const warnings: string[] = [];
  const floors = plan.floors.length;

  const drawn = planFootprint(plan);
  const pad = plan.roof === 'gable' || plan.roof === 'hip' ? plan.roofOverhang + 1 : 1;

  // An empty plan still compiles. It produces a plot rather than an error, which is what the
  // editor does with its blank build and what the export controls expect to be handed.
  const footprint: Rect = drawn
    ? { x: drawn.x - pad, z: drawn.z - pad, w: drawn.w + pad * 2, d: drawn.d + pad * 2 }
    : { x: 0, z: 0, w: 1, d: 1 };

  const origin = { x: footprint.x, z: footprint.z };

  const deckY = roofDeckY(plan);
  const roofHeight = roofRise(plan, footprint);
  // Nothing drawn means nothing to be tall: a plan with no rooms compiles to a single empty
  // cell rather than to a storey-high sliver of air, which is what the preview would frame.
  // A placed building is not bound by the storey it sits on — a spire dropped on the top
  // floor is taller than the roof over it. Measured before the volume is fixed, or the top of
  // it is silently clipped away by an expander that was told the building is shorter.
  let placedTop = 0;
  for (let index = 0; index < floors; index++) {
    for (const item of plan.floors[index]!.items) {
      if (item.kind !== 'place') continue;
      const component = catalogue.get(item.buildId);
      placedTop = Math.max(placedTop, slabYOf(plan, index) + 1 + (component?.size.y ?? item.h));
    }
  }

  const height = drawn
    ? Math.max(1, deckY + (plan.roof === 'none' ? 0 : 1) + roofHeight, placedTop)
    : Math.max(1, placedTop);

  if (height > IR_LIMITS.maxSizeY) {
    warnings.push(
      `The building is ${height} blocks tall and the engine tops out at ${IR_LIMITS.maxSizeY}. ` +
        'Remove a storey or lower the storey height.',
    );
  }

  const components: Component[] = [];
  let dropped = 0;
  /**
   * How many components each plan item has emitted, for id suffixes.
   *
   * Every component is tagged with the id of the plan item that produced it — the round-trip
   * half of the compiler. An item that emits several (a room is a slab, a wall ring and a
   * lid) numbers the extras `<id>.2`, `<id>.3`, so ids stay unique for the diff-refine tool
   * while `id.split('.')[0]` still names the item. Clicking a wall in the 3D model resolves
   * voxel → part → component id → plan item through exactly this tag.
   */
  const emitted = new Map<string, number>();
  const push = (component: Component, itemId?: string, label?: string) => {
    if (components.length >= MAX_COMPONENTS) {
      dropped++;
      return;
    }
    if (itemId) {
      const n = (emitted.get(itemId) ?? 0) + 1;
      emitted.set(itemId, n);
      component = {
        ...component,
        id: n === 1 ? itemId : `${itemId}.${n}`,
        ...(label && n === 1 ? { label } : {}),
      };
    }
    components.push(component);
  };

  // --- pass 1: structure -------------------------------------------------
  //
  // Foundation, then every storey bottom-up. A storey draws its own slab and walls and the
  // ceiling above it; the next storey's slabs land on that same layer and overwrite it, which
  // is what lets a smaller upper floor leave the rest of the lower one roofed without anyone
  // having to work out where the step is.

  if (plan.foundation > 0 && drawn) {
    const base = drawn;
    push({
      type: 'box',
      pos: [base.x - origin.x, 0, base.z - origin.z],
      size: [base.w, plan.foundation, base.d],
      fill: { type: 'solid', role: 'foundation' },
    }, 'foundation', 'Foundation');
  }

  for (let index = 0; index < floors; index++) {
    const storey = floorHeight(plan, index);
    const slabY = slabYOf(plan, index);
    const wallY = slabY + 1;
    const wallHeight = storey - 1;
    const ceilingY = slabY + storey;
    const top = index === floors - 1;
    const [ox, oz] = [origin.x, origin.z];

    for (const item of plan.floors[index]!.items) {
      switch (item.kind) {
        case 'room': {
          const { rect } = item;
          if (item.slab) {
            push({
              type: 'box',
              pos: [rect.x - ox, slabY, rect.z - oz],
              size: [rect.w, 1, rect.d],
              fill: { type: 'solid', role: item.floorRole ?? 'floor' },
            }, item.id, item.label.trim() || undefined);
          }
          push({
            type: 'hollow_box',
            pos: [rect.x - ox, wallY, rect.z - oz],
            size: [rect.w, wallHeight, rect.d],
            wallThickness: wallThicknessFor(item, plan.wallThickness),
            floor: false,
            ceiling: false,
            fill: { type: 'solid', role: item.wallRole ?? 'wall_primary' },
          }, item.id, item.label.trim() || undefined);
          // The lid. On the top storey it doubles as the roof deck, which is why `roof: none`
          // is the one case that leaves a room open to the sky.
          if (!top || plan.roof !== 'none') {
            push({
              type: 'box',
              pos: [rect.x - ox, ceilingY, rect.z - oz],
              size: [rect.w, 1, rect.d],
              fill: { type: 'solid', role: top ? 'roof_primary' : 'ceiling' },
            }, item.id);
          }
          break;
        }

        case 'wall': {
          const size: [number, number, number] =
            item.axis === 'x'
              ? [item.length, wallHeight, plan.wallThickness]
              : [plan.wallThickness, wallHeight, item.length];
          push({
            type: 'box',
            pos: [item.x - ox, wallY, item.z - oz],
            size,
            fill: { type: 'solid', role: item.role ?? 'wall_primary' },
          }, item.id);
          break;
        }

        case 'platform':
          push({
            type: 'box',
            pos: [item.rect.x - ox, wallY, item.rect.z - oz],
            size: [item.rect.w, item.raise, item.rect.d],
            fill: { type: 'solid', role: item.role ?? 'floor' },
          }, item.id);
          break;

        case 'column':
          push({
            type: 'box',
            pos: [item.x - ox, wallY, item.z - oz],
            size: [item.size, wallHeight, item.size],
            fill: { type: 'solid', role: item.role ?? 'frame' },
          }, item.id);
          break;

        default:
          break;
      }
    }
  }

  // The roof sits on the top storey's footprint, not the whole plan's: a building that steps
  // in as it rises should be roofed where it actually is.
  if (plan.roof !== 'none' && floors > 0) {
    const topRooms = unionRect(roomRectsOf(plan.floors[floors - 1]!.items));
    const roofOver = topRooms ?? drawn;
    if (roofOver) for (const component of roofComponents(plan, roofOver, deckY, origin)) push(component, 'roof', 'Roof');
  }

  // --- pass 2: carves ----------------------------------------------------
  //
  // Painted after every slab exists, so a void does not care which storey drew the layer it
  // is cutting through, and a stairwell does not care whether the floor above it is one room
  // or four.

  for (let index = 0; index < floors; index++) {
    const storey = floorHeight(plan, index);
    const slabY = slabYOf(plan, index);
    const [ox, oz] = [origin.x, origin.z];

    for (const item of plan.floors[index]!.items) {
      if (item.kind === 'opening') {
        push({
          type: 'box',
          pos: [item.rect.x - ox, slabY, item.rect.z - oz],
          size: [item.rect.w, 1, item.rect.d],
          fill: { type: 'solid', role: 'air' },
        }, item.id);
      } else if (item.kind === 'stair') {
        const run = stairFootprint(item.x, item.z, item.facing, item.width, storey);
        push({
          type: 'box',
          pos: [run.x - ox, slabY + storey, run.z - oz],
          size: [run.w, 1, run.d],
          fill: { type: 'solid', role: 'air' },
        }, item.id);
      }
    }
  }

  // --- pass 3: apertures -------------------------------------------------

  for (let index = 0; index < floors; index++) {
    const storey = floorHeight(plan, index);
    const wallY = slabYOf(plan, index) + 1;
    const [ox, oz] = [origin.x, origin.z];

    for (const item of plan.floors[index]!.items) {
      if (item.kind === 'door') {
        const along = item.width;
        const across = plan.wallThickness;
        const horizontal = item.facing === 'north' || item.facing === 'south';
        push({
          type: 'box',
          pos: [item.x - ox, wallY, item.z - oz],
          size: horizontal ? [along, item.height, across] : [across, item.height, along],
          fill: { type: 'solid', role: 'air' },
        }, item.id);
        // An open doorway is the carve and nothing else — the archway between two rooms that
        // a swinging door would only get in the way of.
        if (!item.open) {
          push({
            type: 'door',
            face: item.facing,
            at: [item.x - ox, wallY, item.z - oz],
            width: item.width,
            height: item.height,
            role: 'door',
          }, item.id);
        }
        // A lintel over the opening, when a wall course remains above it to replace. It is
        // what stops a doorway reading as a slot cut with a saw.
        if (item.height < storey - 1) {
          push({
            type: 'box',
            pos: [item.x - ox, wallY + item.height, item.z - oz],
            size: horizontal ? [along, 1, across] : [across, 1, along],
            fill: { type: 'solid', role: 'frame' },
          }, item.id);
        }
      } else if (item.kind === 'window') {
        const across = plan.wallThickness;
        const horizontal = item.axis === 'x';
        const opening: [number, number, number] = horizontal
          ? [item.length, item.height, across]
          : [across, item.height, item.length];

        // A window used to be a solid slug of glass the full thickness of the wall — on a
        // 3-block wall, a 3-block-deep aquarium pane. Now the wall is carved through, and a
        // single sheet of glass sits centred in the reveal, the way a builder would set it.
        push({
          type: 'box',
          pos: [item.x - ox, wallY + item.sill, item.z - oz],
          size: opening,
          fill: { type: 'solid', role: 'air' },
        }, item.id);
        const inset = Math.floor((across - 1) / 2);
        push({
          type: 'box',
          pos: horizontal
            ? [item.x - ox, wallY + item.sill, item.z - oz + inset]
            : [item.x - ox + inset, wallY + item.sill, item.z - oz],
          size: horizontal ? [item.length, item.height, 1] : [1, item.height, item.length],
          fill: { type: 'solid', role: 'window' },
        }, item.id);

        // Sill below and lintel above, in the frame role — the trim that makes an opening
        // read as a window rather than as a missing bit of wall. Each only where a wall
        // course actually exists to replace.
        const frame: [number, number, number] = horizontal
          ? [item.length, 1, across]
          : [across, 1, item.length];
        if (item.sill > 0) {
          push({
            type: 'box',
            pos: [item.x - ox, wallY + item.sill - 1, item.z - oz],
            size: frame,
            fill: { type: 'solid', role: 'frame' },
          }, item.id);
        }
        if (item.sill + item.height < storey - 1) {
          push({
            type: 'box',
            pos: [item.x - ox, wallY + item.sill + item.height, item.z - oz],
            size: frame,
            fill: { type: 'solid', role: 'frame' },
          }, item.id);
        }
      }
    }
  }

  // --- pass 4: stairs ----------------------------------------------------
  //
  // Last, because the run climbs *through* the layer its own stairwell just carved, and a
  // carve painted afterwards would take the top step with it.

  for (let index = 0; index < floors; index++) {
    const storey = floorHeight(plan, index);
    const wallY = slabYOf(plan, index) + 1;
    const [ox, oz] = [origin.x, origin.z];

    for (const item of plan.floors[index]!.items) {
      if (item.kind !== 'stair') continue;
      const run = stairFootprint(item.x, item.z, item.facing, item.width, storey);
      // `stairs_run` walks forward from its origin, so a run heading north or west starts at
      // the far corner of its own footprint.
      const startX = item.facing === 'west' ? rectRight(run) - 1 : run.x;
      const startZ = item.facing === 'north' ? rectBottom(run) - 1 : run.z;
      push({
        type: 'stairs_run',
        pos: [startX - ox, wallY, startZ - oz],
        direction: item.facing,
        width: item.width,
        steps: storey,
        role: 'stair',
        style: 'stairs',
      }, item.id);
    }
  }

  // --- pass 5: furnishings ------------------------------------------------
  //
  // Raw voxel patches, painted after everything else: a chair does not negotiate with the
  // slab it stands on, it lands on whatever the structure passes drew. `details` is exactly
  // the IR feature for this — singular placed things no parametric component describes.

  const details: DetailOp[] = [];
  for (let index = 0; index < floors; index++) {
    const surfaceY = slabYOf(plan, index) + 1;
    for (const item of plan.floors[index]!.items) {
      if (item.kind !== 'furnish') continue;
      const piece = furnishingById(item.itemId);
      const cells = furnishingCells(piece, item.x, item.z, item.facing);
      if (details.length + cells.length > IR_LIMITS.maxDetailOps - 8) {
        dropped++;
        continue;
      }
      for (const cell of cells) {
        details.push({
          op: 'set',
          at: [cell.x - origin.x, surfaceY + cell.y, cell.z - origin.z],
          block: cell.block,
        });
      }
    }
  }

  // --- pass 6: placed builds ----------------------------------------------
  //
  // Last, so a saved building lands on top of the architecture rather than under it. That is
  // the same reason furnishings come after the structure, and it is what makes placing a
  // finished shed inside a room do the obvious thing.
  //
  // Each distinct build becomes one entry in `program.prefabs` however many times it is
  // placed, which is the whole reason the table exists: four corner towers cost one copy of
  // the blocks and four references.

  const prefabs: Record<string, Prefab> = {};
  const missing = new Set<string>();
  /**
   * A short name per distinct build, assigned in the order they are met.
   *
   * Not derived from the build id. A truncated uuid reads no better in the program and can
   * collide — two builds sharing twelve hex digits would silently become one, and the second
   * would come out as the first with nothing to indicate it. `b1`, `b2` cannot.
   */
  const refOf = new Map<string, string>();

  for (let index = 0; index < floors; index++) {
    const surfaceY = slabYOf(plan, index) + 1;
    for (const item of plan.floors[index]!.items) {
      if (item.kind !== 'place') continue;

      const component = catalogue.get(item.buildId);
      if (!component) {
        // Not an error: the fetch may simply be in flight. The message is only raised once
        // the item names a build the library refused, and either way the rest still builds.
        missing.add(item.name || item.buildId);
        continue;
      }

      let ref = refOf.get(item.buildId);
      if (!ref) {
        ref = `b${refOf.size + 1}`;
        refOf.set(item.buildId, ref);
        prefabs[ref] = component.prefab;
      }

      push(
        {
          type: 'prefab',
          ref,
          pos: [item.x - origin.x, surfaceY, item.z - origin.z],
          ...(item.turns ? { turns: item.turns } : {}),
        },
        item.id,
        component.name,
      );
    }
  }

  if (missing.size > 0) {
    warnings.push(
      `Waiting for ${[...missing].join(', ')} — a placed build's blocks come from your library.`,
    );
  }

  if (dropped > 0) {
    warnings.push(
      `${dropped} item${dropped === 1 ? '' : 's'} were left out — a plan can compile to at most ` +
        `${MAX_COMPONENTS} components. Split the building across two layouts.`,
    );
  }

  const program: BuildProgram = {
    version: 1,
    meta: {
      name: plan.name,
      description: `${floors} storey${floors === 1 ? '' : 's'}, ${plan.wallThickness}-block walls, laid out in Architecture mode.`,
    },
    size: {
      x: Math.max(1, footprint.w),
      y: Math.min(IR_LIMITS.maxSizeY, height),
      z: Math.max(1, footprint.d),
    },
    palette: paletteFor(plan.kitId),
    ...(Object.keys(prefabs).length > 0 ? { prefabs } : {}),
    components,
    ...(details.length > 0 ? { details } : {}),
  };

  return { program, origin, warnings };
}

/** Room rects on one storey. */
function roomRectsOf(items: readonly PlanItem[]): Rect[] {
  return items.filter((item): item is RoomItem => item.kind === 'room').map((item) => item.rect);
}

/**
 * Walls are capped at half the room's smaller side.
 *
 * Without this a 3×3 closet with 2-block walls compiles to a solid block of masonry: the two
 * wall rings meet in the middle and the room has no inside. Capping produces a thinner wall
 * than asked for, which is visibly a compromise; a solid cube is a silent failure.
 */
function wallThicknessFor(room: RoomItem, thickness: number): number {
  const half = Math.floor(Math.min(room.rect.w, room.rect.d) / 2);
  return Math.max(1, Math.min(thickness, half || 1));
}

function roofRise(plan: LayoutPlan, footprint: Rect): number {
  if (plan.roof === 'none') return 0;
  if (plan.roof === 'flat') return 1;
  const span = Math.min(footprint.w, footprint.d);
  const rate = PITCH_RISE[plan.roofPitch] ?? 1;
  return Math.max(1, Math.ceil((span / 2) * rate));
}

function roofComponents(
  plan: LayoutPlan,
  over: Rect,
  deckY: number,
  origin: { x: number; z: number },
): Component[] {
  const pos: [number, number, number] = [over.x - origin.x, deckY + 1, over.z - origin.z];

  if (plan.roof === 'flat') {
    // A parapet rather than a bare edge: it reads as a roof from the ground, and it stops
    // anyone walking off one.
    return [
      {
        type: 'hollow_box',
        pos,
        size: [over.w, 1, over.d],
        wallThickness: 1,
        floor: false,
        ceiling: false,
        fill: { type: 'solid', role: 'roof_trim' },
      },
    ];
  }

  const rise = roofRise(plan, over);

  if (plan.roof === 'hip') {
    return [
      {
        type: 'hip_roof',
        pos,
        size: [over.w, rise, over.d],
        overhang: plan.roofOverhang,
        style: 'stairs',
        roofRole: 'roof_primary',
      },
    ];
  }

  return [
    {
      type: 'gable_roof',
      pos,
      // The ridge runs the long way, which is what a builder would do and what keeps the
      // slopes at a sane pitch.
      size: [over.w, rise, over.d],
      ridgeAxis: over.w >= over.d ? 'x' : 'z',
      overhang: plan.roofOverhang,
      style: 'stairs',
      roofRole: 'roof_primary',
      trimRole: 'roof_trim',
    },
  ];
}
