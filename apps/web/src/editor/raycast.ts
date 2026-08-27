/**
 * Voxel picking by grid traversal (Amanatides & Woo, 1987).
 *
 * Not `THREE.Raycaster`. Mesh raycasting would test triangles that only exist because a
 * face happened to be visible, so a pick would depend on meshing state — it would miss a
 * block hidden behind glass, and it would go stale for the frames between an edit and the
 * chunk re-mesh. Walking the grid is exact, allocation-free, and O(blocks crossed).
 */

import { voxelIndex, type VoxelGrid } from '@craftmagic/core';

/** The face of the hit block the ray entered through — where a placed block would go. */
export type VoxelFace = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';

export interface VoxelHit {
  x: number;
  y: number;
  z: number;
  face: VoxelFace;
  /**
   * True when the ray touched no block at all and landed on the ground plane instead.
   *
   * Unlike every other hit, the cell named here is *empty*: it is the floor cell a block
   * would drop into, not a block the pointer is resting on. Tools that add something can
   * take it as-is; tools that read whatever is under the pointer have nothing to read, and
   * the editor turns those away rather than letting them act on air.
   */
  ground?: true;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface RaycastOptions {
  /** In blocks. The default covers the diagonal of the largest legal structure. */
  maxDistance?: number;
  /**
   * Treat everything above this layer as air. The layer slider clips geometry with a plane
   * rather than re-meshing, so the picker has to be told about the cut separately.
   */
  maxY?: number;
  /**
   * Treat everything *below* this layer as air, for the isolate mode that shows one slice.
   * Without it the picker would happily return a block the user cannot see, and a click
   * meant for the visible slice would land on the roof of the floor below.
   */
  minY?: number;
  /**
   * Fall back to the ground plane at `minY` when the ray touches no block.
   *
   * Off by default, because a pick that names a cell with nothing in it is the wrong answer
   * to most questions. The editor turns it on, and has to: without it an empty build is an
   * inert grey box — every click misses, nothing appears, and there is no first block to
   * place a second one against.
   */
  ground?: boolean;
}

/** Neighbour of a hit, i.e. the empty cell a newly placed block would occupy. */
export const FACE_NORMAL: Readonly<Record<VoxelFace, readonly [number, number, number]>> = {
  up: [0, 1, 0],
  down: [0, -1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
};

export function raycastVoxel(
  grid: VoxelGrid,
  origin: Vec3Like,
  direction: Vec3Like,
  options: RaycastOptions = {},
): VoxelHit | null {
  const { size, voxels } = grid;
  const maxDistance = options.maxDistance ?? 1024;
  const maxY = options.maxY ?? size.y - 1;
  const minY = Math.max(0, options.minY ?? 0);
  if (maxY < minY) return null;

  const len = Math.hypot(direction.x, direction.y, direction.z);
  if (len === 0) return null;
  const dx = direction.x / len;
  const dy = direction.y / len;
  const dz = direction.z / len;

  /** The floor cell under this ray, or null. Called wherever the walk gives up. */
  const floor = () => groundCell(options, origin, dx, dy, dz, size, minY, maxDistance);

  // The camera normally orbits outside the structure, so start by skipping to the box.
  // A ray that misses the box entirely is rejected here rather than stepped.
  const entry = clipToBounds(origin, dx, dy, dz, size.x, minY, maxY + 1, size.z, maxDistance);
  if (!entry) return floor();

  // Nudge past the boundary so the floor lands inside the first cell rather than on its face.
  let t = entry.tMin;
  const px = origin.x + dx * (t + 1e-4);
  const py = origin.y + dy * (t + 1e-4);
  const pz = origin.z + dz * (t + 1e-4);

  let x = clampIndex(Math.floor(px), size.x);
  let y = Math.min(maxY, Math.max(minY, Math.floor(py)));
  let z = clampIndex(Math.floor(pz), size.z);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  // Infinity for an axis the ray does not move along keeps that axis out of the min() below.
  const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = dz === 0 ? Infinity : Math.abs(1 / dz);

  let tMaxX = dx === 0 ? Infinity : t + (dx > 0 ? x + 1 - px : px - x) * tDeltaX;
  let tMaxY = dy === 0 ? Infinity : t + (dy > 0 ? y + 1 - py : py - y) * tDeltaY;
  let tMaxZ = dz === 0 ? Infinity : t + (dz > 0 ? z + 1 - pz : pz - z) * tDeltaZ;

  // Whichever slab the ray crossed to get in is the face of the first cell it enters. When
  // the camera starts inside the structure there is no such face; the dominant axis is the
  // only defensible guess, and it is what a "place block" gesture from inside would want.
  let face: VoxelFace = entry.face ?? dominantFace(dx, dy, dz);

  while (t <= maxDistance) {
    if (voxels[voxelIndex(size, x, y, z)] !== 0) return { x, y, z, face };

    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      face = stepX > 0 ? 'west' : 'east';
      if (x < 0 || x >= size.x) return floor();
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      face = stepY > 0 ? 'down' : 'up';
      if (y < minY || y > maxY) return floor();
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      face = stepZ > 0 ? 'north' : 'south';
      if (z < 0 || z >= size.z) return floor();
    }
  }

  return floor();
}

/**
 * Where the ray crosses the floor the build stands on, as an empty cell.
 *
 * Only ever reached once the walk has established that the ray touches no block, so the
 * cell handed back is always air — when the walk left through the bottom it is the very
 * cell it tested immediately before stepping out.
 *
 * The plane is `minY`, not 0, so that isolating a layer brings the floor up with it. In
 * isolate mode the slice on screen is the only thing anyone can see, and a block dropped
 * onto a floor two hundred courses below it would vanish the moment it was placed.
 */
function groundCell(
  options: RaycastOptions,
  origin: Vec3Like,
  dx: number,
  dy: number,
  dz: number,
  size: VoxelGrid['size'],
  minY: number,
  maxDistance: number,
): VoxelHit | null {
  if (!options.ground || dy === 0) return null;

  const t = (minY - origin.y) / dy;
  if (t < 0 || t > maxDistance) return null;

  const x = Math.floor(origin.x + dx * t);
  const z = Math.floor(origin.z + dz * t);
  if (x < 0 || z < 0 || x >= size.x || z >= size.z) return null;

  // `up`, so a ground hit handed to anything that reads a face still describes the only
  // surface involved: the floor, seen from above.
  return { x, y: minY, z, face: 'up', ground: true };
}

interface BoundsEntry {
  tMin: number;
  /** Null when the origin is already inside the box. */
  face: VoxelFace | null;
}

/** Slab test against the box [0,ex]×[loY,ey]×[0,ez], returning where the ray enters it. */
function clipToBounds(
  origin: Vec3Like,
  dx: number,
  dy: number,
  dz: number,
  ex: number,
  loY: number,
  ey: number,
  ez: number,
  maxDistance: number,
): BoundsEntry | null {
  let tMin = 0;
  let tMax = maxDistance;
  let face: VoxelFace | null = null;

  const axes: readonly [number, number, number, number, VoxelFace, VoxelFace][] = [
    [origin.x, dx, 0, ex, 'west', 'east'],
    [origin.y, dy, loY, ey, 'down', 'up'],
    [origin.z, dz, 0, ez, 'north', 'south'],
  ];

  for (const [o, d, low, extent, lowFace, highFace] of axes) {
    if (d === 0) {
      if (o < low || o > extent) return null;
      continue;
    }
    let tEnter = (low - o) / d;
    let tExit = (extent - o) / d;
    let enterFace = lowFace;
    if (tEnter > tExit) {
      [tEnter, tExit] = [tExit, tEnter];
      enterFace = highFace;
    }
    if (tEnter > tMin) {
      tMin = tEnter;
      face = enterFace;
    }
    if (tExit < tMax) tMax = tExit;
    if (tMin > tMax) return null;
  }

  return { tMin, face };
}

function clampIndex(value: number, extent: number): number {
  return value < 0 ? 0 : value >= extent ? extent - 1 : value;
}

function dominantFace(dx: number, dy: number, dz: number): VoxelFace {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);
  if (ax >= ay && ax >= az) return dx > 0 ? 'west' : 'east';
  if (ay >= az) return dy > 0 ? 'down' : 'up';
  return dz > 0 ? 'north' : 'south';
}
