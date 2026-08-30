/**
 * Turning a plan into a single `VoxelGrid`.
 *
 * The output is an ordinary grid, which is the whole design: the schematic writer, the build
 * guide, the mesher and "send to game" all already take one, so a plan needs no special path
 * through any of them. Compose is the only new idea in the feature.
 *
 * ## Rotation
 *
 * Two things rotate and they have to agree, or a rotated cottage comes out with its stairs
 * pointing into the wall. **Positions** rotate here; **blockstates** rotate in the registry.
 * The shared convention is a quarter turn clockwise seen from above:
 *
 *     (x, z) → (depth - 1 - z, x)
 *
 * Checked against the registry's own table rather than asserted: a vector pointing north is
 * `(0, -1)`, and the map sends it to `(1, 0)` — east. `registry.rotate` sends
 * `facing=north` to `facing=east`. Same turn, so a wall and the stairs on it stay together.
 */

import {
  AIR_BLOCK,
  voxelIndex,
  type VoxelGrid,
} from '../ir/types.js';
import { rotate } from '../registry/registry.js';
import {
  PLAN_SIZE,
  type ComposeResult,
  type PlacementBox,
  type Placement,
  type PlanComponent,
  type Quarter,
} from './types.js';

/** The footprint a component occupies once rotated. Odd quarters swap width and depth. */
export function rotatedSize(
  size: VoxelGrid['size'],
  rotation: Quarter,
): { x: number; y: number; z: number } {
  return rotation % 2 === 0
    ? { x: size.x, y: size.y, z: size.z }
    : { x: size.z, y: size.y, z: size.x };
}

/**
 * Where a source cell lands inside the rotated footprint.
 *
 * Applied as `rotation` successive quarter turns rather than as four hard-coded cases: the
 * four cases are where sign errors live, and one turn applied repeatedly cannot disagree
 * with itself.
 */
export function rotatePoint(
  x: number,
  z: number,
  size: { x: number; z: number },
  rotation: Quarter,
): { x: number; z: number } {
  let px = x;
  let pz = z;
  let width = size.x;
  let depth = size.z;

  for (let turn = 0; turn < rotation; turn++) {
    const nx = depth - 1 - pz;
    const nz = px;
    px = nx;
    pz = nz;
    // The footprint turns with the point, so the next turn measures against the new one.
    const swap = width;
    width = depth;
    depth = swap;
  }

  return { x: px, z: pz };
}

/** The box a placement occupies in plan space, inclusive of `max`. */
export function placementBox(placement: Placement, component: PlanComponent): PlacementBox {
  const size = rotatedSize(component.grid.size, placement.rotation);
  return {
    min: { ...placement.at },
    max: {
      x: placement.at.x + size.x - 1,
      y: placement.at.y + size.y - 1,
      z: placement.at.z + size.z - 1,
    },
  };
}

/**
 * Clamp a position so the placement stays on the plot.
 *
 * Used by the planner on every drag and nudge, which is what keeps `compose` from ever having
 * to report a plan too large to build. A component larger than the plot on some axis clamps
 * to 0 there rather than to a negative number.
 */
export function clampPosition(
  at: { x: number; y: number; z: number },
  size: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const axis = (value: number, extent: number, limit: number) =>
    Math.max(0, Math.min(Math.max(0, limit - extent), Math.round(value)));

  return {
    x: axis(at.x, size.x, PLAN_SIZE.x),
    y: axis(at.y, size.y, PLAN_SIZE.y),
    z: axis(at.z, size.z, PLAN_SIZE.z),
  };
}

/**
 * Compose a plan into one grid.
 *
 * Placements are stamped in order and a later one wins, but **only where it has a block**:
 * air in a later placement does not punch a hole in an earlier one. That is the difference
 * between stamping and pasting, and pasting would make it impossible to tuck a small
 * structure into the corner of a large one — the small one's bounding box is mostly air.
 */
export function composePlan(
  placements: readonly Placement[],
  components: ReadonlyMap<string, PlanComponent>,
): ComposeResult {
  const errors: string[] = [];
  const resolved: { placement: Placement; component: PlanComponent; box: PlacementBox }[] = [];

  for (const placement of placements) {
    const component = components.get(placement.sourceId);
    if (!component) {
      // Deleted from the library, or not fetched yet. Named rather than skipped quietly.
      errors.push(`A placed component is missing (${placement.sourceId}).`);
      continue;
    }
    resolved.push({ placement, component, box: placementBox(placement, component) });
  }

  if (resolved.length === 0) return { ...emptyResult(), errors };

  // Trim to what is occupied. A plan arranged in the middle of a 256³ plot must not export
  // a quarter of a million air blocks on every side.
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const { box } of resolved) {
    min.x = Math.min(min.x, box.min.x);
    min.y = Math.min(min.y, box.min.y);
    min.z = Math.min(min.z, box.min.z);
    max.x = Math.max(max.x, box.max.x);
    max.y = Math.max(max.y, box.max.y);
    max.z = Math.max(max.z, box.max.z);
  }

  const size = { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };
  const palette: string[] = [AIR_BLOCK];
  const paletteIndex = new Map<string, number>([[AIR_BLOCK, 0]]);
  const voxels = new Uint16Array(size.x * size.y * size.z);

  let blockCount = 0;
  let overlaps = 0;

  for (const { placement, component } of resolved) {
    const source = component.grid;
    const rotation = placement.rotation;

    // One mapping per placement rather than one per voxel: a rotation turns every entry in
    // the palette the same way, and `rotate` parses and re-serialises a blockstate string.
    const remap = new Uint16Array(source.palette.length);
    for (let i = 0; i < source.palette.length; i++) {
      const ref = source.palette[i] ?? AIR_BLOCK;
      if (i === 0 || ref === AIR_BLOCK) {
        remap[i] = 0;
        continue;
      }
      const turned = rotation === 0 ? ref : rotate(ref, rotation);
      let index = paletteIndex.get(turned);
      if (index === undefined) {
        index = palette.length;
        palette.push(turned);
        paletteIndex.set(turned, index);
      }
      remap[i] = index;
    }

    const originX = placement.at.x - min.x;
    const originY = placement.at.y - min.y;
    const originZ = placement.at.z - min.z;

    for (let y = 0; y < source.size.y; y++) {
      for (let z = 0; z < source.size.z; z++) {
        for (let x = 0; x < source.size.x; x++) {
          const value = source.voxels[voxelIndex(source.size, x, y, z)] ?? 0;
          if (value === 0) continue;

          const turned = rotatePoint(x, z, source.size, rotation);
          const target = voxelIndex(
            size,
            originX + turned.x,
            originY + y,
            originZ + turned.z,
          );

          if (voxels[target] !== 0) overlaps++;
          else blockCount++;
          voxels[target] = remap[value] ?? 0;
        }
      }
    }
  }

  return { grid: { size, palette, voxels }, blockCount, offset: min, overlaps, errors };
}

function emptyResult(): ComposeResult {
  return {
    // A 1³ of air rather than a zero-sized grid: every consumer indexes into this, and a
    // zero extent turns "nothing placed yet" into a division by zero somewhere downstream.
    grid: { size: { x: 1, y: 1, z: 1 }, palette: [AIR_BLOCK], voxels: new Uint16Array(1) },
    blockCount: 0,
    offset: { x: 0, y: 0, z: 0 },
    overlaps: 0,
    errors: [],
  };
}
