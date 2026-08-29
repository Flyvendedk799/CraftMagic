/**
 * Fitting a build to a block budget.
 *
 * The obvious implementation — work out the factor from the numbers — does not exist, because
 * how a build's block count follows its size depends on what kind of build it is. A solid mass
 * scales with the cube of the factor; a wall, a roof or a fence scales with the square; a
 * ridge line scales linearly. Real structures are a mix, and the mix is different for every
 * one of them: halving the sample cottage takes it from 979 blocks to 223, where a cube law
 * predicts 122 and a square law predicts 245.
 *
 * So the count is measured rather than predicted. Expanding a program is a few milliseconds of
 * deterministic arithmetic, and a handful of probes lands on the answer exactly — which is
 * worth far more than a formula that is confidently wrong on half the builds it sees.
 *
 * The search is a binary one over the scale slider's own 5% steps, so the value it finds is a
 * value the user can drag back and forth from rather than a number between two stops.
 */

import { MIN_FIT_PERCENT, type BlockBudget } from '../ir/scale.js';
import type { BuildProgram, ExpandResult, ScalePercent } from '../ir/types.js';
import { expand } from './expander.js';

/** The slider's step, so a fitted build opens on a position the control can actually show. */
const STEP = 5;

export interface FittedBuild {
  /** The scale to store on the program, or undefined when it already fits. */
  scale: ScalePercent | undefined;
  /** The build that scale produces — already expanded, so nobody has to do it twice. */
  expansion: ExpandResult;
  /**
   * Why the fit is what it is, for the caller to report.
   *
   * `fits` — the design was already inside the budget and nothing was scaled.
   * `scaled` — it was above the budget and a scale brought it inside.
   * `floor` — it was so far above that even the smallest allowed scale overshoots. The build
   *   is drawn at that floor rather than dissolved; a size choice may shrink a build, not
   *   destroy it.
   * `under` — it came out below the budget. Nothing is done about that on purpose: enlarging
   *   cannot add the detail the extra room wants, and a chunky blown-up cottage is a worse
   *   answer than a small one. The brief is what aims the model at the top end.
   */
  outcome: 'fits' | 'scaled' | 'floor' | 'under';
}

/**
 * Bring a program inside a block budget by scaling it down.
 *
 * `expanded` is the program at 100%, when the caller already has it — every caller does, since
 * a program has to be expanded before anyone knows whether it needs fitting at all.
 */
export function fitToBudget(
  program: BuildProgram,
  budget: BlockBudget | null,
  expanded?: ExpandResult,
): FittedBuild {
  const natural = expanded ?? expand(program);
  if (budget === null) return { scale: undefined, expansion: natural, outcome: 'fits' };

  if (natural.blockCount < budget.min) {
    return { scale: undefined, expansion: natural, outcome: 'under' };
  }
  if (budget.max === null || natural.blockCount <= budget.max) {
    return { scale: undefined, expansion: natural, outcome: 'fits' };
  }

  const ceiling = budget.max;
  const at = (percent: number): ExpandResult =>
    expand({ ...program, scale: { x: percent, y: percent, z: percent } });

  // The biggest step that fits is the one to take: within a budget, larger is better, since
  // every block the shrink drops is a block of detail the design had.
  let low = MIN_FIT_PERCENT;
  let high = 100 - STEP;
  let best: { percent: number; expansion: ExpandResult } | null = null;

  while (low <= high) {
    // Rounded to a step, so every probe is a value the slider can hold.
    const middle = low + Math.floor((high - low) / (2 * STEP)) * STEP;
    const expansion = at(middle);

    // A scale that empties the build is never an answer, whatever the budget says.
    if (expansion.blockCount > 0 && expansion.blockCount <= ceiling) {
      best = { percent: middle, expansion };
      low = middle + STEP;
    } else {
      high = middle - STEP;
    }
  }

  if (best) {
    const percent = best.percent;
    return {
      scale: { x: percent, y: percent, z: percent },
      expansion: best.expansion,
      outcome: 'scaled',
    };
  }

  // Nothing inside the budget is reachable: the design is more than four times the size that
  // was asked for. It is drawn at the floor, which is smaller than requested but still the
  // build — and the panel says what it came out at, so the number on screen is never a lie.
  const floor = at(MIN_FIT_PERCENT);
  return {
    scale: { x: MIN_FIT_PERCENT, y: MIN_FIT_PERCENT, z: MIN_FIT_PERCENT },
    expansion: floor.blockCount > 0 ? floor : natural,
    outcome: 'floor',
  };
}
