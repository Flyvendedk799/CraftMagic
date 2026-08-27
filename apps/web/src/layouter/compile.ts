/**
 * Plan → `BuildProgram`.
 *
 * This is the layouter's counterpart to `customMapCompiler.js` in the level editor engine it
 * is ported from: the authored document is a list of intentions, and the compiler turns it
 * into the thing the runtime actually consumes. There, that meant collision boxes and meshes;
 * here it means CraftMagic's IR — which is the whole reason the layouter gets every export
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
 * Vertical convention, for the whole file:
 *
 *     y = 0                          bottom of the foundation
 *     y = foundation + i*storey      storey i's floor slab (one block)
 *     y = foundation + i*storey + 1  storey i's walking surface, and the base of its walls
 *     y = foundation + n*storey      the top ceiling — the roof deck
 */

import { LIMITS as IR_LIMITS, type BuildProgram, type Component } from '@craftmagic/core';
import { paletteFor } from './kits.js';
import type { LayoutPlan, PlanItem, Rect, RoomItem } from './plan.js';
import { planFootprint, rectBottom, rectRight, stairFootprint, unionRect } from './geometry.js';

export interface CompileResult {
  program: BuildProgram;
  /** Plan coordinate of the program's origin, so build space can be talked about in plan terms. */
  origin: { x: number; z: number };
  /** Non-fatal problems: something was clipped, capped or skipped. */
  warnings: string[];
}

/** Eaves project this far past the wall on every side. */
const OVERHANG = 1;

/**
 * Held below the IR's own component cap so the expander is never the thing that refuses.
 *
 * A plan that hits this is enormous by the standards of a hand-drawn floorplan, and the
 * failure has to be a message rather than a broken build: the compiler stops adding and says
 * how many items it dropped.
 */
const MAX_COMPONENTS = IR_LIMITS.maxComponents - 8;

export function compilePlan(plan: LayoutPlan): CompileResult {
  const warnings: string[] = [];
  const storey = plan.storeyHeight;
  const floors = plan.floors.length;

  const drawn = planFootprint(plan);
  const pad = plan.roof === 'gable' || plan.roof === 'hip' ? OVERHANG + 1 : 1;

  // An empty plan still compiles. It produces a plot rather than an error, which is what the
  // editor does with its blank build and what the export controls expect to be handed.
  const footprint: Rect = drawn
    ? { x: drawn.x - pad, z: drawn.z - pad, w: drawn.w + pad * 2, d: drawn.d + pad * 2 }
    : { x: 0, z: 0, w: 1, d: 1 };

  const origin = { x: footprint.x, z: footprint.z };

  const deckY = plan.foundation + floors * storey;
  const roofHeight = roofRise(plan, footprint);
  // Nothing drawn means nothing to be tall: a plan with no rooms compiles to a single empty
  // cell rather than to a storey-high sliver of air, which is what the preview would frame.
  const height = drawn ? Math.max(1, deckY + (plan.roof === 'none' ? 0 : 1) + roofHeight) : 1;

  if (height > IR_LIMITS.maxSizeY) {
    warnings.push(
      `The building is ${height} blocks tall and the engine tops out at ${IR_LIMITS.maxSizeY}. ` +
        'Remove a storey or lower the storey height.',
    );
  }

  const components: Component[] = [];
  let dropped = 0;
  const push = (component: Component) => {
    if (components.length >= MAX_COMPONENTS) {
      dropped++;
      return;
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
    });
  }

  for (let index = 0; index < floors; index++) {
    const slabY = plan.foundation + index * storey;
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
            });
          }
          push({
            type: 'hollow_box',
            pos: [rect.x - ox, wallY, rect.z - oz],
            size: [rect.w, wallHeight, rect.d],
            wallThickness: wallThicknessFor(item, plan.wallThickness),
            floor: false,
            ceiling: false,
            fill: { type: 'solid', role: item.wallRole ?? 'wall_primary' },
          });
          // The lid. On the top storey it doubles as the roof deck, which is why `roof: none`
          // is the one case that leaves a room open to the sky.
          if (!top || plan.roof !== 'none') {
            push({
              type: 'box',
              pos: [rect.x - ox, ceilingY, rect.z - oz],
              size: [rect.w, 1, rect.d],
              fill: { type: 'solid', role: top ? 'roof_primary' : 'ceiling' },
            });
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
          });
          break;
        }

        case 'platform':
          push({
            type: 'box',
            pos: [item.rect.x - ox, wallY, item.rect.z - oz],
            size: [item.rect.w, item.raise, item.rect.d],
            fill: { type: 'solid', role: item.role ?? 'floor' },
          });
          break;

        case 'column':
          push({
            type: 'box',
            pos: [item.x - ox, wallY, item.z - oz],
            size: [item.size, wallHeight, item.size],
            fill: { type: 'solid', role: item.role ?? 'frame' },
          });
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
    if (roofOver) for (const component of roofComponents(plan, roofOver, deckY, origin)) push(component);
  }

  // --- pass 2: carves ----------------------------------------------------
  //
  // Painted after every slab exists, so a void does not care which storey drew the layer it
  // is cutting through, and a stairwell does not care whether the floor above it is one room
  // or four.

  for (let index = 0; index < floors; index++) {
    const slabY = plan.foundation + index * storey;
    const [ox, oz] = [origin.x, origin.z];

    for (const item of plan.floors[index]!.items) {
      if (item.kind === 'opening') {
        push({
          type: 'box',
          pos: [item.rect.x - ox, slabY, item.rect.z - oz],
          size: [item.rect.w, 1, item.rect.d],
          fill: { type: 'solid', role: 'air' },
        });
      } else if (item.kind === 'stair') {
        const run = stairFootprint(item.x, item.z, item.facing, item.width, storey);
        push({
          type: 'box',
          pos: [run.x - ox, slabY + storey, run.z - oz],
          size: [run.w, 1, run.d],
          fill: { type: 'solid', role: 'air' },
        });
      }
    }
  }

  // --- pass 3: apertures -------------------------------------------------

  for (let index = 0; index < floors; index++) {
    const wallY = plan.foundation + index * storey + 1;
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
        });
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
          });
        }
      } else if (item.kind === 'window') {
        const across = plan.wallThickness;
        push({
          type: 'box',
          pos: [item.x - ox, wallY + item.sill, item.z - oz],
          size:
            item.axis === 'x'
              ? [item.length, item.height, across]
              : [across, item.height, item.length],
          fill: { type: 'solid', role: 'window' },
        });
      }
    }
  }

  // --- pass 4: stairs ----------------------------------------------------
  //
  // Last, because the run climbs *through* the layer its own stairwell just carved, and a
  // carve painted afterwards would take the top step with it.

  for (let index = 0; index < floors; index++) {
    const wallY = plan.foundation + index * storey + 1;
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
      });
    }
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
      description: `${floors} storey${floors === 1 ? '' : 's'}, ${plan.wallThickness}-block walls, laid out in the layouter.`,
    },
    size: {
      x: Math.max(1, footprint.w),
      y: Math.min(IR_LIMITS.maxSizeY, height),
      z: Math.max(1, footprint.d),
    },
    palette: paletteFor(plan.kitId),
    components,
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
  return Math.max(1, Math.ceil(span / 2));
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
        overhang: OVERHANG,
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
      overhang: OVERHANG,
      style: 'stairs',
      roofRole: 'roof_primary',
      trimRole: 'roof_trim',
    },
  ];
}
