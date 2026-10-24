/**
 * The two-tier palette.
 *
 * The class itself needs a WebGL context and cannot run here, but the arithmetic underneath
 * the highlight can — and it is the part that fails silently. Get the length wrong and every
 * block renders as the wrong material; get the halves the wrong way round and the whole guide
 * comes out faded with the finished build picked out instead of the step.
 */

import { describe, expect, it } from 'vitest';
import type { BuildStep } from '@craftmagic/core';
import { ORIENTATION_VECTORS, VIEW_ORIENTATIONS } from '@craftmagic/core';
import {
  dimmedTwice,
  doubled,
  ELEVATION,
  ORIENTATION_AZIMUTH,
  orientationLabel,
  viewpointCaption,
} from './isoRender.js';

describe('dimmedTwice', () => {
  it('doubles the table, so index + span addresses the same material lit', () => {
    const colors = Uint8Array.of(10, 20, 30, 40, 50, 60);
    expect(dimmedTwice(colors)).toHaveLength(12);
  });

  it('keeps the second half exact — "new" must be the material’s real colour', () => {
    const colors = Uint8Array.of(10, 20, 30, 200, 100, 0);
    const out = dimmedTwice(colors);
    expect([...out.slice(6)]).toEqual([10, 20, 30, 200, 100, 0]);
  });

  it('lightens the first half toward white rather than darkening it', () => {
    // Toward white, so a built model reads as receded paper rather than as a shadow — and it
    // survives greyscale printing, which a hue shift would not.
    const out = dimmedTwice(Uint8Array.of(0, 0, 0));
    expect(out[0]).toBeGreaterThan(0);
    expect(out[0]).toBeLessThan(255);
  });

  it('never pushes a channel out of range', () => {
    const out = dimmedTwice(Uint8Array.of(255, 255, 255, 0, 0, 0));
    for (const value of out) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(255);
    }
  });

  it('leaves white white, so the built half never brightens past the material', () => {
    expect(dimmedTwice(Uint8Array.of(255, 255, 255))[0]).toBe(255);
  });

  it('separates the two halves enough to be seen', () => {
    // A mid grey is the worst case: no hue to help, so the lightness gap has to carry it.
    const out = dimmedTwice(Uint8Array.of(128, 128, 128));
    expect(out[3]! - out[0]!).toBeLessThan(0);
    expect(Math.abs(out[3]! - out[0]!)).toBeGreaterThan(40);
  });
});

describe('doubled', () => {
  it('repeats the flags, because transparency belongs to the material and not to its age', () => {
    // A pane of glass placed this step must still be glass, or a lit window would render
    // solid and hide everything the reader has already built behind it.
    expect([...doubled(Uint8Array.of(1, 0, 2))]).toEqual([1, 0, 2, 1, 0, 2]);
  });
});

describe('viewpoints and azimuths', () => {
  it('defines 4 cardinal isometric directions with exact azimuths derived from core vectors', () => {
    // SE (+1, +1) -> PI/4
    expect(ORIENTATION_AZIMUTH.SE).toBeCloseTo(Math.PI / 4, 6);
    // NE (+1, -1) -> 3PI/4
    expect(ORIENTATION_AZIMUTH.NE).toBeCloseTo((3 * Math.PI) / 4, 6);
    // NW (-1, -1) -> 5PI/4
    expect(ORIENTATION_AZIMUTH.NW).toBeCloseTo((5 * Math.PI) / 4, 6);
    // SW (-1, +1) -> 7PI/4
    expect(ORIENTATION_AZIMUTH.SW).toBeCloseTo((7 * Math.PI) / 4, 6);
  });

  it('camera directions agree with core occlusion rays for all 4 viewpoints', () => {
    // Verify that the camera position direction from origin matches ORIENTATION_VECTORS in both X and Z signs
    for (const ori of VIEW_ORIENTATIONS) {
      const azimuth = ORIENTATION_AZIMUTH[ori];
      const vec = ORIENTATION_VECTORS[ori];

      // Camera horizontal position vector from origin: (sin(azimuth), cos(azimuth))
      const camDirX = Math.sin(azimuth);
      const camDirZ = Math.cos(azimuth);

      // Sign must strictly match core ray direction
      expect(Math.sign(camDirX)).toBe(vec.x);
      expect(Math.sign(camDirZ)).toBe(vec.z);

      // A displacement along the ray vector moves towards the camera (positive dot product with camera direction)
      const dot = vec.x * camDirX + vec.z * camDirZ;
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('defines true isometric elevation of 35.264 degrees', () => {
    expect(ELEVATION).toBeCloseTo(Math.atan(1 / Math.SQRT2), 6);
    expect((ELEVATION * 180) / Math.PI).toBeCloseTo(35.264, 2);
  });

  it('formats orientation labels for all 4 viewpoints', () => {
    expect(orientationLabel('SE')).toBe('South-East');
    expect(orientationLabel('SW')).toBe('South-West');
    expect(orientationLabel('NW')).toBe('North-West');
    expect(orientationLabel('NE')).toBe('North-East');
  });

  it('generates viewpoint captions reflecting standard and flipped orientations', () => {
    const normalStep = {
      orientation: 'SE',
      isFlipped: false,
    } as unknown as BuildStep;
    expect(viewpointCaption(normalStep)).toBe('Seen from South-East');

    const flippedStep = {
      orientation: 'NW',
      isFlipped: true,
    } as unknown as BuildStep;
    expect(viewpointCaption(flippedStep)).toBe('Flipped to North-West for visibility');
  });
});
