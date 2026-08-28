/**
 * The two-tier palette.
 *
 * The class itself needs a WebGL context and cannot run here, but the arithmetic underneath
 * the highlight can — and it is the part that fails silently. Get the length wrong and every
 * block renders as the wrong material; get the halves the wrong way round and the whole guide
 * comes out faded with the finished build picked out instead of the step.
 */

import { describe, expect, it } from 'vitest';
import { dimmedTwice, doubled } from './isoRender.js';

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
