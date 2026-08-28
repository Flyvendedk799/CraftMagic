/**
 * A picture, rebuilt out of blocks.
 *
 * No model is involved and none should be: a language model cannot look at a photograph and
 * reproduce it block by block, and asking one to try costs money to get something that is
 * recognisably not the picture. Matching pixels to blocks is arithmetic, it is exact, it runs
 * in a few milliseconds in the browser, and it is free — so the picture the user gets back is
 * the picture they put in.
 *
 * Two decisions carry most of the quality:
 *
 *  - **Colours are compared in Oklab, not RGB.** Nearest-neighbour in RGB matches by
 *    coincidence of channel values rather than by how the colours look: it will happily swap a
 *    mid grey for a saturated olive because the numbers are close, and it is worst exactly
 *    where pictures live, in skin tones and skies. Oklab is built so that a short distance
 *    means "looks similar", which is the question being asked.
 *  - **Dithering is optional and off by default.** Error diffusion buys a far better
 *    impression of a photograph at a distance and costs a speckle of stray blocks up close.
 *    Which of those matters depends on whether the thing is a mural you walk past or a
 *    portrait you stand in front of, so it is the user's call rather than ours.
 */

import type { VoxelGrid } from '../ir/types.js';
import { AIR_BLOCK, LIMITS, voxelIndex } from '../ir/types.js';
import { colorOf } from '../registry/registry.js';
import { muralBlocks, type MuralPalette } from './palette.js';

/** Which way the picture faces once it is built. */
export type MuralOrientation = 'wall' | 'floor';

export interface MuralOrientationOption {
  id: MuralOrientation;
  label: string;
  hint: string;
}

export const MURAL_ORIENTATIONS: readonly MuralOrientationOption[] = [
  { id: 'wall', label: 'Wall', hint: 'Standing up, facing south' },
  { id: 'floor', label: 'Floor', hint: 'Laid flat, seen from above' },
];

/** Raw image data, exactly the shape a canvas `ImageData` has. */
export interface MuralPixels {
  width: number;
  height: number;
  /** RGBA, four bytes per pixel, row-major from the top-left. */
  data: Uint8ClampedArray | Uint8Array;
}

export interface MuralOptions {
  palette?: MuralPalette;
  orientation?: MuralOrientation;
  /** Spread each pixel's rounding error into its neighbours. Off by default. */
  dither?: boolean;
}

export interface MuralResult {
  grid: VoxelGrid;
  blockCount: number;
  /** What it takes to build, most-used first — the shopping list. */
  materials: { block: string; count: number }[];
}

/** Below this, a pixel is a hole in the picture rather than a colour. */
const ALPHA_THRESHOLD = 128;

/**
 * How big a picture of this shape comes out, in blocks.
 *
 * The width is what the user chooses and the height follows from the picture's own
 * proportions — a mural that does not have the shape of its photograph is not that
 * photograph. When the height that implies is taller than the engine allows, the width gives
 * way rather than the aspect ratio: a squashed picture is a worse answer than a smaller one.
 */
export function muralSize(
  imageWidth: number,
  imageHeight: number,
  blocksWide: number,
  orientation: MuralOrientation = 'wall',
): { width: number; height: number } {
  const safeWidth = Math.max(1, Math.floor(imageWidth) || 1);
  const safeHeight = Math.max(1, Math.floor(imageHeight) || 1);
  // A floor is laid out in x and z, both of which reach 256; a wall stands in x and y, and y
  // is the shorter axis the engine allows.
  const maxDown = orientation === 'floor' ? LIMITS.maxSizeZ : LIMITS.maxSizeY;

  let width = Math.max(1, Math.min(LIMITS.maxSizeX, Math.round(blocksWide)));
  let height = Math.max(1, Math.round((width * safeHeight) / safeWidth));

  if (height > maxDown) {
    height = maxDown;
    width = Math.max(1, Math.min(LIMITS.maxSizeX, Math.round((height * safeWidth) / safeHeight)));
  }

  return { width, height };
}

/**
 * Turn an image into blocks.
 *
 * `pixels` is expected to be the picture already resampled to the block grid — one pixel per
 * block — because resampling is what a canvas does well and is not this module's job.
 * Anything more than a pixel per block would be thrown away here anyway.
 */
export function buildMural(pixels: MuralPixels, options: MuralOptions = {}): MuralResult {
  const orientation = options.orientation ?? 'wall';
  const dither = options.dither ?? false;

  const width = Math.max(1, Math.floor(pixels.width));
  const height = Math.max(1, Math.floor(pixels.height));

  const blocks = muralBlocks(options.palette ?? 'full');
  const swatches = blocks.map((block) => oklab(colorOf(block)));

  // Palette slot 0 is air, as every grid requires; a block earns a slot the first time it is
  // actually used, so the exported schematic never carries a material nobody has to gather.
  const palette: string[] = [AIR_BLOCK];
  const slots = new Map<string, number>();
  const counts = new Map<string, number>();

  const size =
    orientation === 'floor'
      ? { x: width, y: 1, z: height }
      : { x: width, y: height, z: 1 };
  const voxels = new Uint16Array(size.x * size.y * size.z);

  // Error diffusion needs the row below and the row after it, so two rows of carried error
  // are enough — the classic Floyd–Steinberg kernel reaches no further.
  const carried = [newRow(width), newRow(width)];

  for (let row = 0; row < height; row++) {
    const current = carried[0]!;
    const next = carried[1]!;

    for (let col = 0; col < width; col++) {
      const at = (row * width + col) * 4;
      if ((pixels.data[at + 3] ?? 0) < ALPHA_THRESHOLD) continue;

      const source = oklab([pixels.data[at] ?? 0, pixels.data[at + 1] ?? 0, pixels.data[at + 2] ?? 0]);
      const wanted: Lab = dither
        ? [source[0] + current[col * 3]!, source[1] + current[col * 3 + 1]!, source[2] + current[col * 3 + 2]!]
        : source;

      const pick = nearest(wanted, swatches);
      const block = blocks[pick]!;

      let slot = slots.get(block);
      if (slot === undefined) {
        slot = palette.length;
        palette.push(block);
        slots.set(block, slot);
      }
      counts.set(block, (counts.get(block) ?? 0) + 1);

      const [x, y, z] =
        orientation === 'floor'
          ? [col, 0, row]
          // Image rows run downwards and Minecraft's Y runs upwards, so a wall is built from
          // the bottom row of the picture up. Miss this and the picture comes out upside down.
          : [col, height - 1 - row, 0];
      voxels[voxelIndex(size, x, y, z)] = slot;

      if (!dither) continue;

      const chosen = swatches[pick]!;
      const error: Lab = [wanted[0] - chosen[0], wanted[1] - chosen[1], wanted[2] - chosen[2]];
      spread(current, col + 1, width, error, 7 / 16);
      spread(next, col - 1, width, error, 3 / 16);
      spread(next, col, width, error, 5 / 16);
      spread(next, col + 1, width, error, 1 / 16);
    }

    // The row that was "next" becomes "current", and its own next starts clean.
    carried[0] = carried[1]!;
    carried[1] = current;
    carried[1]!.fill(0);
  }

  let blockCount = 0;
  for (const count of counts.values()) blockCount += count;

  return {
    grid: { size, palette, voxels },
    blockCount,
    materials: [...counts.entries()]
      .map(([block, count]) => ({ block, count }))
      // Most-used first, and ties broken by name so the list is stable between runs.
      .sort((a, b) => b.count - a.count || a.block.localeCompare(b.block)),
  };
}

function newRow(width: number): Float32Array {
  return new Float32Array(width * 3);
}

function spread(row: Float32Array, col: number, width: number, error: Lab, share: number): void {
  if (col < 0 || col >= width) return;
  row[col * 3] = (row[col * 3] ?? 0) + error[0] * share;
  row[col * 3 + 1] = (row[col * 3 + 1] ?? 0) + error[1] * share;
  row[col * 3 + 2] = (row[col * 3 + 2] ?? 0) + error[2] * share;
}

type Lab = [number, number, number];

function nearest(wanted: Lab, swatches: readonly Lab[]): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < swatches.length; i++) {
    const swatch = swatches[i]!;
    const dl = wanted[0] - swatch[0];
    const da = wanted[1] - swatch[1];
    const db = wanted[2] - swatch[2];
    const distance = dl * dl + da * da + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * sRGB to Oklab.
 *
 * Straight from Björn Ottosson's derivation. The gamma step matters as much as the matrices:
 * comparing 8-bit sRGB values directly treats the difference between two dark colours as
 * smaller than it looks, which is exactly where a photograph's detail is.
 */
function oklab(rgb: readonly [number, number, number]): Lab {
  const r = linear(rgb[0] / 255);
  const g = linear(rgb[1] / 255);
  const b = linear(rgb[2] / 255);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function linear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}
