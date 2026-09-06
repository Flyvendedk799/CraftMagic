/**
 * "What do I do next?", as data.
 *
 * CraftMagic is one path — make a build, save it, optionally compose it onto a map, then get
 * it into Minecraft — and the seam between the website and the game is where people get
 * stuck: nothing on the site tells you that the block you are missing is a jar file. This
 * turns that path into a list with a visible finish line.
 *
 * Pure, and separated from the page, for one reason: every step's `done` is a claim about the
 * user's account that must be *observable* from data the dashboard already fetches. A step
 * that guesses ticks itself for someone who has not done it, which is worse than not having a
 * checklist — so the conditions are unit-tested rather than eyeballed in a browser.
 *
 * The finale is a build actually landing in Minecraft. For a long time it was absent, on the
 * honest grounds that no endpoint reported whether a job ever ran and inferring it from "a
 * world has been online" would tick for somebody who paired and then closed the game. The
 * endpoint exists now (`GET /api/agent/jobs/summary` counts the jobs that reached `done`), so
 * the checklist can end where the product does.
 */

export interface OnboardingFacts {
  signedIn: boolean;
  /** Builds in the library. Not builds *generated* — see the note on step 2. */
  savedBuilds: number;
  /**
   * Paired Minecraft worlds or servers (agents). Pairing is only possible from inside the
   * game, so it implies the mod. Named for what it counts: "worlds" here collided with World
   * mode, the map tier, on every surface that used the word.
   */
  pairedAgents: number;
  /** Jobs that reached `done` for this account — a build that really landed in a game. */
  successfulJobs: number;
  /**
   * Maps on the account with at least one build placed on them.
   *
   * Counted from the `placements` column the worlds listing already carries, so the optional
   * map step ticks only on evidence. Absent means the listing was not fetched.
   */
  mapsWithPlacements?: number;
  /**
   * Where "send a build" should point once there is something to send — the most recently
   * saved build, opened in Build where the send panel is. Null falls back to the studio.
   */
  recentBuildHref?: string | null;
}

export interface OnboardingStep {
  id: 'account' | 'build' | 'map' | 'pair' | 'send';
  title: string;
  detail: string;
  done: boolean;
  /** Where the step is actually performed. Null once it is done and has nowhere left to go. */
  href: string | null;
  /** The label on that link. */
  action: string;
  /**
   * Shown but never counted. Composing a map is part of the product and worth teaching, but a
   * checklist that cannot finish without it would hold the finish line hostage to a feature
   * plenty of people rightly never need.
   */
  optional?: boolean;
}

export function onboardingSteps(facts: OnboardingFacts): OnboardingStep[] {
  const sent = facts.successfulJobs > 0;
  return [
    {
      id: 'account',
      title: 'Create an account',
      detail: 'Generating, saving and pairing are metered per account, so this comes first.',
      done: facts.signedIn,
      href: facts.signedIn ? null : '/dashboard?signup=1',
      action: 'Sign up',
    },
    {
      id: 'build',
      title: 'Save your first build',
      detail: 'Describe one, draw its floorplan in Architecture, or open a sample — then press “Save to library”.',
      // Saved rather than generated on purpose. The account carries `generationsUsedToday`,
      // which is a rolling 24-hour count — a step keyed off it would tick on Monday and
      // silently un-tick on Tuesday, which reads as the app forgetting what you did.
      done: facts.savedBuilds > 0,
      href: facts.savedBuilds > 0 ? null : '/studio',
      action: 'Open the studio',
    },
    {
      id: 'map',
      title: 'Place it on a map',
      detail: 'Optional: sculpt terrain in World mode and drop your saved builds onto it.',
      done: (facts.mapsWithPlacements ?? 0) > 0,
      href: (facts.mapsWithPlacements ?? 0) > 0 ? null : '/studio?mode=world',
      action: 'Open World mode',
      optional: true,
    },
    {
      id: 'pair',
      title: 'Pair Minecraft',
      detail: 'Install the mod, then type the pairing code in game to build there for real.',
      done: facts.pairedAgents > 0,
      href: facts.pairedAgents > 0 ? null : '/mod',
      action: 'Get the mod',
    },
    {
      id: 'send',
      title: 'Send a build to Minecraft',
      detail: 'Open a saved build, press “Build here”, and place it with the wand. Done when the bot finishes.',
      done: sent,
      href: sent ? null : (facts.recentBuildHref ?? '/studio'),
      action: 'Send one',
    },
  ];
}

export interface OnboardingProgress {
  /** Required steps done. Optional ones are shown but never counted. */
  done: number;
  total: number;
  complete: boolean;
  /** The first unfinished required step — what the page should point at. */
  next: OnboardingStep | null;
}

export function onboardingProgress(steps: OnboardingStep[]): OnboardingProgress {
  const required = steps.filter((step) => !step.optional);
  const done = required.filter((step) => step.done).length;
  return {
    done,
    total: required.length,
    complete: done === required.length,
    next: required.find((step) => !step.done) ?? null,
  };
}
