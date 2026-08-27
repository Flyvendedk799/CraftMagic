/**
 * Starting points.
 *
 * The level editor engine ships builtin map packs alongside the empty editor
 * (`public/custom-maps/builtin/` in flyvendedk799/firstpgame) for a reason that applies just
 * as much here: an empty grid teaches nobody the vocabulary. A two-room cottage with a stair
 * in it shows what a room, a shared wall, a doorway and a staircase *are* in about two
 * seconds, and the fastest way to learn a plan tool is to take one apart.
 *
 * They are plain data rather than a fixture format, so a template is a plan like any other:
 * loaded, edited, undone and exported through exactly the same path as something drawn by
 * hand. Each one is laid out to validate clean — every room reachable, every storey served by
 * a stair — because a starting point that opens with three warnings teaches the wrong lesson.
 */

import {
  createDoor,
  createColumn,
  createFloor,
  createPlan,
  createRoom,
  createStair,
  createWindow,
  floorName,
  type LayoutPlan,
} from './plan.js';

export interface Template {
  id: string;
  name: string;
  description: string;
  build: () => LayoutPlan;
}

export const TEMPLATES: readonly Template[] = [
  {
    id: 'blank',
    name: 'Empty site',
    description: 'One storey, nothing on it.',
    build: () => createPlan({ name: 'Untitled layout' }),
  },

  {
    id: 'studio',
    name: 'Studio',
    description: 'A single room, a door and two windows — the smallest complete building.',
    build: () =>
      createPlan({
        name: 'Studio',
        kitId: 'oak-cottage',
        roof: 'gable',
        floors: [
          createFloor(floorName(0), [
            createRoom({ x: 18, z: 18, w: 12, d: 10 }, { label: 'Studio' }),
            createDoor(23, 27, 'south'),
            createWindow('x', 21, 18, { length: 3 }),
            createWindow('z', 18, 21, { length: 3 }),
          ]),
        ],
      }),
  },

  {
    id: 'cottage',
    name: 'Two-room cottage',
    description: 'Two rooms sharing a wall, a stair, and a bedroom floor above.',
    build: () =>
      createPlan({
        name: 'Cottage',
        kitId: 'oak-cottage',
        roof: 'gable',
        floors: [
          createFloor(floorName(0), [
            createRoom({ x: 16, z: 16, w: 9, d: 11 }, { label: 'Living' }),
            // Left edge on the first room's right edge, so the two share one wall rather than
            // growing two with a cavity between — the arrangement `snapRoomRect` produces.
            createRoom({ x: 24, z: 16, w: 8, d: 11 }, { label: 'Kitchen' }),
            createDoor(19, 26, 'south'),
            createDoor(24, 20, 'east', { open: true }),
            createWindow('x', 18, 16, { length: 3 }),
            createWindow('x', 27, 16, { length: 3 }),
            createStair(25, 25, 'north', { width: 2 }),
          ]),
          createFloor(floorName(1), [
            createRoom({ x: 16, z: 16, w: 9, d: 11 }, { label: 'Bedroom' }),
            createRoom({ x: 24, z: 16, w: 8, d: 11 }, { label: 'Landing' }),
            createDoor(24, 20, 'east', { open: true }),
            createWindow('x', 18, 26, { length: 3 }),
            createWindow('z', 31, 19, { length: 3 }),
          ]),
        ],
      }),
  },

  {
    id: 'watchtower',
    name: 'Watchtower',
    description: 'Three stone storeys with the stair reversing at each landing.',
    build: () =>
      createPlan({
        name: 'Watchtower',
        kitId: 'stone-keep',
        roof: 'hip',
        storeyHeight: 6,
        wallThickness: 2,
        foundation: 2,
        floors: [
          createFloor(floorName(0), [
            createRoom({ x: 19, z: 19, w: 11, d: 11 }, { label: 'Guard room' }),
            createDoor(23, 28, 'south', { width: 2 }),
            createStair(21, 21, 'east', { width: 2 }),
          ]),
          createFloor(floorName(1), [
            createRoom({ x: 19, z: 19, w: 11, d: 11 }, { label: 'Quarters' }),
            createWindow('x', 22, 19, { length: 2, sill: 2 }),
            // Reversed, and at the far end of the room, so it never lands in the well the
            // storey below cut through this slab. The bottom step is at x 27 rather than 28
            // because the walls here are two blocks thick: 28 is masonry, not floor.
            createStair(27, 26, 'west', { width: 2 }),
          ]),
          createFloor(floorName(2), [
            createRoom({ x: 19, z: 19, w: 11, d: 11 }, { label: 'Lookout' }),
            createWindow('x', 22, 19, { length: 4, sill: 2 }),
            createWindow('x', 22, 28, { length: 4, sill: 2 }),
            createWindow('z', 19, 22, { length: 4, sill: 2 }),
            createWindow('z', 28, 22, { length: 4, sill: 2 }),
          ]),
        ],
      }),
  },

  {
    id: 'office',
    name: 'Office bay',
    description: 'Open plan on a column grid, with a service core and a glazed facade.',
    build: () =>
      createPlan({
        name: 'Office bay',
        kitId: 'modern-concrete',
        roof: 'flat',
        storeyHeight: 6,
        foundation: 0,
        floors: [
          createFloor(floorName(0), [
            createRoom({ x: 12, z: 16, w: 26, d: 18 }, { label: 'Open plan' }),
            createRoom({ x: 30, z: 20, w: 7, d: 9 }, { label: 'Core', wallRole: 'wall_secondary' }),
            createDoor(20, 33, 'south', { width: 2 }),
            createDoor(30, 23, 'east', { open: true }),
            createWindow('x', 15, 16, { length: 8, sill: 1, height: 3 }),
            createWindow('x', 25, 16, { length: 8, sill: 1, height: 3 }),
            createWindow('z', 12, 20, { length: 10, sill: 1, height: 3 }),
            createColumn(19, 22, { size: 1 }),
            createColumn(19, 28, { size: 1 }),
            createColumn(25, 22, { size: 1 }),
            createColumn(25, 28, { size: 1 }),
          ]),
        ],
      }),
  },
] as const;

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
