/**
 * Place a block against the face that was hit.
 *
 * Pure: it is handed a palette index rather than a block ref, so growing the palette stays
 * the caller's problem and this stays a function of (grid, hit) that a test can drive
 * without a registry, a renderer or React.
 */

import { AIR_INDEX, voxelIndex, type EditOp, type VoxelGrid } from '@craftmagic/core';
import { FACE_NORMAL, type VoxelHit } from '../raycast.js';
import { EditBuilder } from './op.js';

const NO_STEP = [0, 0, 0] as const;

/** The empty cell a block placed on this hit would occupy, or null if there is none. */
export function placementCell(
  grid: VoxelGrid,
  hit: VoxelHit,
): { x: number; y: number; z: number } | null {
  // A ground hit already *is* the empty cell: there is no block under the pointer to place
  // against, only the floor the build stands on. Stepping off its face would leave the
  // first block of an empty build hovering one course above the ground.
  const [dx, dy, dz] = hit.ground ? NO_STEP : FACE_NORMAL[hit.face];
  const x = hit.x + dx;
  const y = hit.y + dy;
  const z = hit.z + dz;

  const { size } = grid;
  if (x < 0 || y < 0 || z < 0 || x >= size.x || y >= size.y || z >= size.z) return null;

  // Only into air. A solid face-adjacent cell means the ray entered through a face the
  // camera cannot actually see, and overwriting it would delete a block the user never
  // pointed at — the same rule Minecraft applies, and for the same reason.
  if (grid.voxels[voxelIndex(size, x, y, z)] !== AIR_INDEX) return null;

  return { x, y, z };
}

export function place(grid: VoxelGrid, hit: VoxelHit, paletteIndex: number): EditOp | null {
  const cell = placementCell(grid, hit);
  if (!cell) return null;

  const builder = new EditBuilder(grid, 1);
  builder.setAt(cell.x, cell.y, cell.z, paletteIndex);
  return builder.build();
}
