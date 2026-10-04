import { describe, it, expect } from 'vitest';
import {
  clampWidth,
  readLayout,
  defaultLayout,
  sectionDock,
  DOCKS,
} from './layout.js';
describe('workspace layout', () => {
  it.each([
    [-1, 224],
    [0, 224],
    [9999, 480],
    [300.8, 301],
    [NaN, 272],
    [Infinity, 272],
  ])('clamps width %s', (value, expected) =>
    expect(clampWidth(value)).toBe(expected),
  );
  it('accepts only valid per-mode tabs', () => {
    const saved = defaultLayout();
    saved.active.world.right = 'create';
    const read = readLayout(JSON.stringify(saved));
    expect(read.active.world.right).toBe('inspect');
  });
  it('does not restore focus mode as a mysteriously empty workspace', () =>
    expect(
      readLayout(JSON.stringify({ ...defaultLayout(), focus: true })).focus,
    ).toBe(false));
  it('round trips preferences and clamps old widths', () => {
    const saved = {
      ...defaultLayout(),
      leftWidth: 1,
      rightWidth: 999,
      density: 'compact',
      leftVisible: false,
    };
    const read = readLayout(JSON.stringify(saved));
    expect(read.leftWidth).toBe(224);
    expect(read.rightWidth).toBe(480);
    expect(read.density).toBe('compact');
    expect(read.leftVisible).toBe(false);
  });
  it('routes every central workflow to an existing dock', () => {
    for (const id of [
      'tools',
      'shape',
      'assets',
      'stats',
      'outline',
      'picture',
      'export',
      'save-library-v2',
      'sendtogame',
      'assistant',
      'delivery-state',
    ]) {
      const target = sectionDock(id)!;
      expect(
        DOCKS.build[target.side].some((tab) => tab.id === target.tab),
      ).toBe(true);
    }
    expect(sectionDock('unknown')).toBeNull();
  });
  it('recovers corrupt preferences', () =>
    expect(readLayout('{')).toEqual(defaultLayout()));
});
