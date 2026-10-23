import { describe, expect, it } from 'vitest';
import { getStatePills } from './StepTray.js';

describe('getStatePills', () => {
  it('extracts pills for stairs', () => {
    expect(
      getStatePills({
        kind: 'stairs',
        facing: 'east',
        half: 'top',
        shape: 'straight',
      }),
    ).toEqual(['East', 'Upside-Down']);

    expect(
      getStatePills({
        kind: 'stairs',
        facing: 'north',
        half: 'bottom',
        shape: 'inner_left',
      }),
    ).toEqual(['North', 'Inner Left']);
  });

  it('extracts pills for slabs', () => {
    expect(getStatePills({ kind: 'slab', half: 'top' })).toEqual(['Top']);
    expect(getStatePills({ kind: 'slab', half: 'bottom' })).toEqual(['Bottom']);
  });

  it('extracts pills for pillars', () => {
    expect(getStatePills({ kind: 'pillar', axis: 'y' })).toEqual(['Vertical']);
    expect(getStatePills({ kind: 'pillar', axis: 'x' })).toEqual(['Horizontal X']);
    expect(getStatePills({ kind: 'pillar', axis: 'z' })).toEqual(['Horizontal Z']);
  });

  it('extracts pills for doors and trapdoors', () => {
    expect(getStatePills({ kind: 'door', facing: 'west', half: 'top' })).toEqual(['West', 'Upper']);
    expect(getStatePills({ kind: 'trapdoor', facing: 'south', half: 'bottom' })).toEqual(['South', 'Lower']);
  });

  it('returns empty array for generic blocks', () => {
    expect(getStatePills({ kind: 'generic' })).toEqual([]);
  });
});
