import { describe, expect, it } from 'vitest';
import { onboardingProgress, onboardingSteps } from './onboarding.js';

const NOBODY = { signedIn: false, savedBuilds: 0, pairedAgents: 0, successfulJobs: 0 };

const EVERYTHING = {
  signedIn: true,
  savedBuilds: 2,
  pairedAgents: 1,
  successfulJobs: 1,
  mapsWithPlacements: 1,
};

describe('onboardingSteps', () => {
  it('ticks nothing for a visitor with no account', () => {
    expect(onboardingSteps(NOBODY).every((step) => !step.done)).toBe(true);
  });

  it('sends every unfinished step somewhere it can actually be done', () => {
    for (const step of onboardingSteps(NOBODY)) {
      expect(step.href).toBeTruthy();
      expect(step.action).toBeTruthy();
    }
  });

  it('drops the link once a step is finished', () => {
    const steps = onboardingSteps(EVERYTHING);
    expect(steps.map((step) => step.href)).toEqual([null, null, null, null, null]);
  });

  it('does not tick "save a build" for an account that has none', () => {
    const steps = onboardingSteps({ ...NOBODY, signedIn: true });
    expect(steps.find((step) => step.id === 'build')?.done).toBe(false);
  });

  it('treats a paired world as proof the mod is installed', () => {
    const steps = onboardingSteps({ ...NOBODY, signedIn: true, savedBuilds: 1, pairedAgents: 1 });
    expect(steps.find((step) => step.id === 'pair')?.done).toBe(true);
  });

  // The finale used to be absent because nothing could observe it. Now that something can,
  // the one thing it must never do is tick for the wrong reason.
  it('does not tick "send a build" on pairing alone', () => {
    const steps = onboardingSteps({ ...NOBODY, signedIn: true, savedBuilds: 1, pairedAgents: 1 });
    expect(steps.find((step) => step.id === 'send')?.done).toBe(false);
  });

  it('ticks "send a build" only on a job that finished', () => {
    const steps = onboardingSteps({ ...NOBODY, signedIn: true, pairedAgents: 1, successfulJobs: 1 });
    expect(steps.find((step) => step.id === 'send')?.done).toBe(true);
  });

  it('points "send a build" at the most recent saved build when there is one', () => {
    const steps = onboardingSteps({ ...NOBODY, signedIn: true, recentBuildHref: '/studio?build=lib%3Aabc' });
    expect(steps.find((step) => step.id === 'send')?.href).toBe('/studio?build=lib%3Aabc');
    expect(onboardingSteps(NOBODY).find((step) => step.id === 'send')?.href).toBe('/studio');
  });

  it('ticks the map step only when a map has something placed on it', () => {
    const none = onboardingSteps({ ...NOBODY, mapsWithPlacements: 0 });
    expect(none.find((step) => step.id === 'map')?.done).toBe(false);
    const unknown = onboardingSteps(NOBODY);
    expect(unknown.find((step) => step.id === 'map')?.done).toBe(false);
    const some = onboardingSteps({ ...NOBODY, mapsWithPlacements: 1 });
    expect(some.find((step) => step.id === 'map')?.done).toBe(true);
  });

  it('marks the map step optional and nothing else', () => {
    expect(onboardingSteps(NOBODY).filter((step) => step.optional).map((step) => step.id)).toEqual(['map']);
  });
});

describe('onboardingProgress', () => {
  it('counts what is done and points at the first thing that is not', () => {
    const progress = onboardingProgress(
      onboardingSteps({ signedIn: true, savedBuilds: 0, pairedAgents: 0, successfulJobs: 0 }),
    );
    expect(progress).toMatchObject({ done: 1, total: 4, complete: false });
    expect(progress.next?.id).toBe('build');
  });

  it('reports completion with nothing left to point at', () => {
    const progress = onboardingProgress(onboardingSteps(EVERYTHING));
    expect(progress).toMatchObject({ done: 4, total: 4, complete: true, next: null });
  });

  it('finishes without the optional map step', () => {
    const progress = onboardingProgress(onboardingSteps({ ...EVERYTHING, mapsWithPlacements: 0 }));
    expect(progress.complete).toBe(true);
    expect(progress.next).toBeNull();
  });

  it('never points at the optional step', () => {
    const progress = onboardingProgress(
      onboardingSteps({ signedIn: true, savedBuilds: 1, pairedAgents: 0, successfulJobs: 0 }),
    );
    expect(progress.next?.id).toBe('pair');
  });

  // The order is the path: an account, then something to build, then somewhere to build it,
  // then the build landing there. A checklist that offers step three first is a checklist
  // nobody finishes.
  it('keeps the steps in the order they have to happen', () => {
    expect(onboardingSteps(NOBODY).map((step) => step.id)).toEqual(['account', 'build', 'map', 'pair', 'send']);
  });
});
