/**
 * "What do I do next?", as data.
 *
 * CraftMagic is four products stitched together — a generator, an editor, a printable guide
 * and a Minecraft mod — and the seam between the website and the game is where people get
 * stuck: nothing on the site tells you that the block you are missing is a jar file. This
 * turns that path into a list with a visible finish line.
 *
 * Pure, and separated from the page, for one reason: every step's `done` is a claim about the
 * user's account that must be *observable* from data the dashboard already fetches. A step
 * that guesses ticks itself for someone who has not done it, which is worse than not having a
 * checklist — so the conditions are unit-tested rather than eyeballed in a browser.
 *
 * Sending a build into a world is deliberately absent, tempting as it is as a finale: there is
 * no endpoint that reports whether a job ever ran, and inferring it from "a world has been
 * online" would tick for someone who paired and then closed the game.
 */

export interface OnboardingFacts {
  signedIn: boolean;
  /** Builds in the library. Not builds *generated* — see the note on step 2. */
  savedBuilds: number;
  /** Paired worlds. Pairing is only possible from inside the game, so it implies the mod. */
  pairedWorlds: number;
}

export interface OnboardingStep {
  id: 'account' | 'build' | 'world';
  title: string;
  detail: string;
  done: boolean;
  /** Where the step is actually performed. Null once it is done and has nowhere left to go. */
  href: string | null;
  /** The label on that link. */
  action: string;
}

export function onboardingSteps(facts: OnboardingFacts): OnboardingStep[] {
  return [
    {
      id: 'account',
      title: 'Create an account',
      detail: 'Generating and saving are metered per account, so this comes first.',
      done: facts.signedIn,
      href: facts.signedIn ? null : '/dashboard?signup=1',
      action: 'Sign up',
    },
    {
      id: 'build',
      title: 'Save your first build',
      detail: 'Describe one in the prompt box, edit it, then press “Save to library”.',
      // Saved rather than generated on purpose. The account carries `generationsUsedToday`,
      // which is a rolling 24-hour count — a step keyed off it would tick on Monday and
      // silently un-tick on Tuesday, which reads as the app forgetting what you did.
      done: facts.savedBuilds > 0,
      href: facts.savedBuilds > 0 ? null : '/editor',
      action: 'Open the editor',
    },
    {
      id: 'world',
      title: 'Pair a Minecraft world',
      detail: 'Install the mod, then type the pairing code in game to build there for real.',
      done: facts.pairedWorlds > 0,
      href: facts.pairedWorlds > 0 ? null : '/mod',
      action: 'Get the mod',
    },
  ];
}

export interface OnboardingProgress {
  done: number;
  total: number;
  complete: boolean;
  /** The first unfinished step — what the page should point at. */
  next: OnboardingStep | null;
}

export function onboardingProgress(steps: OnboardingStep[]): OnboardingProgress {
  const done = steps.filter((step) => step.done).length;
  return {
    done,
    total: steps.length,
    complete: done === steps.length,
    next: steps.find((step) => !step.done) ?? null,
  };
}
