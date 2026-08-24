/**
 * Erase the voxel that was hit.
 *
 * The hit cell itself, not the face-adjacent one — `place` and `erase` are deliberately the
 * two sides of the same pick, which is what makes clicking around a build feel predictable.
 */

import { AIR_INDEX, type EditOp, type VoxelGrid } from '@craftmagic/core';
import type { VoxelHit } from '../raycast.js';
import { EditBuilder } from './op.js';

export function erase(grid: VoxelGrid, hit: VoxelHit): EditOp | null {
  const builder = new EditBuilder(grid, 1);
  builder.setAt(hit.x, hit.y, hit.z, AIR_INDEX);
  return builder.build();
}
