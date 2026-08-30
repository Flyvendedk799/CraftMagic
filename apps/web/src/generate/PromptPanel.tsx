/**
 * The prompt box.
 *
 * It shows the price before spending anything. The account behind this runs on a small fixed
 * balance, so "Estimate" (free — it only counts tokens) is a first-class control rather than
 * a detail buried in settings, and the remaining budget is always on screen.
 *
 * Two jobs in one box, and which one it is doing is the thing that has to be unmistakable.
 * With a build on screen the primary button *changes that build*; on an empty plot it makes a
 * new one. They spend the same money and produce very different outcomes, so the panel
 * relabels its heading, its placeholder, its examples and its primary button together rather
 * than leaving a "Refine" button to be noticed among identical siblings.
 *
 * The button text is load-bearing beyond the UI: the deployment driver finds "Generate" by
 * its exact label, so that one stays a plain word with nothing appended.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../library/auth.js';
import type { Estimate, GenerationPhase, SpendSummary } from './useGeneration.js';

export interface PromptPanelProps {
  phase: GenerationPhase;
  spend: SpendSummary | null;
  estimate: Estimate | null;
  estimating: boolean;
  onEstimate: (prompt: string) => void;
  onGenerate: (prompt: string) => void;
  onCancel: () => void;
  /**
   * Offer refining the build on screen instead of replacing it.
   *
   * Null when there is nothing to refine — an empty plot, or a hand-edited build with no
   * program behind it to send.
   */
  onRefine: ((instruction: string) => void) | null;
}

const EXAMPLES = [
  'a small stone windmill with a wooden roof',
  'a fishing hut on stilts with a jetty',
  'a round watchtower with battlements',
];

/** Edits rather than subjects: a refine box wants a change, not another description. */
const REFINEMENTS = [
  'make it twice as tall',
  'add a balcony on the south side',
  'swap the walls for dark oak',
];

/** The phases, in the order they happen, so the strip can show how far along a run is. */
const PHASE_ORDER: readonly GenerationPhase['kind'][] = [
  'starting',
  'thinking',
  'emitting',
  'validating',
];

function usd(amount: number): string {
  return amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

function describe(phase: GenerationPhase): string {
  switch (phase.kind) {
    case 'starting':
      return 'starting…';
    case 'thinking':
      return 'thinking…';
    case 'emitting':
      return `assembling — ${phase.components} component${phase.components === 1 ? '' : 's'}`;
    case 'validating':
      return 'checking the build…';
    case 'repairing':
      return 'fixing a problem…';
    default:
      return '';
  }
}

export function PromptPanel({
  phase,
  spend,
  estimate,
  estimating,
  onEstimate,
  onGenerate,
  onCancel,
  onRefine,
}: PromptPanelProps) {
  const auth = useAuth();
  const [prompt, setPrompt] = useState('');
  const running = phase.kind !== 'idle' && phase.kind !== 'failed';
  // Every generation is billed to an account's daily allowance, so there is no such thing as
  // an anonymous one. Disabled up front rather than left to fail with a 401 after typing.
  const signedIn = auth.status === 'signedIn';
  const canSubmit = prompt.trim().length > 0 && !running && signedIn;
  const outOfBudget = spend !== null && spend.remainingUsd <= 0;

  // Repair is not a step of its own — it is a second lap of validation — so it lights the
  // same segment rather than adding one the first run never reaches.
  const reached = PHASE_ORDER.indexOf(phase.kind === 'repairing' ? 'validating' : phase.kind);

  const submit = () => {
    if (!canSubmit || outOfBudget) return;
    if (onRefine) onRefine(prompt);
    else onGenerate(prompt);
  };

  return (
    <section className="prompt" data-signed-in={signedIn}>
      <div className="prompt__head">
        <h2 className="hud__section">{onRefine ? 'Change this build' : 'Describe a build'}</h2>
        {spend && (
          <span
            className="prompt__left"
            title={`${usd(spend.remainingUsd)} left of ${usd(spend.monthlyBudgetUsd)} this month`}
            data-empty={outOfBudget}
          >
            {usd(spend.remainingUsd)}
          </span>
        )}
      </div>

      {auth.status === 'anonymous' && (
        <p className="prompt__notice">
          <Link className="hud__link" to="/library">
            Sign in
          </Link>{' '}
          to generate — every build is charged to an account&rsquo;s daily allowance.
        </p>
      )}

      <textarea
        className="prompt__input"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
        }}
        placeholder={
          onRefine
            ? 'make the roof steeper and add a chimney'
            : 'a small stone windmill with a wooden roof'
        }
        rows={3}
        maxLength={600}
        disabled={running}
        aria-label={onRefine ? 'Describe the change to make' : 'Describe the structure to build'}
      />

      <div className="prompt__examples">
        {(onRefine ? REFINEMENTS : EXAMPLES).map((example) => (
          <button
            key={example}
            type="button"
            className="prompt__example"
            disabled={running}
            onClick={() => setPrompt(example)}
          >
            {example}
          </button>
        ))}
      </div>

      <div className="prompt__actions">
        <button
          type="button"
          className="prompt__secondary"
          onClick={() => onEstimate(prompt)}
          disabled={!canSubmit || estimating}
          title="Counts the tokens without spending anything"
        >
          {estimating ? 'Estimating…' : 'Estimate'}
        </button>
        {running ? (
          <button type="button" className="prompt__primary" onClick={onCancel}>
            Stop watching
          </button>
        ) : onRefine ? (
          <>
            <button
              type="button"
              className="prompt__secondary"
              onClick={() => onGenerate(prompt)}
              disabled={!canSubmit || outOfBudget}
              title="Start over from this description"
            >
              New build
            </button>
            <button
              type="button"
              className="prompt__primary"
              onClick={() => onRefine(prompt)}
              disabled={!canSubmit || outOfBudget}
              title={outOfBudget ? 'Monthly budget reached' : 'Ctrl/Cmd + Enter'}
            >
              Refine this
            </button>
          </>
        ) : (
          <button
            type="button"
            className="prompt__primary"
            onClick={() => onGenerate(prompt)}
            disabled={!canSubmit || outOfBudget}
            title={outOfBudget ? 'Monthly budget reached' : 'Ctrl/Cmd + Enter'}
          >
            Generate
          </button>
        )}
      </div>

      {running && (
        <div className="prompt__run">
          <p className="prompt__status prompt__status--busy">
            <span className="prompt__spinner" aria-hidden="true" />
            {describe(phase)}
          </p>
          {/* A run takes the better part of a minute and used to show one line of text the
              whole way through, which is indistinguishable from being stuck. */}
          <div className="prompt__steps" aria-hidden="true">
            {PHASE_ORDER.map((kind, index) => (
              <span
                key={kind}
                className="prompt__step"
                data-done={index < reached}
                data-active={index === reached}
              />
            ))}
          </div>
        </div>
      )}

      {phase.kind === 'failed' && (
        <p className="prompt__status prompt__status--error" role="alert">
          {phase.message}
        </p>
      )}

      {estimate && !running && (
        <dl className="prompt__estimate">
          <dt>This build</dt>
          <dd>
            ~{usd(estimate.cachedCallUsd)}
            <span className="prompt__muted"> · up to {usd(estimate.worstCaseUsd)}</span>
          </dd>
          <dt>Prompt size</dt>
          <dd>{estimate.inputTokens.toLocaleString()} tokens in</dd>
        </dl>
      )}

      {spend && (
        <p className="prompt__budget">
          <span
            className="prompt__meter"
            aria-hidden="true"
            title={`${usd(spend.remainingUsd)} of ${usd(spend.monthlyBudgetUsd)}`}
          >
            <span
              style={{
                width: `${Math.max(
                  0,
                  Math.min(100, (spend.remainingUsd / Math.max(spend.monthlyBudgetUsd, 1e-6)) * 100),
                )}%`,
              }}
            />
          </span>
          <span className="prompt__muted">Budget</span> {usd(spend.remainingUsd)} left of{' '}
          {usd(spend.monthlyBudgetUsd)}
          <span className="prompt__muted"> · {spend.callsThisMonth} calls this month</span>
        </p>
      )}
    </section>
  );
}
