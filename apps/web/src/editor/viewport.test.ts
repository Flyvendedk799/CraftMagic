/**
 * The layer range's URL contract.
 *
 * Worth testing on its own because every input to it is hostile: the query string can be
 * hand-edited, it survives a build changing height underneath it, and the two ends can arrive
 * the wrong way round. The failure mode is also the worst kind — a range that clips the entire
 * structure away looks exactly like a build that failed to load.
 */

import { describe, expect, it } from 'vitest';
import { isWholeBuild, readLayerRange } from './viewport.js';

describe('readLayerRange', () => {
  it('is null when neither end is in the URL', () => {
    expect(readLayerRange(null, null, 20)).toBeNull();
  });

  it('reads a ceiling on its own, with the floor at zero', () => {
    expect(readLayerRange('6', null, 20)).toEqual({ min: 0, max: 6 });
  });

  it('reads both ends', () => {
    expect(readLayerRange('14', '6', 20)).toEqual({ min: 6, max: 14 });
  });

  it('clamps to a build that is now shorter than the link assumed', () => {
    // The same link opened against a build scaled down: both ends have to land inside it
    // rather than clipping everything away.
    expect(readLayerRange('900', '800', 20)).toEqual({ min: 20, max: 20 });
  });

  it('repairs an inverted pair rather than showing nothing', () => {
    expect(readLayerRange('3', '9', 20)).toEqual({ min: 3, max: 9 });
  });

  it('ignores values that are not numbers', () => {
    expect(readLayerRange('abc', null, 20)).toEqual({ min: 0, max: 20 });
    expect(readLayerRange('8', 'abc', 20)).toEqual({ min: 0, max: 8 });
  });

  it('accepts a single soloed course', () => {
    expect(readLayerRange('7', '7', 20)).toEqual({ min: 7, max: 7 });
  });
});

describe('isWholeBuild', () => {
  it('treats a missing range as the whole build', () => {
    expect(isWholeBuild(null, 20)).toBe(true);
  });

  it('treats a full-span range as the whole build, so clipping can be skipped', () => {
    expect(isWholeBuild({ min: 0, max: 20 }, 20)).toBe(true);
  });

  it('recognises a real slice', () => {
    expect(isWholeBuild({ min: 0, max: 19 }, 20)).toBe(false);
    expect(isWholeBuild({ min: 1, max: 20 }, 20)).toBe(false);
  });

  it('survives a build that grew after the range was written', () => {
    // `?layer=20` against a build that is now 40 tall is a real ceiling, not "everything".
    expect(isWholeBuild({ min: 0, max: 20 }, 40)).toBe(false);
  });
});
