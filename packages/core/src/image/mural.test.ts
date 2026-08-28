import { describe, expect, it } from 'vitest';
import { buildMural, muralSize, type MuralPixels } from './mural.js';
import { muralBlocks, MURAL_PALETTES } from './palette.js';
import { AIR_BLOCK, LIMITS, voxelIndex } from '../ir/types.js';
import { colorOf, getBlock } from '../registry/registry.js';

/** A picture where every pixel is set from a function of its position. */
function picture(
  width: number,
  height: number,
  at: (col: number, row: number) => [number, number, number, number],
): MuralPixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const [r, g, b, a] = at(col, row);
      const i = (row * width + col) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

const solid = (rgb: [number, number, number]) =>
  picture(4, 3, () => [rgb[0], rgb[1], rgb[2], 255]);

function blockAt(result: ReturnType<typeof buildMural>, x: number, y: number, z: number): string {
  const { grid } = result;
  return grid.palette[grid.voxels[voxelIndex(grid.size, x, y, z)]!]!;
}

describe('muralBlocks', () => {
  it('offers only full, opaque, single-faced cubes', () => {
    for (const id of muralBlocks('full')) {
      const block = getBlock(id)!;
      expect(block, id).toBeDefined();
      expect(block.transparent ?? false, id).toBe(false);
      expect(block.rotation, id).toBe('none');
      expect(block.light ?? 0, id).toBe(0);
    }
  });

  it('leaves out the blocks whose sides do not match their average colour', () => {
    // A grass block is green on top and dirt on every side a mural is seen from.
    expect(muralBlocks('full')).not.toContain('minecraft:grass_block');
    expect(muralBlocks('full')).not.toContain('minecraft:crafting_table');
  });

  it('gives every named material set something to build with', () => {
    for (const option of MURAL_PALETTES) {
      const blocks = muralBlocks(option.id);
      expect(blocks.length, option.id).toBeGreaterThanOrEqual(16);
      if (option.id !== 'full') {
        for (const id of blocks) expect(getBlock(id)!.category, id).toBe(option.id);
      }
    }
  });

  it('is the same list every time, so the same picture builds the same way', () => {
    expect(muralBlocks('wool')).toEqual(muralBlocks('wool'));
    expect(muralBlocks('full')).toEqual([...muralBlocks('full')].sort());
  });
});

describe('muralSize', () => {
  it('keeps the picture the shape it was', () => {
    expect(muralSize(1600, 900, 64)).toEqual({ width: 64, height: 36 });
    expect(muralSize(900, 1600, 40)).toEqual({ width: 40, height: 71 });
  });

  it('gives up width rather than the aspect ratio when the engine runs out of height', () => {
    // A tall picture at 256 wide would want 512 blocks of height; the wall stops at 160.
    const size = muralSize(100, 200, 256);
    expect(size.height).toBe(LIMITS.maxSizeY);
    expect(size.width).toBe(80);
    expect(size.height / size.width).toBeCloseTo(2, 1);
  });

  it('lets a floor use the deeper axis, which a wall cannot', () => {
    expect(muralSize(100, 200, 256, 'floor').height).toBeGreaterThan(
      muralSize(100, 200, 256, 'wall').height,
    );
  });

  it('never asks for a build the expander would refuse', () => {
    for (const [w, h] of [[4000, 3000], [1, 4000], [4000, 1], [0, 0]]) {
      for (const orientation of ['wall', 'floor'] as const) {
        const size = muralSize(w!, h!, 999, orientation);
        expect(size.width).toBeGreaterThanOrEqual(1);
        expect(size.width).toBeLessThanOrEqual(LIMITS.maxSizeX);
        expect(size.height).toBeGreaterThanOrEqual(1);
        expect(size.height).toBeLessThanOrEqual(
          orientation === 'floor' ? LIMITS.maxSizeZ : LIMITS.maxSizeY,
        );
      }
    }
  });
});

describe('buildMural', () => {
  it('builds a wall standing up, one block thick', () => {
    const result = buildMural(solid([255, 255, 255]));
    expect(result.grid.size).toEqual({ x: 4, y: 3, z: 1 });
    expect(result.blockCount).toBe(12);
  });

  it('builds a floor lying flat', () => {
    const result = buildMural(solid([255, 255, 255]), { orientation: 'floor' });
    expect(result.grid.size).toEqual({ x: 4, y: 1, z: 3 });
    expect(result.blockCount).toBe(12);
  });

  it('stands a wall on its feet rather than upside down', () => {
    // Black along the top row of the picture, white everywhere else. The top row of the
    // picture has to end up at the top of the wall.
    const image = picture(2, 2, (_col, row) => (row === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const result = buildMural(image);

    expect(colorOf(blockAt(result, 0, 1, 0))[0]).toBeLessThan(60);
    expect(colorOf(blockAt(result, 0, 0, 0))[0]).toBeGreaterThan(200);
  });

  it('reads left to right, so a picture is not mirrored', () => {
    const image = picture(2, 1, (col) => (col === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const result = buildMural(image);

    const [leftR, , leftB] = colorOf(blockAt(result, 0, 0, 0));
    const [rightR, , rightB] = colorOf(blockAt(result, 1, 0, 0));
    expect(leftR).toBeGreaterThan(leftB);
    expect(rightB).toBeGreaterThan(rightR);
  });

  it('leaves a hole where the picture is transparent', () => {
    const image = picture(2, 1, (col) => (col === 0 ? [255, 255, 255, 255] : [255, 255, 255, 0]));
    const result = buildMural(image);

    expect(blockAt(result, 0, 0, 0)).not.toBe(AIR_BLOCK);
    expect(blockAt(result, 1, 0, 0)).toBe(AIR_BLOCK);
    expect(result.blockCount).toBe(1);
  });

  it('picks a block that actually looks like the colour asked for', () => {
    for (const rgb of [
      [255, 255, 255],
      [12, 12, 14],
      [200, 30, 30],
      [40, 90, 200],
      [90, 160, 70],
    ] as [number, number, number][]) {
      const chosen = colorOf(blockAt(buildMural(solid(rgb)), 0, 0, 0));
      const off = Math.max(
        Math.abs(chosen[0] - rgb[0]),
        Math.abs(chosen[1] - rgb[1]),
        Math.abs(chosen[2] - rgb[2]),
      );
      expect(off, `${rgb} became ${chosen}`).toBeLessThan(60);
    }
  });

  it('matches by how a colour looks, not by how close its numbers are', () => {
    // Mid grey against the full range. RGB nearest-neighbour reaches for whatever sits at a
    // similar channel value and will take a coloured block; a perceptual match keeps it grey.
    const chosen = colorOf(blockAt(buildMural(solid([128, 128, 128])), 0, 0, 0));
    const spread = Math.max(...chosen) - Math.min(...chosen);
    expect(spread, `${chosen} is not a grey`).toBeLessThan(24);
  });

  it('honours a named material set', () => {
    const result = buildMural(solid([200, 30, 30]), { palette: 'wool' });
    for (const entry of result.materials) expect(entry.block).toContain('wool');
  });

  it('is deterministic, dithered or not', () => {
    const image = picture(16, 16, (col, row) => [col * 15, row * 15, 128, 255]);
    for (const dither of [false, true]) {
      const first = buildMural(image, { dither });
      const second = buildMural(image, { dither });
      expect(Array.from(second.grid.voxels), `dither=${dither}`).toEqual(Array.from(first.grid.voxels));
    }
  });

  it('mixes blocks to suggest a colour it does not have when dithering', () => {
    // A flat colour between two wools. Undithered it becomes one block; dithered it becomes a
    // mix, which is the whole point of the option.
    const image = picture(16, 16, () => [150, 120, 100, 255]);
    const flat = buildMural(image, { palette: 'wool' });
    const mixed = buildMural(image, { palette: 'wool', dither: true });

    expect(flat.materials.length).toBe(1);
    expect(mixed.materials.length).toBeGreaterThan(1);
    expect(mixed.blockCount).toBe(flat.blockCount);
  });

  it('reports the shopping list, most-used first', () => {
    const image = picture(4, 1, (col) => (col < 3 ? [255, 255, 255, 255] : [10, 10, 12, 255]));
    const result = buildMural(image);

    expect(result.materials.length).toBe(2);
    expect(result.materials[0]!.count).toBe(3);
    expect(result.materials[1]!.count).toBe(1);
    expect(result.materials.reduce((sum, m) => sum + m.count, 0)).toBe(result.blockCount);
  });

  it('carries only the blocks it used into the palette', () => {
    const result = buildMural(solid([255, 255, 255]));
    expect(result.grid.palette[0]).toBe(AIR_BLOCK);
    expect(result.grid.palette.length).toBe(2);
  });
});
