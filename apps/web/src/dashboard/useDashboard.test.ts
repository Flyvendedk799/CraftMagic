import { describe, expect, it } from 'vitest';
import { recentBuilds, totalBlocks } from './useDashboard.js';
import type { LibraryBuild } from '../library/library.js';

function build(id: string, updatedAt: string, blockCount = 100): LibraryBuild {
  return {
    id,
    name: id,
    sizeX: 8,
    sizeY: 8,
    sizeZ: 8,
    blockCount,
    hasProgram: true,
    detached: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
  };
}

describe('recentBuilds', () => {
  it('puts the most recently touched build first whatever order the server sent', () => {
    const builds = [
      build('old', '2026-01-01T00:00:00.000Z'),
      build('newest', '2026-03-01T00:00:00.000Z'),
      build('middle', '2026-02-01T00:00:00.000Z'),
    ];
    expect(recentBuilds(builds, 3).map((b) => b.id)).toEqual(['newest', 'middle', 'old']);
  });

  it('caps the list without mutating the caller’s array', () => {
    const builds = [build('a', '2026-01-01T00:00:00.000Z'), build('b', '2026-02-01T00:00:00.000Z')];
    expect(recentBuilds(builds, 1).map((b) => b.id)).toEqual(['b']);
    expect(builds.map((b) => b.id)).toEqual(['a', 'b']);
  });
});

describe('totalBlocks', () => {
  it('is zero for an empty library', () => {
    expect(totalBlocks([])).toBe(0);
  });

  it('sums every build', () => {
    expect(
      totalBlocks([
        build('a', '2026-01-01T00:00:00.000Z', 12),
        build('b', '2026-01-01T00:00:00.000Z', 30),
      ]),
    ).toBe(42);
  });
});
