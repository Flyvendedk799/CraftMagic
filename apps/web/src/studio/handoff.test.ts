/**
 * The handoff URLs, pinned.
 *
 * Each of these is a link some other page builds and some mode reads. A drift in either
 * direction — the dashboard writing `?place=lib:x` while World reads a bare row id — is a
 * silent no-op: the page opens, nothing is armed, and the visitor concludes the feature does
 * not work. The tests below are the contract both sides are held to.
 */

import { describe, expect, it } from 'vitest';
import {
  composeMap,
  drawFloorplan,
  isDurable,
  libRef,
  libRowId,
  openGuide,
  openInBuild,
  openMap,
  openPlan,
  placeOnMap,
} from './handoff.js';

describe('library refs', () => {
  it('prefixes a bare row id and leaves a prefixed one alone', () => {
    expect(libRef('abc')).toBe('lib:abc');
    expect(libRef('lib:abc')).toBe('lib:abc');
  });

  it('recovers the row id from a ref, and refuses anything else', () => {
    expect(libRowId('lib:abc')).toBe('abc');
    expect(libRowId('gen:3')).toBeNull();
    expect(libRowId('cottage')).toBeNull();
  });

  it('calls only library rows durable', () => {
    expect(isDurable('lib:abc')).toBe(true);
    expect(isDurable('gen:3')).toBe(false);
    expect(isDurable('schem:1')).toBe(false);
  });
});

describe('studio links', () => {
  it('opens a build in Build mode with no mode parameter, as every old link relies on', () => {
    expect(openInBuild('lib:abc')).toBe('/studio?build=lib%3Aabc');
    expect(openInBuild('cottage')).toBe('/studio?build=cottage');
  });

  it('opens a plan in Architecture by its library row', () => {
    expect(openPlan('abc')).toBe('/studio?mode=arch&plan=lib%3Aabc');
    expect(drawFloorplan()).toBe('/studio?mode=arch');
  });

  it('arms a bare row id in World, with or without a map to open first', () => {
    // The World shelf is keyed by row id, not by editor ref, so the prefix is stripped.
    expect(placeOnMap('abc')).toBe('/studio?mode=world&place=abc');
    expect(placeOnMap('lib:abc')).toBe('/studio?mode=world&place=abc');
    expect(placeOnMap('abc', 'w1')).toBe('/studio?mode=world&world=w1&place=abc');
  });

  it('opens a map and the draft', () => {
    expect(openMap('w1')).toBe('/studio?mode=world&world=w1');
    expect(composeMap()).toBe('/studio?mode=world');
  });
});

describe('the guide link', () => {
  it('carries the view settings and nothing else', () => {
    const settings = new URLSearchParams('build=x&p.floors=2&s.x=150&style=nordic&layer=4&mode=arch');
    expect(openGuide('lib:abc', settings)).toBe(
      '/guide?build=lib%3Aabc&p.floors=2&s.x=150&style=nordic',
    );
  });

  it('works with no settings at all', () => {
    expect(openGuide('gen:1')).toBe('/guide?build=gen%3A1');
  });
});
