import { describe, expect, it } from 'vitest';
import { validatePlan } from './validate.js';
import {
  createDoor,
  createFloor,
  createRoom,
  createPlan,
  createStair,
  createWindow,
  floorName,
  type LayoutPlan,
} from './plan.js';

function codes(plan: LayoutPlan): string[] {
  return validatePlan(plan).issues.map((issue) => issue.code);
}

/** Two rooms sharing a wall, with a front door into the first one. */
function pair(interiorDoor: boolean): LayoutPlan {
  return createPlan({
    name: 'Pair',
    wallThickness: 1,
    floors: [
      createFloor(floorName(0), [
        createRoom({ x: 10, z: 10, w: 9, d: 9 }, { label: 'Front' }),
        createRoom({ x: 18, z: 10, w: 9, d: 9 }, { label: 'Back' }),
        createDoor(13, 18, 'south'),
        ...(interiorDoor ? [createDoor(18, 14, 'east', { open: true })] : []),
      ]),
    ],
  });
}

describe('validatePlan', () => {
  it('finds the room you cannot get to', () => {
    const result = validatePlan(pair(false));

    expect(result.issues.map((issue) => issue.code)).toContain('room_unreachable');
    // Named, so the message is about a room rather than about a coordinate.
    expect(result.issues.find((issue) => issue.code === 'room_unreachable')?.message).toContain('Back');
    expect(result.unreachable.size).toBe(1);
  });

  it('clears both rooms once a doorway joins them', () => {
    const result = validatePlan(pair(true));

    expect(result.issues.map((issue) => issue.code)).not.toContain('room_unreachable');
    expect(result.unreachable.size).toBe(0);
  });

  it('does not walk through a window', () => {
    const sealed = createPlan({
      name: 'Sealed',
      floors: [
        createFloor(floorName(0), [
          createRoom({ x: 10, z: 10, w: 9, d: 9 }, { label: 'Front' }),
          createRoom({ x: 18, z: 10, w: 9, d: 9 }, { label: 'Back' }),
          createDoor(13, 18, 'south'),
          createWindow('z', 18, 14, { length: 2 }),
        ]),
      ],
    });

    expect(codes(sealed)).toContain('room_unreachable');
  });

  it('flags a building with no way in', () => {
    const plan = createPlan({
      name: 'Sealed',
      floors: [createFloor(floorName(0), [createRoom({ x: 10, z: 10, w: 9, d: 9 })])],
    });

    expect(codes(plan)).toContain('no_entrance');
  });

  it('flags a storey nothing climbs to', () => {
    const plan = createPlan({
      name: 'Two up',
      floors: [
        createFloor(floorName(0), [
          createRoom({ x: 10, z: 10, w: 9, d: 9 }),
          createDoor(13, 18, 'south'),
        ]),
        createFloor(floorName(1), [createRoom({ x: 10, z: 10, w: 9, d: 9 })]),
      ],
    });

    expect(codes(plan)).toContain('floor_unreachable');
  });

  it('is satisfied once a stair serves the storey above', () => {
    const plan = createPlan({
      name: 'Two up',
      storeyHeight: 5,
      roof: 'none',
      floors: [
        createFloor(floorName(0), [
          createRoom({ x: 10, z: 10, w: 11, d: 11 }),
          createDoor(13, 20, 'south'),
          createStair(12, 12, 'south', { width: 2 }),
        ]),
        createFloor(floorName(1), [createRoom({ x: 10, z: 10, w: 11, d: 11 })]),
      ],
    });

    const result = codes(plan);
    expect(result).not.toContain('floor_unreachable');
    expect(result).not.toContain('room_unreachable');
  });

  it('catches an aperture that is not in a wall', () => {
    const plan = createPlan({
      name: 'Floating',
      floors: [
        createFloor(floorName(0), [
          createRoom({ x: 10, z: 10, w: 9, d: 9 }),
          createDoor(13, 18, 'south'),
          createWindow('x', 40, 40, { length: 2 }),
        ]),
      ],
    });

    expect(codes(plan)).toContain('window_floating');
  });

  it('catches a room too small to have an inside', () => {
    const plan = createPlan({
      name: 'Closet',
      wallThickness: 1,
      floors: [createFloor(floorName(0), [createRoom({ x: 10, z: 10, w: 2, d: 2 })])],
    });

    expect(codes(plan)).toContain('room_solid');
  });

  it('says nothing about an empty plan beyond that it is empty', () => {
    const result = validatePlan(createPlan({ name: 'Nothing' }));

    expect(result.issues.every((issue) => issue.level === 'info')).toBe(true);
  });
});
