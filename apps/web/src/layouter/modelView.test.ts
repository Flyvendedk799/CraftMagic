import { describe, expect, it } from 'vitest';
import { modelView, storeyBand } from './modelView.js';
import { createColumn, createPlan, createRoom, type LayoutPlan, type PlanItem } from './plan.js';

/** Two storeys of 5, on a 1-block plinth: slabs at y=1 and y=6, roof deck at y=11. */
function plan(overrides: Partial<LayoutPlan> = {}): LayoutPlan {
  return createPlan({ storeyHeight: 5, foundation: 1, wallThickness: 1, ...overrides });
}

/** A grid big enough not to clamp anything, with the build starting at plan (0,0). */
const GRID = { x: 64, y: 40, z: 64 };
const AT_ORIGIN = { x: 0, z: 0 };

const view = (mode: 'whole' | 'storey' | 'room', floorIndex = 0, selected: PlanItem | null = null) =>
  modelView({ plan: plan(), mode, floorIndex, selected, grid: GRID, origin: AT_ORIGIN });

describe('storeyBand', () => {
  it('starts at the slab, so the floor you stand on survives the cut', () => {
    expect(storeyBand(plan(), 0)).toEqual({ min: 1, max: 5 });
  });

  it('ends one below the slab above, so the ceiling comes off', () => {
    // Storey 1's slab is at y=6. Storey 0 must stop at 5 or you are looking at a lid.
    expect(storeyBand(plan(), 1)).toEqual({ min: 6, max: 10 });
  });

  it('follows the plinth up', () => {
    expect(storeyBand(plan({ foundation: 4 }), 0).min).toBe(4);
  });
});

describe('modelView', () => {
  it('cuts nothing at all in Whole', () => {
    expect(view('whole')).toEqual({ clip: null, focus: null, fallback: null });
  });

  it('cuts the storey top and bottom, and leaves x and z uncut', () => {
    const { clip } = view('storey', 1);
    expect(clip).toEqual({ minY: 6, maxY: 10 });
  });

  it('never cuts above a build that is shorter than the storey it names', () => {
    const short = modelView({
      plan: plan(),
      mode: 'storey',
      floorIndex: 1,
      selected: null,
      grid: { ...GRID, y: 9 },
      origin: AT_ORIGIN,
    });
    expect(short.clip?.maxY).toBe(8);
  });

  it('boxes a room in on all six faces, walls included', () => {
    const room = createRoom({ x: 10, z: 4, w: 6, d: 8 });
    const { clip, fallback } = view('room', 0, room);
    expect(fallback).toBeNull();
    // Inclusive, so a 6-wide room at x=10 covers 10..15.
    expect(clip).toEqual({ minY: 1, maxY: 5, minX: 10, maxX: 15, minZ: 4, maxZ: 11 });
  });

  it('frames what it boxed, or the room would be a fingernail in an empty viewport', () => {
    const room = createRoom({ x: 10, z: 4, w: 6, d: 8 });
    expect(view('room', 0, room).focus).toEqual({
      min: { x: 10, y: 1, z: 4 },
      max: { x: 15, y: 5, z: 11 },
    });
  });

  it('falls back to the storey, and says why, when nothing is selected', () => {
    const { clip, focus, fallback } = view('room', 0, null);
    expect(clip).toEqual({ minY: 1, maxY: 5 });
    expect(focus).toBeNull();
    expect(fallback).toMatch(/select a room/i);
  });

  it('falls back for a selection that is not a room, and names what it is', () => {
    const { fallback } = view('room', 0, createColumn(3, 3));
    expect(fallback).toContain('column');
  });
});

describe('modelView in grid space', () => {
  it('subtracts the compiler origin, or the box lands beside the building', () => {
    const room = createRoom({ x: 30, z: 20, w: 6, d: 8 });
    // The compiler crops to what is drawn plus an eave, so this build starts at plan (28, 18).
    const { clip } = modelView({
      plan: plan(),
      mode: 'room',
      floorIndex: 0,
      selected: room,
      grid: GRID,
      origin: { x: 28, z: 18 },
    });
    expect(clip).toMatchObject({ minX: 2, maxX: 7, minZ: 2, maxZ: 9 });
  });

  it('clamps to the grid, so a box can never start past its far edge', () => {
    const room = createRoom({ x: 30, z: 30, w: 8, d: 8 });
    const { clip } = modelView({
      plan: plan(),
      mode: 'room',
      floorIndex: 0,
      selected: room,
      grid: { x: 6, y: 40, z: 6 },
      origin: { x: 0, z: 0 },
    });
    expect(clip).toMatchObject({ minX: 5, maxX: 5, minZ: 5, maxZ: 5 });
  });

  it('frames the same box it cut', () => {
    const room = createRoom({ x: 30, z: 20, w: 6, d: 8 });
    const { clip, focus } = modelView({
      plan: plan(),
      mode: 'room',
      floorIndex: 0,
      selected: room,
      grid: GRID,
      origin: { x: 28, z: 18 },
    });
    expect(focus!.min).toEqual({ x: clip!.minX, y: clip!.minY, z: clip!.minZ });
    expect(focus!.max).toEqual({ x: clip!.maxX, y: clip!.maxY, z: clip!.maxZ });
  });
});
