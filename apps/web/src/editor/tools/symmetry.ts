/**
 * Symmetry mode: every edit lands twice, mirrored across the build's X midplane.
 *
 * Half of building is building the same thing twice, and this is the mode that stops that.
 * It is deliberately a *transform on the op*, not a feature of any tool: whatever a tool
 * produced, the mirror produces the reflection — positions flipped about the midplane and
 * blockstates flipped with `registry.mirror`, so a west-facing stair's twin faces east.
 *
 * Cells on the midplane itself (odd-width builds) are written once, and a mirrored block
 * whose ref cannot be resolved into the palette is skipped rather than failing the edit.
 */

import { AIR_BLOCK, mirror, type BlockRef, type EditOp, type VoxelGrid } from '@craftmagic/core';
import { EditBuilder } from './op.js';

export function withMirror(
  grid: VoxelGrid,
  op: EditOp | null,
  resolve: (ref: BlockRef) => number,
): EditOp | null {
  if (!op) return op;

  const { size } = grid;
  const layer = size.x * size.z;
  const builder = new EditBuilder(grid, op.indices.length * 2);

  for (let i = 0; i < op.indices.length; i++) {
    const index = op.indices[i]!;
    const value = op.after[i]!;
    builder.set(index, value);

    const y = Math.floor(index / layer);
    const rem = index - y * layer;
    const z = Math.floor(rem / size.x);
    const x = rem - z * size.x;
    const mx = size.x - 1 - x;
    if (mx === x) continue;

    // Air mirrors to air with no palette work; anything else flips its states.
    let mirroredValue = value;
    if (value !== 0) {
      const ref = grid.palette[value] ?? AIR_BLOCK;
      const flipped = mirror(ref, 'x');
      mirroredValue = flipped === ref ? value : resolve(flipped);
      if (mirroredValue < 0) continue; // Palette full — the original half still lands.
    }
    builder.setAt(mx, y, z, mirroredValue);
  }

  return builder.build();
}
