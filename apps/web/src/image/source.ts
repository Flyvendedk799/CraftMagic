/**
 * Getting a picture out of a file and into the two shapes the feature needs: a grid of pixels
 * to match against blocks, and a cropped PNG to hand to the model.
 *
 * Both go through a canvas, which is the browser's own image pipeline — it decodes every
 * format the browser can display, it resamples with a real filter rather than by dropping
 * pixels, and it does both off the main thread's critical path. Nothing here decodes an image
 * by hand.
 */

import { muralSize, type MuralOrientation, type MuralPixels } from '@craftmagic/core';

export interface LoadedImage {
  /** The file's own name, minus its extension — the default name for the build. */
  name: string;
  width: number;
  height: number;
  element: HTMLImageElement;
  /** Object URL backing `element`. Revoked when the picture is replaced. */
  url: string;
}

/** A point on the picture, in its own pixel coordinates. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Refused sizes, and why they are refused here rather than by the browser running out of
 * memory: a phone photograph is a few megabytes and a raw scan is hundreds, and the second one
 * locks up the tab for long enough to look like a crash.
 */
export const MAX_FILE_BYTES = 12 * 1024 * 1024;

export class ImageError extends Error {}

export async function loadImageFile(file: File): Promise<LoadedImage> {
  if (!file.type.startsWith('image/')) {
    throw new ImageError(`${file.name} is not an image.`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new ImageError(
      `That picture is ${(file.size / 1024 / 1024).toFixed(1)}MB — the limit is ${MAX_FILE_BYTES / 1024 / 1024}MB.`,
    );
  }

  const url = URL.createObjectURL(file);
  try {
    const element = await decode(url);
    return {
      name: file.name.replace(/\.[^.]+$/, '') || 'Picture',
      width: element.naturalWidth,
      height: element.naturalHeight,
      element,
      url,
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function decode(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => {
      if (element.naturalWidth === 0 || element.naturalHeight === 0) {
        reject(new ImageError('That file could not be read as a picture.'));
        return;
      }
      resolve(element);
    };
    element.onerror = () => reject(new ImageError('That file could not be read as a picture.'));
    element.src = url;
  });
}

/**
 * The picture resampled to one pixel per block.
 *
 * The whole reduction happens in one `drawImage`, so the browser averages the pixels it is
 * throwing away instead of picking one and discarding the rest — the difference between a
 * mural that looks like the photograph and one that looks like a bad screenshot of it.
 */
export function samplePixels(
  image: LoadedImage,
  blocksWide: number,
  orientation: MuralOrientation,
): MuralPixels {
  const { width, height } = muralSize(image.width, image.height, blocksWide, orientation);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new ImageError('This browser would not give us a canvas to read the picture with.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image.element, 0, 0, width, height);

  const data = ctx.getImageData(0, 0, width, height);
  return { width, height, data: data.data };
}

/** The bounding box of an outline, clamped to the picture. */
export function outlineBounds(image: LoadedImage, outline: readonly Point[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  let minX = image.width;
  let minY = image.height;
  let maxX = 0;
  let maxY = 0;
  for (const point of outline) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  const x = Math.max(0, Math.floor(minX));
  const y = Math.max(0, Math.floor(minY));
  return {
    x,
    y,
    width: Math.max(1, Math.min(image.width, Math.ceil(maxX)) - x),
    height: Math.max(1, Math.min(image.height, Math.ceil(maxY)) - y),
  };
}

/**
 * Long edge of the picture sent to the model.
 *
 * Images are billed by area, and a build program does not get better for seeing the pores on
 * somebody's face: what the model needs is the silhouette, the proportions and the colours.
 * 768 is about a thousand tokens and is more than enough for all three.
 */
const MODEL_IMAGE_EDGE = 768;

export interface CroppedImage {
  /** Base64 PNG, without the data-URL prefix — what the providers all want. */
  data: string;
  mediaType: 'image/png';
  /** A data URL of the same bytes, for showing the user what was sent. */
  preview: string;
  width: number;
  height: number;
}

/**
 * The part of the picture the user drew around, as a PNG.
 *
 * Everything outside the outline is painted flat white rather than left transparent or dimmed.
 * Transparent is a coin flip — some providers composite it onto black, some onto white, and a
 * subject with a black halo reads as part of the subject. Dimmed-but-visible is worse still:
 * asked to build "this", a model that can see the rest of the scene builds some of the rest of
 * the scene.
 *
 * With no outline the whole picture is sent, which is what "focus on all of it" means.
 */
export function cropToImage(image: LoadedImage, outline: readonly Point[]): CroppedImage {
  const enough = outline.length >= 3;
  const box = enough
    ? outlineBounds(image, outline)
    : { x: 0, y: 0, width: image.width, height: image.height };

  const scale = Math.min(1, MODEL_IMAGE_EDGE / Math.max(box.width, box.height));
  const width = Math.max(1, Math.round(box.width * scale));
  const height = Math.max(1, Math.round(box.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageError('This browser would not give us a canvas to crop with.');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  if (enough) {
    // Clip to the outline first, then draw: everything the user did not circle simply never
    // lands on the canvas, and the white underneath shows through.
    ctx.save();
    ctx.beginPath();
    outline.forEach((point, index) => {
      const x = (point.x - box.x) * scale;
      const y = (point.y - box.y) * scale;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.clip();
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    image.element,
    box.x,
    box.y,
    box.width,
    box.height,
    0,
    0,
    width,
    height,
  );
  if (enough) ctx.restore();

  const preview = canvas.toDataURL('image/png');
  return {
    data: preview.slice(preview.indexOf(',') + 1),
    mediaType: 'image/png',
    preview,
    width,
    height,
  };
}
