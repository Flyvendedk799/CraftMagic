import { describe, it, expect } from 'vitest';
import {
  findMaterials,
  readFavourites,
  toggleFavourite,
  MATERIALS,
} from './materials.js';
describe('material browser', () => {
  it('can reach every registered block', () =>
    expect(findMaterials('', 'all', [])).toHaveLength(MATERIALS.length));
  it('finds spaced and underscored names', () =>
    expect(
      findMaterials('oak planks', 'wood', []).some(
        (v) => v.id === 'minecraft:oak_planks',
      ),
    ).toBe(true));
  it('keeps only registered favourites and caps persistent data', () => {
    expect(
      readFavourites('["minecraft:stone","bad","minecraft:stone"]'),
    ).toEqual(['minecraft:stone']);
    expect(readFavourites('{')).toEqual([]);
  });
  it('toggles favourites without duplicates', () => {
    const one = toggleFavourite([], 'minecraft:stone');
    expect(toggleFavourite(one, 'minecraft:stone')).toEqual([]);
    expect(findMaterials('', 'favourites', one)).toHaveLength(1);
  });
  it('never selects arbitrary unknown blocks from stored metadata', () =>
    expect(toggleFavourite([], 'unknown')).toEqual([]));
});
