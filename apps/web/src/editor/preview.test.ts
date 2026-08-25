import { describe, expect, it } from 'vitest';
import { voxelIndex, type VoxelGrid } from '@craftmagic/core';
import { PREVIEW_CELL_CAP, previewFor } from './preview.js';
import { copyRegion } from './tools/clipboard.js';
import type { VoxelHit } from './raycast.js';

function grid16(): VoxelGrid {
  const size = { x: 16, y: 16, z: 16 };
  const voxels = new Uint16Array(size.x * size.y * size.z);
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) voxels[voxelIndex(size, x, 0, z)] = 1;
  }
  return { size, palette: ['minecraft:air', 'minecraft:stone'], voxels };
}

const onFloor: VoxelHit = { x: 8, y: 0, z: 8, face: 'up' };

function base(grid: VoxelGrid) {
  return { grid, hover: onFloor, anchor: null, radius: 0, shape: 'ball' as const, clip: null };
}

describe('previewFor', () => {
  it('is null with nothing under the pointer', () => {
    expect(previewFor({ ...base(grid16()), tool: 'place', hover: null })).toBeNull();
  });

  it('previews place at the cell a block would go into', () => {
    const preview = previewFor({ ...base(grid16()), tool: 'place' });
    expect(preview).toEqual({ kind: 'cells', cells: [{ x: 8, y: 1, z: 8 }], label: '1 block' });
  });

  it('place shows only the part of a wide brush that lands in air', () => {
    const preview = previewFor({ ...base(grid16()), tool: 'place', radius: 1, shape: 'cube' });
    // A 3x3x3 brush centred one above the floor: the bottom slice is the floor itself.
    expect(preview!.kind).toBe('cells');
    expect((preview as { cells: unknown[] }).cells).toHaveLength(18);
  });

  it('erase shows only the solid part of the brush', () => {
    const preview = previewFor({ ...base(grid16()), tool: 'erase', radius: 1, shape: 'cube' });
    expect((preview as { cells: unknown[] }).cells).toHaveLength(9);
  });

  it('erase over nothing previews nothing', () => {
    const grid = grid16();
    const preview = previewFor({
      ...base(grid),
      tool: 'erase',
      hover: { x: 8, y: 8, z: 8, face: 'up' },
    });
    expect(preview).toBeNull();
  });

  it('a line previews its whole path once both ends are known', () => {
    const preview = previewFor({
      ...base(grid16()),
      tool: 'line',
      anchor: { x: 0, y: 0, z: 8 },
    });
    expect(preview).toEqual(
      expect.objectContaining({ kind: 'cells', label: '9 blocks' }),
    );
  });

  it('a line with no anchor previews the brush footprint', () => {
    const preview = previewFor({ ...base(grid16()), tool: 'line', radius: 1, shape: 'cube' });
    expect((preview as { cells: unknown[] }).cells).toHaveLength(18);
  });

  it('a box previews nothing until a corner is taken, then its extent', () => {
    expect(previewFor({ ...base(grid16()), tool: 'select' })).toBeNull();

    const preview = previewFor({
      ...base(grid16()),
      tool: 'select',
      anchor: { x: 4, y: 0, z: 4 },
    });
    expect(preview).toEqual({
      kind: 'box',
      min: { x: 4, y: 0, z: 4 },
      max: { x: 8, y: 0, z: 8 },
      label: '5×1×5 · 25 cells',
    });
  });

  it('a stamp previews the clip box where it would land', () => {
    const grid = grid16();
    const clip = copyRegion(grid, { x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: 3 });
    const preview = previewFor({ ...base(grid), tool: 'stamp', clip });
    // Stamped against the face that was hit, so the clip sits on top of the floor.
    expect(preview).toEqual({
      kind: 'box',
      min: { x: 8, y: 1, z: 8 },
      max: { x: 10, y: 2, z: 11 },
      label: '3×2×4 · 12 blocks',
    });
  });

  it('a stamp with an empty clipboard previews nothing', () => {
    expect(previewFor({ ...base(grid16()), tool: 'stamp' })).toBeNull();
  });

  it('falls back to a bounding box once there are too many cells to draw', () => {
    const size = { x: 64, y: 64, z: 64 };
    const grid: VoxelGrid = {
      size,
      palette: ['minecraft:air', 'minecraft:stone'],
      voxels: new Uint16Array(size.x * size.y * size.z),
    };
    const preview = previewFor({
      grid,
      tool: 'place',
      hover: { x: 32, y: 32, z: 32, face: 'up' },
      anchor: null,
      radius: 8,
      shape: 'cube',
      clip: null,
    });
    expect(preview!.kind).toBe('box');
    // A radius-8 cube is 17^3, all of it air in this grid and all of it well past the cap.
    expect(preview!.label).toBe('4,913 blocks');
    expect(17 * 17 * 17).toBeGreaterThan(PREVIEW_CELL_CAP);
  });

  it('previews nothing for the tools that act on the hovered cell alone', () => {
    for (const tool of ['fill', 'swap', 'pick']) {
      expect(previewFor({ ...base(grid16()), tool })).toBeNull();
    }
  });
});
