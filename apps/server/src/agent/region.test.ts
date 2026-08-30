import { describe, expect, it } from 'vitest';
import { readRegion } from './routes.js';

/**
 * The three answers are not two.
 *
 * Absent means "an ordinary build", and that path has to keep working exactly as it did before
 * worlds existed. Malformed means "somebody is about to put a piece of a map at the wrong
 * coordinates", which looks deliberate once it lands and cannot be told apart from a correct
 * placement afterwards. Collapsing the two — treating a mangled region as no region — is the
 * one mistake here that would be silent in production.
 */
describe('readRegion', () => {
  const good = {
    worldId: 'w1',
    index: 0,
    total: 4,
    rx: 0,
    rz: 1,
    offset: { x: 128, y: 0, z: 256 },
  };

  it('reads a well-formed region', () => {
    expect(readRegion(good)).toEqual(good);
  });

  it('treats absence as a lone build rather than as an error', () => {
    expect(readRegion(undefined)).toBeNull();
    expect(readRegion(null)).toBeNull();
  });

  it('rejects a region rather than silently downgrading it to a lone build', () => {
    expect(readRegion('region')).toBe('bad');
    expect(readRegion(42)).toBe('bad');
    expect(readRegion({})).toBe('bad');
  });

  it('requires every coordinate, including the ones that are usually zero', () => {
    for (const missing of ['worldId', 'index', 'total', 'rx', 'rz'] as const) {
      const { [missing]: _dropped, ...rest } = good;
      expect(readRegion(rest)).toBe('bad');
    }
    for (const axis of ['x', 'y', 'z'] as const) {
      const { [axis]: _dropped, ...offset } = good.offset;
      expect(readRegion({ ...good, offset })).toBe('bad');
    }
    expect(readRegion({ ...good, offset: undefined })).toBe('bad');
  });

  it('rejects a fractional offset', () => {
    // A half-block offset would place a region off the grid it tiles, and every region after
    // it inherits the error through the anchor.
    expect(readRegion({ ...good, offset: { x: 0.5, y: 0, z: 0 } })).toBe('bad');
    expect(readRegion({ ...good, index: 1.5 })).toBe('bad');
  });

  it('rejects an index outside its own run', () => {
    expect(readRegion({ ...good, index: 4, total: 4 })).toBe('bad');
    expect(readRegion({ ...good, index: -1 })).toBe('bad');
    expect(readRegion({ ...good, total: 0 })).toBe('bad');
  });

  it('accepts a negative offset, since a world may be placed anywhere', () => {
    const west = { ...good, index: 3, rx: -1, offset: { x: -128, y: 0, z: -64 } };
    expect(readRegion(west)).toEqual(west);
  });

  it('ignores an anchor sent by the client', () => {
    // Where region 0 landed is the mod's report, held by the hub. Accepting one from the
    // browser would let a caller aim somebody else's map.
    const spoofed = { ...good, index: 1, anchor: { x: 9999, y: 0, z: 9999 } };
    expect(readRegion(spoofed)).toEqual({ ...good, index: 1 });
  });
});
