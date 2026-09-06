/**
 * The mode parser, pinned.
 *
 * This is the one part of the shell that can break a link somebody already shared. `?mode=plan`
 * is in every link sent while Architecture was called the layouter, and the failure mode if it
 * regresses is not an error — the visitor simply lands in Build mode looking at the wrong
 * thing, and nobody reports it.
 */

import { describe, expect, it } from 'vitest';
import { MODE_SPECS, STUDIO_MODES, foreignParams, modeParam, ownsParam, parseMode } from './mode.js';

describe('foreignParams', () => {
  it('flags a build in the address bar while World is on screen, and names its owner', () => {
    expect(foreignParams('world', new URLSearchParams('mode=world&build=lib:abc'))).toEqual([
      { key: 'build', owner: 'build' },
    ]);
  });

  it('flags a map or a placement while Build is on screen', () => {
    expect(foreignParams('build', new URLSearchParams('world=w1&place=abc')).map((p) => p.key)).toEqual([
      'world',
      'place',
    ]);
  });

  it('says nothing about parameters the mode reads', () => {
    expect(foreignParams('build', new URLSearchParams('build=cottage&p.floors=2&s.x=150&style=nordic&layer=3'))).toEqual([]);
    expect(foreignParams('arch', new URLSearchParams('mode=arch&plan=lib:abc'))).toEqual([]);
    expect(foreignParams('world', new URLSearchParams('mode=world&world=w1&place=abc'))).toEqual([]);
  });

  it('says nothing about the shell’s own mode, or about parameters nobody owns', () => {
    expect(foreignParams('world', new URLSearchParams('mode=world&utm_source=x'))).toEqual([]);
  });

  it('treats the param families as Build’s', () => {
    expect(ownsParam('build', 'p.floors')).toBe(true);
    expect(ownsParam('build', 's.z')).toBe(true);
    expect(ownsParam('arch', 'p.floors')).toBe(false);
  });
});

describe('parseMode', () => {
  it('treats an absent mode as Build', () => {
    // Every `/editor?build=…` redirect relies on this.
    expect(parseMode(null)).toBe('build');
    expect(parseMode(undefined)).toBe('build');
    expect(parseMode('')).toBe('build');
  });

  it('keeps every link shared while the mode was called the layouter', () => {
    expect(parseMode('plan')).toBe('arch');
    expect(parseMode('layouter')).toBe('arch');
  });

  it('reads the current names', () => {
    expect(parseMode('arch')).toBe('arch');
    expect(parseMode('architecture')).toBe('arch');
    expect(parseMode('world')).toBe('world');
    expect(parseMode('build')).toBe('build');
  });

  it('falls back to Build for anything it does not know', () => {
    expect(parseMode('nonsense')).toBe('build');
    expect(parseMode('WORLD')).toBe('build');
  });
});

describe('modeParam', () => {
  it('writes nothing for Build, so the default stays absent from a shared link', () => {
    expect(modeParam('build')).toBeNull();
  });

  it('writes the other two', () => {
    expect(modeParam('arch')).toBe('arch');
    expect(modeParam('world')).toBe('world');
  });

  it('round-trips every mode', () => {
    for (const mode of STUDIO_MODES) expect(parseMode(modeParam(mode))).toBe(mode);
  });
});

describe('MODE_SPECS', () => {
  it('describes every mode, so the switch and the palette cannot disagree', () => {
    for (const mode of STUDIO_MODES) {
      expect(MODE_SPECS[mode].id).toBe(mode);
      expect(MODE_SPECS[mode].label.length).toBeGreaterThan(0);
      expect(MODE_SPECS[mode].hint.length).toBeGreaterThan(0);
    }
  });
});
