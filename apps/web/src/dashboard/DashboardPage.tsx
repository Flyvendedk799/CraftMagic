/**
 * The dashboard — home for anyone with an account.
 *
 * The product is four things joined end to end: describe a build, edit it, and then get it out
 * as a schematic, a printed booklet, or blocks placed in a real world by a mod. Every one of
 * those steps already existed and lived on its own route, which meant the whole path was only
 * visible to someone who had already walked it. This page is that path drawn once.
 *
 * Three rules shaped it, and they are why it is a page of cards rather than a wall of charts:
 *
 *   1. **Start, do not report.** The first thing under the title is a prompt box, because
 *      "make something" is what a visit is for. Statistics are a strip of four numbers below
 *      it, not the headline — nobody opens this to admire a block count.
 *   2. **Every card ends in a link.** A card that states a fact and offers nothing to do with
 *      it is a dead end. Recent builds open, worlds get paired, the quota links to what spends
 *      it. That is the connective tissue the rest of the app was missing.
 *   3. **Nothing here is a second implementation.** Builds come from the same `listBuilds` the
 *      library uses, worlds from the same `useAgents` the editor's send panel uses, and the
 *      account form is the library's `AccountPanel`. A dashboard is a view over the product; the
 *      moment it grows its own copy of a feature, the two start disagreeing.
 *
 * `data-ready` and `data-builds` on the root follow the convention the editor and library
 * already use: the page's content arrives over the network, so a headless screenshot has
 * nothing else to wait on.
 */

import { useCallback, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AppNav } from '../shell/AppNav.js';
import { StatBand } from '../shell/StatBand.js';
import { AccountPanel } from '../library/AccountPanel.js';
import { BuildThumb } from '../library/BuildThumb.js';
import { useAuth } from '../library/auth.js';
import { useAgents, type PairedAgent } from '../agent/useAgents.js';
import { libraryBuildId } from '../editor/builds.js';
import type { LibraryBuild } from '../library/library.js';
import { onboardingProgress, onboardingSteps, type OnboardingStep } from './onboarding.js';
import { recentBuilds, totalBlocks, useDashboard } from './useDashboard.js';
import './dashboard.css';

/** Enough to show a habit forming, few enough that the library still has a job. */
const RECENT_LIMIT = 4;

/** Concrete, and each one exercises a different part of the expander. */
const EXAMPLES = [
  'a small stone windmill with a wooden roof',
  'a fishing hut on stilts with a jetty',
  'a round watchtower with battlements',
];

/** The bundled programs, as a way in for someone with nothing saved and no prompt in mind. */
const SAMPLES = [
  { id: 'cottage', label: 'Cottage' },
  { id: 'tower', label: 'Tower' },
  { id: 'pavilion', label: 'Pavilion' },
];

export function DashboardPage() {
  const auth = useAuth();
  const [search] = useSearchParams();
  const signedIn = auth.status === 'signedIn';
  const account = auth.status === 'signedIn' ? auth.account : null;
  const data = useDashboard(signedIn);
  const agents = useAgents();

  const steps = onboardingSteps({
    signedIn,
    savedBuilds: data.builds.length,
    pairedWorlds: agents.agents.length,
  });
  const progress = onboardingProgress(steps);
  const ready = auth.status !== 'loading' && !data.loading && !agents.loading;

  return (
    <div className="dash" data-ready={ready ? '1' : '0'} data-builds={data.builds.length}>
      <AppNav current="dashboard" />

      {auth.status === 'anonymous' ? (
        <SignedOut signingUp={search.get('signup') === '1'} />
      ) : (
        <main className="dash__main">
          {/* The greeting and the prompt box are one block, not two. "Welcome back" is not a
              thing to look at on its own, and separating them put a heading, a paragraph and
              a card border between arriving and the one control that starts anything. */}
          <section className="hero">
            <div className="hero__intro">
              <p className="dash__eyebrow">Dashboard</p>
              <h1 className="dash__title">
                {account ? `Welcome back, ${handleOf(account.email)}` : 'Welcome back'}
              </h1>
              <p className="dash__sub">
                Describe a structure or lay out its floorplan, shape it in the editor, then send
                it out as a schematic, a printable guide, or blocks in your own world.
              </p>
            </div>

            <Launcher
              generationsLeft={account?.generationsLeftToday ?? 0}
              budgetSpent={data.spend !== null && data.spend.remainingUsd <= 0}
            />
          </section>

          {/* The same band the library uses, for the same reason: these are context for what
              is below, not the subject of the page. Four bordered tiles used to compete with
              the builds for exactly the attention the builds should win. */}
          <StatBand
            label="Your account at a glance"
            stats={[
              {
                label: 'Saved builds',
                value: data.builds.length.toLocaleString(),
                note: data.builds.length === 0 ? 'nothing saved yet' : 'in your library',
                to: '/library',
              },
              {
                label: 'Blocks designed',
                value: compact(totalBlocks(data.builds)),
                note: 'across every build',
                to: '/library',
              },
              {
                label: 'Generations left',
                value: `${account?.generationsLeftToday ?? 0}`,
                note: `of ${account?.dailyGenQuota ?? 0} today`,
                meter:
                  account && account.dailyGenQuota > 0
                    ? account.generationsLeftToday / account.dailyGenQuota
                    : 0,
              },
              {
                label: 'Paired worlds',
                value: `${agents.agents.length}`,
                note: agents.agents.some((agent) => agent.online)
                  ? `${agents.agents.filter((agent) => agent.online).length} online now`
                  : 'none online',
                to: '/mod',
              },
            ]}
          />

          {/* Hidden the moment it is finished rather than left ticked. A permanent list of
              things you already did is clutter on every visit after the first week. */}
          {ready && !progress.complete && <Checklist steps={steps} done={progress.done} />}

          {data.error && (
            <p className="dash__error" role="alert">
              {data.error}
            </p>
          )}

          <div className="dash__grid">
            <BuildsCard builds={data.builds} loading={data.loading} />
            <WorldsCard agents={agents} />
          </div>

          <ExitsCard hasBuild={data.builds.length > 0} firstBuild={data.builds[0] ?? null} />
        </main>
      )}
    </div>
  );
}

/* --- signed out ---------------------------------------------------------- */

/**
 * What an account is for, and the form to make one.
 *
 * Not a redirect to the landing page: someone who reached `/dashboard` is already past being
 * sold to and wants the door, so the form is the page. The three lines above it are the
 * shortest honest answer to "what do I get", not a second pitch.
 */
function SignedOut({ signingUp }: { signingUp: boolean }) {
  return (
    <main className="dash__main dash__main--narrow">
      <header className="hero__intro">
        <div>
          <p className="dash__eyebrow">Dashboard</p>
          <h1 className="dash__title">{signingUp ? 'Create your account' : 'Sign in'}</h1>
          <p className="dash__sub">
            An account is what makes a build yours: it keeps your library across devices, meters
            generation fairly so one person cannot spend the month&rsquo;s budget, and is what a
            Minecraft world pairs to.
          </p>
        </div>
      </header>

      <section className="panel dash__signin">
        <AccountPanel
          initiallyOpen
          initialMode={signingUp ? 'register' : 'login'}
          invitation="Save builds, generate from a prompt, and send a bot into your world."
        />
      </section>

      <p className="dash__signin-note">
        The editor works without one — <Link to="/editor">open it and place some blocks</Link> first
        if you would rather look around.
      </p>
    </main>
  );
}

/* --- launcher ------------------------------------------------------------ */

/**
 * The prompt box, which starts nothing on its own.
 *
 * It hands the typed prompt to the editor as `?prompt=` instead of calling the generation API
 * from here. Two reasons, and the second is the important one: the editor is where a build has
 * to appear anyway, and a generation is charged to a daily allowance — spending one during a
 * route change, before the user has seen an estimate or the "Generate" button in context,
 * would be taking money on a click they did not know was the click.
 */
function Launcher({
  generationsLeft,
  budgetSpent,
}: {
  generationsLeft: number;
  budgetSpent: boolean;
}) {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');

  const open = useCallback(() => {
    const trimmed = prompt.trim();
    navigate(trimmed ? `/editor?prompt=${encodeURIComponent(trimmed)}` : '/editor');
  }, [navigate, prompt]);

  // Two siblings rather than one box, so the hero can put the prompt beside the greeting and
  // run the suggestions full width underneath both. Stacked inside one column, the prompt
  // made the right half half again as tall as the left and left a hole above the greeting.
  return (
    <>
      <section className="launcher" aria-label="Start a build">
        <h2 className="launcher__title">Start a build</h2>

        <div className="launcher__row">
          <textarea
            className="launcher__input"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) open();
            }}
            rows={2}
            maxLength={600}
            placeholder="a small stone windmill with a wooden roof"
            aria-label="Describe the structure to build"
          />
          <button type="button" className="launcher__go" onClick={open}>
            {prompt.trim() ? 'Take it to the editor' : 'Open the editor'}
          </button>
        </div>

        <p className="launcher__note">
          {budgetSpent
            ? 'This deployment has spent its monthly model budget, so generation is paused — the editor and every export still work.'
            : generationsLeft > 0
              ? `${generationsLeft} generation${generationsLeft === 1 ? '' : 's'} left today. The editor shows the price before it spends one.`
              : 'You have used today’s generations. They come back on a rolling 24-hour window — the editor and every export still work in the meantime.'}
        </p>
      </section>

      <div className="suggest">
        <div className="launcher__chips">
          <span className="launcher__chip-label">Try</span>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="launcher__chip"
              onClick={() => setPrompt(example)}
            >
              {example}
            </button>
          ))}
        </div>

        <div className="launcher__chips">
          <span className="launcher__chip-label">Or open</span>
          {/* The one route into the editor that starts with nothing at all, and until the
              ground became clickable it was also the least useful. It is first because
              "start from scratch" is the thing a sample list quietly implies you cannot do. */}
          <Link className="launcher__chip launcher__chip--blank" to="/editor?build=empty">
            An empty plot
          </Link>
          {SAMPLES.map((sample) => (
            <Link key={sample.id} className="launcher__chip" to={`/editor?build=${sample.id}`}>
              {sample.label}
            </Link>
          ))}
        </div>

        {/* The other door into the same engine. It belongs beside the samples rather than
            only in the bar, because "describe it" and "draw the floorplan" are the two ways
            to start and nobody looks for a second tool they have not been told exists. */}
        <div className="launcher__chips">
          <span className="launcher__chip-label">Or draw a floorplan</span>
          <Link className="launcher__chip" to="/layouter">
            Open the layouter
          </Link>
        </div>
      </div>
    </>
  );
}

/* --- stats --------------------------------------------------------------- */

/* --- checklist ----------------------------------------------------------- */

/**
 * The three steps, side by side rather than stacked.
 *
 * Stacked, this was a tall block of mostly-finished rows that pushed the builds below the
 * fold on every visit until the last step was done — and the last step needs a Minecraft
 * install, so for plenty of people that is every visit. Across, it is one strip with a
 * progress bar, and the unfinished step is the only one drawn at full strength.
 */
function Checklist({ steps, done }: { steps: OnboardingStep[]; done: number }) {
  return (
    <section className="checklist">
      <div className="checklist__head">
        <h2 className="dash__card-title">Get set up</h2>
        <span className="checklist__count">
          {done} of {steps.length}
        </span>
        <span
          className="checklist__bar"
          role="progressbar"
          aria-valuenow={done}
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-label="Setup progress"
        >
          <span style={{ width: `${Math.round((done / steps.length) * 100)}%` }} />
        </span>
      </div>

      <ol className="checklist__list">
        {steps.map((step, index) => (
          <li key={step.id} className="checklist__step" data-done={step.done ? '1' : '0'}>
            <span className="checklist__tick" aria-hidden="true">
              {step.done ? '✓' : index + 1}
            </span>
            <span className="checklist__title">{step.title}</span>
            <span className="checklist__detail">{step.detail}</span>
            {step.href && (
              <Link className="checklist__action" to={step.href}>
                {step.action} →
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/* --- builds -------------------------------------------------------------- */

function BuildsCard({ builds, loading }: { builds: LibraryBuild[]; loading: boolean }) {
  const recent = recentBuilds(builds, RECENT_LIMIT);

  return (
    <section className="panel dash__builds">
      <div className="dash__card-head">
        <h2 className="dash__card-title">Recent builds</h2>
        {/* Always, not only once the list overflows. The card is a window onto the library
            and the way out of it should not appear and vanish depending on how much is in
            there — the fifth build is exactly when someone stops noticing new controls. */}
        <Link className="dash__card-more" to="/library">
          {builds.length > RECENT_LIMIT ? `All ${builds.length}` : 'Library'} →
        </Link>
      </div>

      {loading && <p className="dash__empty">Loading…</p>}

      {!loading && recent.length === 0 && (
        <p className="dash__empty">
          Nothing saved yet. Open a build in the <Link to="/editor">editor</Link> and press “Save to
          library” — saved builds are the ones you can send into a world.
        </p>
      )}

      {recent.length > 0 && (
        <ul className="buildlist">
          {recent.map((build) => (
            <li key={build.id} className="buildlist__row" data-build={build.id}>
              {/* The same picture the library draws, at the small size. It is what tells one
                  of your builds from another before you have read a word of the row. */}
              <Link
                className="buildlist__thumb"
                to={`/editor?build=${libraryBuildId(build.id)}`}
                tabIndex={-1}
                aria-hidden="true"
              >
                <BuildThumb build={build} variant="row" />
              </Link>

              <Link className="buildlist__name" to={`/editor?build=${libraryBuildId(build.id)}`}>
                {build.name}
              </Link>

              <p className="buildlist__meta">
                <span>
                  {build.sizeX}×{build.sizeY}×{build.sizeZ}
                </span>
                <span>{build.blockCount.toLocaleString()} blocks</span>
                <span>{formatDate(build.updatedAt)}</span>
                {/* A resizable build still has its program, so the size sliders work on it; an
                    edited one is voxels only. Which of the two you are looking at decides what
                    the editor can do with it, so it is on the card rather than a surprise. */}
                <span className="buildlist__kind">
                  {build.detached || !build.hasProgram ? 'edited' : 'resizable'}
                </span>
              </p>

              <span className="buildlist__actions">
                <Link
                  className="buildlist__action"
                  to={`/editor?build=${libraryBuildId(build.id)}`}
                >
                  Open
                </Link>
                <Link className="buildlist__action" to={`/guide?build=${libraryBuildId(build.id)}`}>
                  Guide
                </Link>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* --- worlds -------------------------------------------------------------- */

/**
 * Paired Minecraft worlds, and the code that pairs one.
 *
 * The pairing code is this feature's entire security boundary — anyone who can read it can
 * attach a world to this account for ten minutes — so it is shown big, with the exact command
 * to type, and never anywhere it could be captured incidentally. Same treatment as the editor's
 * send panel, on purpose: two different-looking presentations of a credential teach people that
 * its appearance does not matter.
 */
function WorldsCard({ agents }: { agents: ReturnType<typeof useAgents> }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    if (!agents.pairCode) return;
    try {
      await navigator.clipboard.writeText(`/craftmagic pair ${agents.pairCode.code}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission can be denied; the command is on screen to type either way.
    }
  }, [agents.pairCode]);

  return (
    <section className="panel dash__worlds">
      <div className="dash__card-head">
        <h2 className="dash__card-title">Your worlds</h2>
        <Link className="dash__card-more" to="/mod">
          Get the mod →
        </Link>
      </div>

      {!agents.available ? (
        <p className="dash__empty">
          Unavailable — this server has no database configured, so worlds cannot be paired.
        </p>
      ) : (
        <>
          {agents.agents.length === 0 && !agents.pairCode && (
            <p className="dash__empty">
              No worlds yet. Install the mod, then pair one to have a bot walk in and build what you
              designed, block by block.
            </p>
          )}

          {agents.agents.length > 0 && (
            <ul className="worlds">
              {agents.agents.map((agent) => (
                <li key={agent.id} className="worlds__row">
                  <span
                    className="worlds__dot"
                    data-online={agent.online ? '1' : '0'}
                    aria-hidden="true"
                  />
                  <span className="worlds__name">{agent.name}</span>
                  <span className="worlds__when">{lastSeen(agent)}</span>
                  <button
                    type="button"
                    className="worlds__forget"
                    onClick={() => void agents.forget(agent.id)}
                  >
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          )}

          {agents.pairCode ? (
            <div className="pair">
              <p className="pair__lead">In your world, type:</p>
              <code className="pair__code">/craftmagic pair {agents.pairCode.code}</code>
              <div className="pair__actions">
                <button type="button" onClick={() => void copy()}>
                  {copied ? 'Copied' : 'Copy command'}
                </button>
                <button type="button" onClick={agents.clearPairCode}>
                  Done
                </button>
              </div>
              <p className="pair__note">
                Valid for ten minutes. The list above updates by itself once the world connects.
              </p>
            </div>
          ) : (
            <button
              type="button"
              className="worlds__pair"
              onClick={() => void agents.createPairCode()}
            >
              Pair a world
            </button>
          )}
        </>
      )}
    </section>
  );
}

/* --- exits --------------------------------------------------------------- */

/**
 * The three ways a build leaves here.
 *
 * All three live in the editor's export bar, which means they are invisible until you have a
 * build open — and "what is this actually for" is exactly the question someone has before they
 * have one. Each card links to the place that does it, against a real build once there is one
 * and against the sample cottage before then, so nothing here is a dead end on day one.
 */
function ExitsCard({
  hasBuild,
  firstBuild,
}: {
  hasBuild: boolean;
  firstBuild: LibraryBuild | null;
}) {
  const target = hasBuild && firstBuild ? libraryBuildId(firstBuild.id) : 'cottage';

  return (
    <section className="exits" aria-label="Ways to export a build">
      <article className="panel exit">
        <h3 className="exit__title">Schematic</h3>
        <p className="exit__body">
          A WorldEdit <code>.schem</code> file, written in your browser. Paste it into any world
          that runs WorldEdit.
        </p>
        <Link className="exit__link" to={`/editor?build=${target}`}>
          Export from the editor →
        </Link>
      </article>

      <article className="panel exit">
        <h3 className="exit__title">Build guide</h3>
        <p className="exit__body">
          A LEGO-style booklet — one page per course, with the blocks you need and where they go.
          Prints straight from the browser.
        </p>
        <Link className="exit__link" to={`/guide?build=${target}`}>
          {hasBuild ? 'Open your guide →' : 'See a sample guide →'}
        </Link>
      </article>

      <article className="panel exit">
        <h3 className="exit__title">Builder bot</h3>
        <p className="exit__body">
          Pair a world with the Fabric mod and a bot walks in and places every block, with progress
          reported back here.
        </p>
        <Link className="exit__link" to="/mod">
          Get the mod →
        </Link>
      </article>
    </section>
  );
}

/* --- formatting ---------------------------------------------------------- */

/** The address without its domain: a greeting, not an identity check. */
function handleOf(email: string): string {
  return email.split('@')[0] || email;
}

/** Absolute rather than relative — "3 days ago" is worse than a date once builds are old. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Block counts run to six figures, and a stat tile has room for four characters. */
function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function lastSeen(agent: PairedAgent): string {
  if (agent.online) return 'online now';
  if (!agent.lastSeenAt) return 'never connected';
  const minutes = Math.round((Date.now() - new Date(agent.lastSeenAt).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
