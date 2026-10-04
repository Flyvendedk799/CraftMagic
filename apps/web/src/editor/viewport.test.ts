import { describe, it, expect } from 'vitest';
import {
  perspectiveResizeFactor,
  orthographicResizeFactor,
} from './viewport.js';
describe('viewport composition', () => {
  it('moves a perspective view back for a narrow panel', () =>
    expect(
      perspectiveResizeFactor(
        { width: 1000, height: 800 },
        { width: 400, height: 800 },
      ),
    ).toBe(2));
  it('reverses the compensation when restoring the layout', () =>
    expect(
      perspectiveResizeFactor(
        { width: 400, height: 800 },
        { width: 1000, height: 800 },
      ),
    ).toBe(0.5));
  it('keeps a landscape composition stable', () =>
    expect(
      perspectiveResizeFactor(
        { width: 1000, height: 800 },
        { width: 1600, height: 800 },
      ),
    ).toBe(1));
  it('ignores temporarily hidden zero-size canvases', () =>
    expect(
      perspectiveResizeFactor(
        { width: 0, height: 800 },
        { width: 400, height: 800 },
      ),
    ).toBe(1));
  it('preserves orthographic framing by scaling zoom', () =>
    expect(
      orthographicResizeFactor(
        { width: 1000, height: 800 },
        { width: 400, height: 800 },
      ),
    ).toBe(0.5));
});
