import { describe, expect, it } from 'vitest';
import {
  addItem,
  countItems,
  createFloor,
  createPlan,
  createRoom,
  findItem,
  floorName,
  normalizePlan,
  removeItem,
  replaceItem,
} from './plan.js';

describe('normalizePlan', () => {
  it('clamps the site, then clamps every item against it', () => {
    const plan = normalizePlan({
      site: { x: 4000, z: 2 },
      floors: [{ name: 'Ground', items: [{ kind: 'room', rect: { x: 900, z: 900, w: 500, d: 500 } }] }],
    });

    expect(plan.site.x).toBe(192);
    expect(plan.site.z).toBe(16);

    const room = plan.floors[0]!.items[0]!;
    expect(room.kind).toBe('room');
    if (room.kind !== 'room') return;
    expect(room.rect.x).toBeLessThan(plan.site.x);
    expect(room.rect.x + room.rect.w).toBeLessThanOrEqual(plan.site.x);
    expect(room.rect.z + room.rect.d).toBeLessThanOrEqual(plan.site.z);
  });

  it('drops an item kind it does not recognise without losing the rest', () => {
    const plan = normalizePlan({
      floors: [
        {
          name: 'Ground',
          items: [
            { kind: 'room', rect: { x: 1, z: 1, w: 5, d: 5 } },
            { kind: 'hologram_projector', x: 3, z: 3 },
            { kind: 'column', x: 2, z: 2 },
          ],
        },
      ],
    });

    expect(plan.floors[0]!.items.map((item) => item.kind)).toEqual(['room', 'column']);
  });

  it('always leaves at least one storey to draw on', () => {
    expect(normalizePlan({ floors: [] }).floors).toHaveLength(1);
    expect(normalizePlan(null).floors).toHaveLength(1);
  });

  it('survives complete rubbish', () => {
    const plan = normalizePlan({ site: 'large', storeyHeight: 'tall', floors: 'some' });

    expect(plan.storeyHeight).toBeGreaterThanOrEqual(3);
    expect(plan.floors).toHaveLength(1);
  });

  it('round-trips a plan it produced', () => {
    const plan = createPlan({
      name: 'Round trip',
      floors: [createFloor(floorName(0), [createRoom({ x: 5, z: 5, w: 9, d: 7 }, { label: 'Hall' })])],
    });

    expect(normalizePlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });
});

describe('item edits', () => {
  const room = createRoom({ x: 5, z: 5, w: 6, d: 6 });
  const plan = addItem(createPlan({ name: 'Edits' }), 0, room);

  it('finds an item and the storey it is on', () => {
    expect(findItem(plan, room.id)?.floorIndex).toBe(0);
    expect(findItem(plan, 'nope')).toBeNull();
  });

  it('replaces in place without disturbing the rest', () => {
    const next = replaceItem(plan, room.id, { ...room, label: 'Renamed' });
    const found = findItem(next, room.id)?.item;

    expect(found?.kind === 'room' && found.label).toBe('Renamed');
    expect(countItems(next)).toBe(1);
  });

  it('removes by id', () => {
    expect(countItems(removeItem(plan, room.id))).toBe(0);
    // An id that is not there leaves the plan alone rather than throwing.
    expect(countItems(removeItem(plan, 'nope'))).toBe(1);
  });
});
