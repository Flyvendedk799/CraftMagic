import { describe, expect, it } from 'vitest';
import { voxelIndex, type VoxelGrid } from '@craftmagic/core';
import { EditBuilder } from './op.js';
import { withMirror } from './symmetry.js';

function gridOf(x: number): VoxelGrid {
  return {
    size: { x, y: 4, z: 4 },
    palette: ['minecraft:air', 'minecraft:stone', 'minecraft:oak_stairs[facing=east]'],
    voxels: new Uint16Array(x * 4 * 4),
  };
}

function opAt(grid: VoxelGrid, cells: [number, number, number, number][]) {
  const builder = new EditBuilder(grid, cells.length);
  for (const [x, y, z, v] of cells) builder.setAt(x, y, z, v);
  return builder.build();
}

describe('withMirror', () => {
  it('doubles a placement across the X midplane', () => {
    const grid = gridOf(8);
    const resolve = (ref: string) => grid.palette.indexOf(ref);
    const mirrored = withMirror(grid, opAt(grid, [[1, 0, 2, 1]]), resolve);

    expect(mirrored).not.toBeNull();
    expect(mirrored!.indices.length).toBe(2);
    const indices = [...mirrored!.indices];
    expect(indices).toContain(voxelIndex(grid.size, 1, 0, 2));
    expect(indices).toContain(voxelIndex(grid.size, 6, 0, 2));
  });

  it('flips blockstates in the reflection', () => {
    const grid = gridOf(8);
    const resolved: string[] = [];
    const resolve = (ref: string) => {
      resolved.push(ref);
      const at = grid.palette.indexOf(ref);
      if (at >= 0) return at;
      grid.palette.push(ref);
      return grid.palette.length - 1;
    };

    const mirrored = withMirror(grid, opAt(grid, [[0, 0, 0, 2]]), resolve);
    expect(mirrored).not.toBeNull();
    // The east-facing stair's twin faces west.
    expect(resolved.some((ref) => ref.includes('facing=west'))).toBe(true);
  });

  it('writes a midplane cell once on an odd-width build', () => {
    const grid = gridOf(7);
    const mirrored = withMirror(grid, opAt(grid, [[3, 1, 1, 1]]), () => -1);
    expect(mirrored!.indices.length).toBe(1);
  });

  it('mirrors an erase without touching the palette', () => {
    const grid = gridOf(8);
    grid.voxels[voxelIndex(grid.size, 2, 0, 0)] = 1;
    grid.voxels[voxelIndex(grid.size, 5, 0, 0)] = 1;
    let resolved = 0;
    const mirrored = withMirror(grid, opAt(grid, [[2, 0, 0, 0]]), () => (resolved++, -1));
    expect(mirrored!.indices.length).toBe(2);
    expect(resolved).toBe(0);
  });

  it('passes a null op through', () => {
    expect(withMirror(gridOf(8), null, () => -1)).toBeNull();
  });
});
