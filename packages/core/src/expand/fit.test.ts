import { describe, expect, it } from 'vitest';
import { fitToBudget } from './fit.js';
import { expand } from './expander.js';
import { cottage, pavilion, samples, tower } from '../samples/index.js';
import { blockBudget, describeBudget, describeSize, MIN_FIT_PERCENT, SIZE_OPTIONS } from '../ir/scale.js';
import type { BuildProgram } from '../ir/types.js';

/** A solid cube: the one shape whose block count really is the cube of its size. */
function cube(side: number): BuildProgram {
  return {
    version: 1,
    meta: { name: `${side}-cube` },
    size: { x: side, y: side, z: side },
    palette: { a: 'minecraft:stone' },
    components: [
      {
        type: 'box',
        pos: ['min', 'min', 'min'],
        size: ['max', 'max', 'max'],
        fill: { type: 'solid', role: 'a' },
      },
    ],
  };
}

describe('fitToBudget', () => {
  it('leaves a build that is already inside the budget alone', () => {
    const fitted = fitToBudget(cottage, { min: 800, max: 2_000 });
    expect(fitted.outcome).toBe('fits');
    expect(fitted.scale).toBeUndefined();
    expect(fitted.expansion.blockCount).toBe(expand(cottage).blockCount);
  });

  it('does nothing at all when no size was chosen', () => {
    const fitted = fitToBudget(cottage, null);
    expect(fitted.outcome).toBe('fits');
    expect(fitted.scale).toBeUndefined();
  });

  it('scales a big design down into the budget it was given', () => {
    for (const [name, program] of Object.entries(samples)) {
      for (const choice of ['tiny', 'small', 'medium'] as const) {
        const budget = blockBudget(choice)!;
        const fitted = fitToBudget(program, budget);

        expect(fitted.outcome, `${name} at ${choice}`).toBe('scaled');
        expect(fitted.expansion.blockCount, `${name} at ${choice}`).toBeLessThanOrEqual(budget.max!);
        expect(fitted.expansion.blockCount, `${name} at ${choice}`).toBeGreaterThan(0);
      }
    }
  });

  it('takes the biggest size that fits, not the first one it finds', () => {
    // Every block a shrink drops is a block of detail, so the answer has to be the largest
    // scale inside the budget — one step further up must overshoot.
    const budget = blockBudget('medium')!;
    const fitted = fitToBudget(cottage, budget);
    const percent = fitted.scale!.x;

    const nextUp = percent + 5;
    const bigger = expand({ ...cottage, scale: { x: nextUp, y: nextUp, z: nextUp } });
    expect(bigger.blockCount).toBeGreaterThan(budget.max!);
  });

  it('lands on a value the size slider can actually hold', () => {
    for (const program of [cottage, tower, pavilion]) {
      for (const option of SIZE_OPTIONS) {
        const fitted = fitToBudget(program, option.blocks);
        if (!fitted.scale) continue;
        expect(fitted.scale.x % 5).toBe(0);
        expect(fitted.scale.x).toBeGreaterThanOrEqual(MIN_FIT_PERCENT);
        expect(fitted.scale.x).toBeLessThan(100);
      }
    }
  });

  it('returns the build it measured, so nobody expands it twice', () => {
    const fitted = fitToBudget(tower, blockBudget('small')!);
    const again = expand({ ...tower, scale: fitted.scale! });
    expect(fitted.expansion.blockCount).toBe(again.blockCount);
    expect(fitted.expansion.grid.size).toEqual(again.grid.size);
  });

  it('shrinks a build rather than dissolving it when the budget is out of reach', () => {
    // A 40-block cube is 64,000 blocks. A quarter of it is still a thousand, which is far more
    // than "tiny" asks for — so the floor is what it gets, and it is still a cube.
    const fitted = fitToBudget(cube(40), { min: 20, max: 150 });
    expect(fitted.outcome).toBe('floor');
    expect(fitted.scale).toEqual({ x: MIN_FIT_PERCENT, y: MIN_FIT_PERCENT, z: MIN_FIT_PERCENT });
    expect(fitted.expansion.blockCount).toBeGreaterThan(0);
  });

  it('leaves a design smaller than the budget where it is', () => {
    // Enlarging cannot add the detail the extra room wants; the brief is what aims the model
    // at the top end of a size.
    const fitted = fitToBudget(cube(4), { min: 2_000, max: null });
    expect(fitted.outcome).toBe('under');
    expect(fitted.scale).toBeUndefined();
  });

  it('never scales for the open-ended top size, which has no ceiling to breach', () => {
    for (const program of Object.values(samples)) {
      expect(fitToBudget(program, blockBudget('huge')!).scale).toBeUndefined();
    }
  });

  it('measures rather than assuming a cube law', () => {
    // The cottage is mostly walls and roof, so halving it keeps far more than an eighth of its
    // blocks. A fitter that reasoned from volume would shrink it much too far.
    const half = expand({ ...cottage, scale: { x: 50, y: 50, z: 50 } }).blockCount;
    const whole = expand(cottage).blockCount;
    expect(half).toBeGreaterThan(whole / 8);

    const fitted = fitToBudget(cottage, { min: 150, max: 300 });
    expect(fitted.expansion.blockCount).toBeGreaterThan(150);
    expect(fitted.expansion.blockCount).toBeLessThanOrEqual(300);
  });
});

describe('size choices', () => {
  it('reads as a ladder with no gaps and no overlaps in the wrong direction', () => {
    const budgets = SIZE_OPTIONS.map((option) => option.blocks).filter((b) => b !== null);
    for (let i = 1; i < budgets.length; i++) {
      // Each size starts where the one below it ended: no build falls between two sizes.
      expect(budgets[i]!.min).toBe(budgets[i - 1]!.max);
    }
    expect(budgets[0]!.min).toBeGreaterThan(0);
    expect(budgets[budgets.length - 1]!.max).toBeNull();
  });

  it('describes a budget the way a person would say it', () => {
    expect(describeBudget({ min: 300, max: 800 })).toBe('300–800 blocks');
    expect(describeBudget({ min: 2_000, max: null })).toBe('2,000 blocks or more');
  });

  it('names every size with an example and its numbers', () => {
    for (const option of SIZE_OPTIONS) {
      const line = describeSize(option);
      if (option.blocks === null) {
        expect(line).toBe('Whatever size the design wants');
        continue;
      }
      expect(line).toContain(option.example);
      expect(line).toContain(describeBudget(option.blocks));
    }
  });
});
