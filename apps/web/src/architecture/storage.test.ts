import { describe, expect, it } from 'vitest';
import { parsePlanFile, planFilename } from './storage.js';
import { createFloor, createPlan, createRoom, floorName } from './plan.js';

describe('planFilename', () => {
  it('slugs the plan name', () => {
    expect(planFilename(createPlan({ name: 'Corner Shop — v2' }))).toBe('corner-shop-v2.layout.json');
  });

  it('falls back rather than producing a dotfile for a name with nothing in it', () => {
    expect(planFilename(createPlan({ name: '///' }))).toBe('layout.layout.json');
  });
});

describe('parsePlanFile', () => {
  it('reads back a plan it wrote', () => {
    const plan = createPlan({
      name: 'Imported',
      floors: [createFloor(floorName(0), [createRoom({ x: 4, z: 4, w: 8, d: 6 })])],
    });

    const parsed = parsePlanFile(JSON.stringify(plan));

    expect(parsed.name).toBe('Imported');
    expect(parsed.floors[0]!.items).toHaveLength(1);
  });

  it('normalizes an imported plan rather than trusting it', () => {
    const parsed = parsePlanFile(
      JSON.stringify({ name: 'Hostile', site: { x: 9999, z: 9999 }, floors: [{ items: [] }] }),
    );

    expect(parsed.site.x).toBeLessThanOrEqual(192);
    expect(parsed.version).toBe(1);
  });

  it('explains what is wrong instead of throwing a parser error at the user', () => {
    expect(() => parsePlanFile('not json at all')).toThrow(/not JSON/);
    expect(() => parsePlanFile('{"hello":"world"}')).toThrow(/no floors/);
  });
});
