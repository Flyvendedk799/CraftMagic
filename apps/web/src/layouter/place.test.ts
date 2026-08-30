/**
 * Placing a saved build in a layout.
 *
 * The compiler is where a placement stops being a rectangle on a plan and becomes blocks, so
 * it is where the mistakes are worth catching: a building that lands a storey off, gets
 * cropped out of the volume it needed, or quietly turns into a copy of a different one
 * because two of them shared a reference.
 */

import { describe, expect, it } from 'vitest';
import { encodePrefab, expand, type VoxelGrid } from '@craftmagic/core';
import type { Catalogue, LoadedComponent } from './components.js';
import { compilePlan } from './compile.js';
import { createPlace, createRoom, normalizePlan, placeFootprint, type LayoutPlan } from './plan.js';

function block(size: { x: number; y: number; z: number }, ref = 'minecraft:stone'): VoxelGrid {
  const voxels = new Uint16Array(size.x * size.y * size.z).fill(1);
  return { size, palette: ['minecraft:air', ref], voxels };
}

function component(id: string, name: string, size: { x: number; y: number; z: number }, ref?: string): LoadedComponent {
  return { id, name, size, prefab: encodePrefab(block(size, ref)) };
}

function planWith(items: LayoutPlan['floors'][number]['items']): LayoutPlan {
  return normalizePlan({
    version: 1,
    id: 'p',
    name: 'Test',
    site: { x: 64, z: 64 },
    storeyHeight: 5,
    wallThickness: 1,
    foundation: 0,
    roof: 'none',
    roofPitch: 'classic',
    roofOverhang: 0,
    kitId: 'oak',
    floors: [{ id: 'f1', name: 'Ground', items }],
    updatedAt: new Date().toISOString(),
  });
}

const SHED = component('build-a', 'Shed', { x: 4, y: 3, z: 2 });

describe('compiling a placed build', () => {
  it('emits one prefab entry and one component', () => {
    const plan = planWith([
      createRoom({ x: 0, z: 0, w: 10, d: 10 }),
      createPlace(20, 20, { id: 'build-a', name: 'Shed', w: 4, d: 2, h: 3 }),
    ]);

    const { program } = compilePlan(plan, new Map([['build-a', SHED]]) as Catalogue);

    expect(Object.keys(program.prefabs ?? {})).toEqual(['b1']);
    const placed = program.components.filter((c) => c.type === 'prefab');
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ type: 'prefab', ref: 'b1' });
  });

  it('stores one copy however many times a build is placed', () => {
    // The whole reason the table exists. Four corner towers must not be four copies of the
    // tower's blocks in a program that goes into Postgres and past a language model.
    const plan = planWith([
      createRoom({ x: 0, z: 0, w: 10, d: 10 }),
      createPlace(20, 20, { id: 'build-a', name: 'Shed', w: 4, d: 2, h: 3 }),
      createPlace(30, 20, { id: 'build-a', name: 'Shed', w: 4, d: 2, h: 3 }),
      createPlace(20, 30, { id: 'build-a', name: 'Shed', w: 4, d: 2, h: 3 }),
      createPlace(30, 30, { id: 'build-a', name: 'Shed', w: 4, d: 2, h: 3 }),
    ]);

    const { program } = compilePlan(plan, new Map([['build-a', SHED]]) as Catalogue);

    expect(Object.keys(program.prefabs ?? {})).toHaveLength(1);
    expect(program.components.filter((c) => c.type === 'prefab')).toHaveLength(4);
  });

  it('gives two different builds two different references', () => {
    const barn = component('build-b', 'Barn', { x: 3, y: 2, z: 3 }, 'minecraft:oak_planks');
    const plan = planWith([
      createRoom({ x: 0, z: 0, w: 10, d: 10 }),
      createPlace(20, 20, { id: 'build-a', name: 'Shed', w: 4, d: 2, h: 3 }),
      createPlace(30, 20, { id: 'build-b', name: 'Barn', w: 3, d: 3, h: 2 }),
    ]);

    const { program } = compilePlan(
      plan,
      new Map([
        ['build-a', SHED],
        ['build-b', barn],
      ]) as Catalogue,
    );

    const refs = program.components.filter((c) => c.type === 'prefab').map((c) => (c as { ref: string }).ref);
    expect(new Set(refs).size).toBe(2);
    expect(Object.keys(program.prefabs ?? {})).toHaveLength(2);
  });

  it('actually builds the blocks it placed', () => {
    const plan = planWith([
      createRoom({ x: 0, z: 0, w: 10, d: 10 }),
      createPlace(20, 20, { id: 'build-a', name: 'Shed', w: 4, d: 2, h: 3 }),
    ]);

    const withShed = compilePlan(plan, new Map([['build-a', SHED]]) as Catalogue);
    const withoutShed = compilePlan(planWith([createRoom({ x: 0, z: 0, w: 10, d: 10 })]));

    const built = expand(withShed.program);
    const bare = expand(withoutShed.program);

    expect(built.errors).toEqual([]);
    // A solid 4x3x2 shed is 24 blocks on top of whatever the room drew.
    expect(built.blockCount - bare.blockCount).toBe(24);
  });

  it('makes the volume tall enough for something taller than the roof', () => {
    // A spire on the top floor is not bound by the storey it stands on. If the volume is
    // sized to the architecture alone, the top of it is clipped away in silence.
    const spire = component('build-c', 'Spire', { x: 2, y: 40, z: 2 });
    const plan = planWith([
      createRoom({ x: 0, z: 0, w: 10, d: 10 }),
      createPlace(4, 4, { id: 'build-c', name: 'Spire', w: 2, d: 2, h: 40 }),
    ]);

    const { program } = compilePlan(plan, new Map([['build-c', spire]]) as Catalogue);
    expect(program.size.y).toBeGreaterThanOrEqual(41);

    const built = expand(program);
    expect(built.errors).toEqual([]);
    // Every one of the spire's 160 blocks survives.
    const bare = expand(compilePlan(planWith([createRoom({ x: 0, z: 0, w: 10, d: 10 })])).program);
    expect(built.blockCount - bare.blockCount).toBe(160);
  });

  it('keeps a placement inside the cropped footprint', () => {
    // The compiler crops the build to what is drawn. A placement well away from every room
    // has to widen that, or it is cropped off the edge of its own building.
    const plan = planWith([
      createRoom({ x: 0, z: 0, w: 6, d: 6 }),
      createPlace(40, 40, { id: 'build-a', name: 'Shed', w: 4, d: 2, h: 3 }),
    ]);

    const compiled = compilePlan(plan, new Map([['build-a', SHED]]) as Catalogue);
    const built = expand(compiled.program);

    expect(built.errors).toEqual([]);
    const bare = expand(compilePlan(planWith([createRoom({ x: 0, z: 0, w: 6, d: 6 })])).program);
    expect(built.blockCount - bare.blockCount).toBe(24);
  });

  it('says so, rather than failing, while a build is still loading', () => {
    const plan = planWith([
      createRoom({ x: 0, z: 0, w: 10, d: 10 }),
      createPlace(20, 20, { id: 'build-a', name: 'Shed', w: 4, d: 2, h: 3 }),
    ]);

    // No catalogue: the fetch has not landed.
    const compiled = compilePlan(plan);

    expect(compiled.program.components.filter((c) => c.type === 'prefab')).toHaveLength(0);
    expect(compiled.warnings.join(' ')).toContain('Shed');
    // And the rest of the building still compiles and still builds.
    expect(expand(compiled.program).errors).toEqual([]);
  });

  it('tags the component with the plan item, so a click in 3D finds its way back', () => {
    const plan = planWith([
      createRoom({ x: 0, z: 0, w: 10, d: 10 }),
      createPlace(20, 20, { id: 'build-a', name: 'Shed', w: 4, d: 2, h: 3 }),
    ]);
    const item = plan.floors[0]!.items.find((i) => i.kind === 'place')!;

    const { program } = compilePlan(plan, new Map([['build-a', SHED]]) as Catalogue);
    const placed = program.components.find((c) => c.type === 'prefab')!;

    expect(placed.id).toBe(item.id);
    expect(placed.label).toBe('Shed');
  });
});

describe('placeFootprint', () => {
  it('is the build’s footprint, unturned', () => {
    const item = createPlace(5, 7, { id: 'a', name: 'Shed', w: 4, d: 2, h: 3 });
    expect(placeFootprint(item)).toEqual({ x: 5, z: 7, w: 4, d: 2 });
  });

  it('swaps width and depth on an odd quarter, keeping the corner', () => {
    const item = createPlace(5, 7, { id: 'a', name: 'Shed', w: 4, d: 2, h: 3 }, { turns: 1 });
    expect(placeFootprint(item)).toEqual({ x: 5, z: 7, w: 2, d: 4 });
  });

  it('prefers the library’s size once it has arrived', () => {
    // The plan's copy is what a saved layout remembers; the library's is the truth. A build
    // that has been edited since it was placed must draw at the size it is now.
    const item = createPlace(0, 0, { id: 'a', name: 'Shed', w: 4, d: 2, h: 3 });
    expect(placeFootprint(item, { w: 9, d: 6 })).toEqual({ x: 0, z: 0, w: 9, d: 6 });
  });
});
