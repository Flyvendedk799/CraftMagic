import { describe, expect, it } from 'vitest';
import { CoordError, resolveCoord, resolveSize3, resolveVec3 } from './coords.js';
import type { ProgramParam } from './types.js';

const span = (extent: number) => ({ extent });

describe('resolveCoord', () => {
  it('passes integers through', () => {
    expect(resolveCoord(4, span(21))).toBe(4);
    expect(resolveCoord(-3, span(21))).toBe(-3);
    expect(resolveCoord('7', span(21))).toBe(7);
  });

  it('resolves anchors against the axis span', () => {
    expect(resolveCoord('min', span(21))).toBe(0);
    expect(resolveCoord('max', span(21))).toBe(20);
    expect(resolveCoord('center', span(21))).toBe(10);
    // Even extents have no exact centre; floor keeps it deterministic.
    expect(resolveCoord('center', span(20))).toBe(9);
  });

  it('applies offsets to anchors', () => {
    expect(resolveCoord('max-1', span(21))).toBe(19);
    expect(resolveCoord('center+2', span(21))).toBe(12);
    expect(resolveCoord('min+3', span(21))).toBe(3);
  });

  it('resolves percentages against the span', () => {
    expect(resolveCoord('0%', span(21))).toBe(0);
    expect(resolveCoord('50%', span(21))).toBe(10);
    expect(resolveCoord('100%', span(21))).toBe(20);
  });

  it('resolves params with multiply and offset', () => {
    const params: Record<string, ProgramParam> = { floors: { value: 3, min: 1, max: 8 } };
    expect(resolveCoord('$floors', { extent: 40, params })).toBe(3);
    expect(resolveCoord('$floors*4', { extent: 40, params })).toBe(12);
    expect(resolveCoord('$floors*4+1', { extent: 40, params })).toBe(13);
  });

  it('clamps a param to its declared range', () => {
    const params: Record<string, ProgramParam> = { floors: { value: 99, min: 1, max: 8 } };
    expect(resolveCoord('$floors', { extent: 40, params })).toBe(8);
  });

  it('rejects unparseable expressions and names the offender', () => {
    expect(() => resolveCoord('maxx', span(10))).toThrow(CoordError);
    expect(() => resolveCoord('', span(10))).toThrow(CoordError);
    expect(() => resolveCoord('center*', span(10))).toThrow(CoordError);
    expect(() => resolveCoord('3 4', span(10))).toThrow(CoordError);
    expect(() => resolveCoord('(3', span(10))).toThrow(CoordError);
  });

  // Every expression here came out of a real generation run and was rejected by the
  // original single-offset grammar, costing a paid repair round each time.
  describe('expressions the model actually writes', () => {
    const params: Record<string, ProgramParam> = {
      towerHeight: { value: 20, min: 8, max: 24 },
      sailLength: { value: 6, min: 3, max: 8 },
    };
    const ctx = { extent: 26, params };

    it('takes a percentage of a param', () => {
      // "30% of the tower height", not 30% of the axis.
      expect(resolveCoord('$towerHeight*30%', ctx)).toBe(6);
      expect(resolveCoord('$towerHeight*60%', ctx)).toBe(12);
    });

    it('chains several additive terms', () => {
      expect(resolveCoord('$towerHeight-2+$sailLength', ctx)).toBe(24);
      expect(resolveCoord('$towerHeight-2-$sailLength', ctx)).toBe(12);
    });

    it('combines params with anchors', () => {
      expect(resolveCoord('center+$sailLength', ctx)).toBe(12 + 6);
      expect(resolveCoord('max-$sailLength', ctx)).toBe(25 - 6);
    });
  });

  describe('percentages read correctly in both positions', () => {
    it('is a share of the axis when it stands alone', () => {
      expect(resolveCoord('50%', span(21))).toBe(10);
    });

    it('is a plain fraction when used as a multiplier', () => {
      // 30% of 20, not 30% of the axis span.
      expect(resolveCoord('20*30%', span(101))).toBe(6);
    });
  });

  describe('arithmetic', () => {
    it('gives multiplication precedence over addition', () => {
      expect(resolveCoord('2+3*4', span(100))).toBe(14);
    });

    it('honours parentheses', () => {
      expect(resolveCoord('(2+3)*4', span(100))).toBe(20);
    });

    it('handles unary minus', () => {
      expect(resolveCoord('-5+max', span(21))).toBe(15);
    });

    it('tolerates spaces', () => {
      expect(resolveCoord('max - 1', span(21))).toBe(19);
    });

    it('accepts decimals — a real run produced "max*0.42"', () => {
      expect(resolveCoord('max*0.42', span(25))).toBe(10);
      expect(resolveCoord('0.5*max', span(21))).toBe(10);
    });

    it('divides', () => {
      expect(resolveCoord('max/2', span(21))).toBe(10);
      expect(resolveCoord('20/4+1', span(100))).toBe(6);
    });

    it('rejects division by zero rather than yielding Infinity', () => {
      expect(() => resolveCoord('max/0', span(21))).toThrow(CoordError);
    });
  });

  it('lists the declared params when one is missing', () => {
    const params: Record<string, ProgramParam> = { floors: { value: 3, min: 1, max: 8 } };
    expect(() => resolveCoord('$height', { extent: 10, params })).toThrow(/\$floors/);
  });
});

describe('resolveVec3 / resolveSize3', () => {
  const size = { x: 21, y: 14, z: 17 };

  it('resolves positions per axis', () => {
    expect(resolveVec3(['min', 'min', 'min'], size)).toEqual([0, 0, 0]);
    expect(resolveVec3(['max', 'max', 'max'], size)).toEqual([20, 13, 16]);
  });

  it('treats sizes as lengths, not indices', () => {
    // A "max" length spans the whole axis, where a "max" position stops one short.
    expect(resolveSize3(['max', 'max', 'max'], size)).toEqual([21, 14, 17]);
    expect(resolveSize3([5, 3, 4], size)).toEqual([5, 3, 4]);
  });

  it('never returns a negative size', () => {
    expect(resolveSize3([-5, 'min', 'min'], size)).toEqual([0, 0, 0]);
  });
});
