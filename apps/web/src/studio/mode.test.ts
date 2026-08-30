/**
 * The mode parser, pinned.
 *
 * This is the one part of the shell that can break a link somebody already shared. `?mode=plan`
 * is in every link sent while Architecture was called the layouter, and the failure mode if it
 * regresses is not an error — the visitor simply lands in Build mode looking at the wrong
 * thing, and nobody reports it.
 */

import { describe, expect, it } from 'vitest';
import { MODE_SPECS, STUDIO_MODES, modeParam, parseMode } from './mode.js';

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
