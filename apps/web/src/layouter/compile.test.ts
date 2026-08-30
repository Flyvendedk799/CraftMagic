import { describe, expect, it } from 'vitest';
import { expand, voxelIndex, type VoxelGrid } from '@craftmagic/core';
import { compilePlan } from './compile.js';
import {
  createDoor,
  createFloor,
  createOpening,
  createPlan,
  createRoom,
  createStair,
  createWindow,
  floorName,
  normalizeItem,
  type LayoutPlan,
} from './plan.js';

function blockAt(grid: VoxelGrid, x: number, y: number, z: number): string {
  const index = grid.voxels[voxelIndex(grid.size, x, y, z)] ?? 0;
  return grid.palette[index] ?? 'minecraft:air';
}

function build(plan: LayoutPlan) {
  const compiled = compilePlan(plan);
  const result = expand(compiled.program);
  return { ...compiled, ...result };
}

/** One 7×7 room at (10,10) with a south door — the smallest plan that exercises every pass. */
function cottage(overrides: Partial<LayoutPlan> = {}): LayoutPlan {
  return createPlan({
    name: 'Test',
    roof: 'flat',
    foundation: 1,
    storeyHeight: 5,
    wallThickness: 1,
    kitId: 'oak-cottage',
    floors: [
      createFloor(floorName(0), [
        createRoom({ x: 10, z: 10, w: 7, d: 7 }, { label: 'Room' }),
        createDoor(13, 16, 'south'),
      ]),
    ],
    ...overrides,
  });
}

describe('compilePlan', () => {
  it('crops the program to the building rather than to the site', () => {
    const { program, origin } = compilePlan(cottage());

    // A flat roof needs one block of margin; the site is 48×48 and contributes nothing.
    expect(origin).toEqual({ x: 9, z: 9 });
    expect(program.size.x).toBe(9);
    expect(program.size.z).toBe(9);
    // Foundation 1 + one storey of 5 + the deck + the parapet.
    expect(program.size.y).toBe(8);
  });

  it('tags every component with the plan item that drew it', () => {
    const plan = cottage();
    const roomId = plan.floors[0]!.items[0]!.id;
    const doorId = plan.floors[0]!.items[1]!.id;
    const { program } = compilePlan(plan);

    // Every component names its plan item (suffixes count extra emissions from one item).
    expect(program.components.every((component) => component.id)).toBe(true);
    const itemsOf = program.components.map((component) => component.id!.split('.')[0]);
    expect(itemsOf).toContain('foundation');
    expect(itemsOf).toContain('roof');
    expect(itemsOf).toContain(roomId);
    expect(itemsOf).toContain(doorId);
    // Ids stay unique — the diff-refine tool addresses ops to them.
    expect(new Set(program.components.map((c) => c.id)).size).toBe(program.components.length);
    // The room's label rides on its first component, for the outliner.
    const roomFirst = program.components.find((c) => c.id === roomId);
    expect(roomFirst?.label).toBe('Room');
  });

  it('resolves a clicked voxel back to the plan item, through provenance', () => {
    const plan = cottage();
    const roomId = plan.floors[0]!.items[0]!.id;
    const compiled = compilePlan(plan);
    const result = expand(compiled.program, { provenance: true });

    // The wall corner at build (1,2,1) — the click-to-select chain the page runs.
    const partId = result.origin![voxelIndex(result.grid.size, 1, 2, 1)]!;
    expect(partId).toBeGreaterThan(0);
    const part = result.parts.find((entry) => entry.id === partId)!;
    const match = part.path.match(/^components\[(\d+)\]$/)!;
    const componentId = compiled.program.components[Number(match[1])]!.id!;
    expect(componentId.split('.')[0]).toBe(roomId);
  });

  it('builds a foundation, a slab, a wall ring and a ceiling at the right heights', () => {
    const { grid, errors } = build(cottage());
    expect(errors).toEqual([]);

    // The room's min corner sits at build (1,1) once the margin is taken off.
    expect(blockAt(grid, 1, 0, 1)).toBe('minecraft:cobblestone');
    expect(blockAt(grid, 1, 1, 1)).toBe('minecraft:spruce_planks');
    expect(blockAt(grid, 1, 2, 1)).toBe('minecraft:oak_planks');
    // The inside is empty for the full clear height, which is what a storey is for.
    for (let y = 2; y <= 5; y++) expect(blockAt(grid, 4, y, 4)).toBe('minecraft:air');
    // The top storey's lid is the roof deck.
    expect(blockAt(grid, 4, 6, 4)).toBe('minecraft:bricks');
  });

  it('cuts a doorway through the wall and hangs a door in it', () => {
    const { grid } = build(cottage());

    // The door sits in the south wall at build x 4, z 7.
    expect(blockAt(grid, 4, 2, 7)).toContain('minecraft:oak_door');
    expect(blockAt(grid, 4, 3, 7)).toContain('minecraft:oak_door');
    // Its neighbours in the same wall are untouched.
    expect(blockAt(grid, 3, 2, 7)).toBe('minecraft:oak_planks');
  });

  it('leaves an open archway as a hole, with no door in it', () => {
    const plan = cottage({
      floors: [
        createFloor(floorName(0), [
          createRoom({ x: 10, z: 10, w: 7, d: 7 }),
          createDoor(13, 16, 'south', { open: true }),
        ]),
      ],
    });
    const { grid } = build(plan);

    expect(blockAt(grid, 4, 2, 7)).toBe('minecraft:air');
    expect(blockAt(grid, 4, 3, 7)).toBe('minecraft:air');
  });

  it('glazes a window at its sill height and nowhere else', () => {
    const plan = cottage({
      floors: [
        createFloor(floorName(0), [
          createRoom({ x: 10, z: 10, w: 7, d: 7 }),
          createWindow('x', 12, 10, { length: 3, sill: 1, height: 2 }),
        ]),
      ],
    });
    const { grid } = build(plan);

    // North wall is build z 0; the window starts at build x 3. The opening is glazed at its
    // two rows, with a frame sill below and a frame lintel above — the trim that makes an
    // opening read as a window rather than a missing bit of wall.
    expect(blockAt(grid, 3, 2, 1)).toBe('minecraft:oak_log[axis=y]');
    expect(blockAt(grid, 3, 3, 1)).toBe('minecraft:glass');
    expect(blockAt(grid, 5, 4, 1)).toBe('minecraft:glass');
    expect(blockAt(grid, 3, 5, 1)).toBe('minecraft:oak_log[axis=y]');
    // Beside the opening, the wall is plain wall.
    expect(blockAt(grid, 2, 3, 1)).toBe('minecraft:oak_planks');
  });

  it('glazes one sheet centred in a thick wall, with the rest carved through', () => {
    const plan = cottage({
      wallThickness: 3,
      floors: [
        createFloor(floorName(0), [
          createRoom({ x: 10, z: 10, w: 9, d: 9 }),
          createWindow('x', 13, 10, { length: 3, sill: 1, height: 2 }),
        ]),
      ],
    });
    const { grid } = build(plan);

    // Wall occupies build z 1..3; glass sits in the middle course, air either side of it.
    expect(blockAt(grid, 4, 3, 1)).toBe('minecraft:air');
    expect(blockAt(grid, 4, 3, 2)).toBe('minecraft:glass');
    expect(blockAt(grid, 4, 3, 3)).toBe('minecraft:air');
  });

  it('gives each storey its own height when one asks for it', () => {
    const tall = createPlan({
      name: 'Hall below, rooms above',
      roof: 'flat',
      foundation: 1,
      storeyHeight: 4,
      wallThickness: 1,
      floors: [
        {
          ...createFloor(floorName(0), [
            createRoom({ x: 10, z: 10, w: 9, d: 9 }),
            createStair(12, 12, 'south', { width: 2 }),
          ]),
          height: 7,
        },
        createFloor(floorName(1), [createRoom({ x: 10, z: 10, w: 9, d: 9 })]),
      ],
    });
    const { grid, errors } = build(tall);
    expect(errors).toEqual([]);

    // Ground storey is 7 high: its slab at y=1, the upper slab at y=8, walls clear between.
    expect(blockAt(grid, 1, 1, 1)).toBe('minecraft:spruce_planks');
    for (let y = 2; y <= 7; y++) expect(blockAt(grid, 7, y, 7)).toBe('minecraft:air');
    expect(blockAt(grid, 7, 8, 7)).toBe('minecraft:spruce_planks');
    // And the stair climbs to the taller storey: treads exist high above the default's reach.
    let highTreads = 0;
    for (let z = 0; z < grid.size.z; z++) {
      for (let x = 0; x < grid.size.x; x++) {
        if (blockAt(grid, x, 7, z).includes('minecraft:oak_stairs')) highTreads++;
      }
    }
    expect(highTreads).toBeGreaterThan(0);
  });

  it('furnishes a room through the program details', () => {
    const plan = cottage({
      floors: [
        createFloor(floorName(0), [
          createRoom({ x: 10, z: 10, w: 7, d: 7 }),
          normalizeItem({ kind: 'furnish', x: 12, z: 12, facing: 'east', itemId: 'chair' })!,
          normalizeItem({ kind: 'furnish', x: 14, z: 12, facing: 'south', itemId: 'bed' })!,
        ]),
      ],
    });
    const { program, grid, errors } = build(plan);
    expect(errors).toEqual([]);
    expect(program.details?.length).toBe(3); // one chair block, two bed blocks

    // The chair is a stair block on the walking surface, rotated with its facing.
    expect(blockAt(grid, 3, 2, 3)).toContain('minecraft:oak_stairs');
    expect(blockAt(grid, 3, 2, 3)).toContain('facing=east');
    // The bed is a wool pair running south from its head.
    expect(blockAt(grid, 5, 2, 3)).toBe('minecraft:white_wool');
    expect(blockAt(grid, 5, 2, 4)).toBe('minecraft:red_wool');
  });

  it('lets the plan choose the roof pitch and overhang', () => {
    const classic = compilePlan(cottage({ roof: 'gable' }));
    const steep = compilePlan(cottage({ roof: 'gable', roofPitch: 'steep' }));
    const low = compilePlan(cottage({ roof: 'gable', roofPitch: 'low' }));
    expect(steep.program.size.y).toBeGreaterThan(classic.program.size.y);
    expect(low.program.size.y).toBeLessThanOrEqual(classic.program.size.y);

    const wide = compilePlan(cottage({ roof: 'gable', roofOverhang: 2 }));
    const flush = compilePlan(cottage({ roof: 'gable', roofOverhang: 0 }));
    expect(wide.program.size.x).toBeGreaterThan(flush.program.size.x);
  });

  it('carves a floor void through the slab it sits on', () => {
    const plan = cottage({
      floors: [
        createFloor(floorName(0), [
          createRoom({ x: 10, z: 10, w: 7, d: 7 }),
          createOpening({ x: 12, z: 12, w: 2, d: 2 }),
        ]),
      ],
    });
    const { grid } = build(plan);

    expect(blockAt(grid, 3, 1, 3)).toBe('minecraft:air');
    // And only the slab: the foundation under it is still there to fall onto.
    expect(blockAt(grid, 3, 0, 3)).toBe('minecraft:cobblestone');
  });

  it('runs a staircase up through a well it cuts in the floor above', () => {
    const plan = createPlan({
      name: 'Two up',
      roof: 'flat',
      foundation: 0,
      storeyHeight: 5,
      wallThickness: 1,
      floors: [
        createFloor(floorName(0), [
          createRoom({ x: 10, z: 10, w: 9, d: 9 }),
          createStair(12, 12, 'south', { width: 2 }),
        ]),
        createFloor(floorName(1), [createRoom({ x: 10, z: 10, w: 9, d: 9 })]),
      ],
    });
    const { grid, errors } = build(plan);
    expect(errors).toEqual([]);

    // The run starts at build (3,3) and climbs one block per step going south.
    expect(blockAt(grid, 3, 1, 3)).toContain('minecraft:oak_stairs');
    expect(blockAt(grid, 3, 2, 4)).toContain('minecraft:oak_stairs');
    // The last step is at the upper slab's own level, which means the well had to be cut
    // there first — if the pass order were wrong this would be the slab instead.
    expect(blockAt(grid, 3, 5, 7)).toContain('minecraft:oak_stairs');
    // Beside the run, the upper slab is intact.
    expect(blockAt(grid, 7, 5, 7)).toBe('minecraft:spruce_planks');
  });

  it('re-skins the whole building when the kit changes, without touching the plan', () => {
    const oak = build(cottage());
    const stone = build(cottage({ kitId: 'stone-keep' }));

    expect(blockAt(oak.grid, 1, 2, 1)).toBe('minecraft:oak_planks');
    expect(blockAt(stone.grid, 1, 2, 1)).toBe('minecraft:stone_bricks');
    expect(stone.grid.size).toEqual(oak.grid.size);
  });

  it('leaves the top storey open to the sky when the roof is set to none', () => {
    const { grid } = build(cottage({ roof: 'none' }));

    // No deck, so the program stops at the top of the storey.
    expect(grid.size.y).toBe(6);
    expect(blockAt(grid, 4, 5, 4)).toBe('minecraft:air');
  });

  it('compiles an empty plan to an empty build rather than failing', () => {
    const { grid, blockCount, errors } = build(createPlan({ name: 'Nothing' }));

    expect(errors).toEqual([]);
    expect(blockCount).toBe(0);
    expect(grid.size.y).toBeGreaterThan(0);
  });

  it('warns rather than throws when the building is taller than the engine allows', () => {
    const floors = Array.from({ length: 12 }, (_, index) =>
      createFloor(floorName(index), [createRoom({ x: 10, z: 10, w: 7, d: 7 })]),
    );
    const { warnings } = compilePlan(createPlan({ name: 'Tall', storeyHeight: 16, floors }));

    expect(warnings.join(' ')).toMatch(/tops out/);
  });
});
