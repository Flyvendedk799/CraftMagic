/**
 * The prompt box.
 *
 * It shows the price before spending anything. The account behind this runs on a small fixed
 * balance, so "Estimate" (free — it only counts tokens) is a first-class control rather than
 * a detail buried in settings, and the remaining budget is always on screen.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SIZE_OPTIONS, type SizeChoice } from '@craftmagic/core';
import { useAuth } from '../library/auth.js';
import type { Estimate, GenerationPhase, SpendSummary } from './useGeneration.js';

export interface PromptPanelProps {
  phase: GenerationPhase;
  spend: SpendSummary | null;
  estimate: Estimate | null;
  estimating: boolean;
  onEstimate: (prompt: string, size: SizeChoice) => void;
  onGenerate: (prompt: string, size: SizeChoice) => void;
  onCancel: () => void;
  /**
   * Offer refining the build on screen instead of replacing it.
   *
   * Null when there is nothing to refine — an empty plot, or a hand-edited build with no
   * program behind it to send.
   */
  onRefine: ((instruction: string) => void) | null;
  /**
   * Text to open with, handed over by the dashboard's launcher.
   *
   * Seeds the box; it never submits. A generation is charged to a daily allowance, and
   * spending one because a route changed would be taking the user's turn on a click they made
   * somewhere else, before they had seen the price.
   */
  initialPrompt?: string;
}

const EXAMPLES = [
  'a small stone windmill with a wooden roof',
  'a fishing hut on stilts with a jetty',
  'a round watchtower with battlements',
];

/**
 * Where the size control sits in the story: it is about the finished build, not about how much
 * design to ask for.
 *
 * Worth being explicit about in the UI, because the obvious reading is the wrong one. Picking
 * "Small" does not buy a simpler structure — the model is asked for the same detailed one and
 * the build is scaled down to fit, so the detail is still in the program and dragging the
 * editor's size slider back to 100% shows it at full size.
 */
const SIZE_NOTE = 'Detail is designed at full size, then scaled to fit — 100% on the size slider shows it all.';

/** Edits rather than subjects: a refine box wants a change, not another description. */
const REFINEMENTS = [
  'make it twice as tall',
  'add a balcony on the south side',
  'swap the walls for dark oak',
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

/** The four providers, as a person would name them. Matches the settings page. */
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Claude API key',
  openai: 'OpenAI API key',
  'claude-code': 'Claude subscription',
  codex: 'ChatGPT subscription',
};

export function PromptPanel({
  phase,
  spend,
  estimate,
  estimating,
  onEstimate,
  onGenerate,
  onCancel,
  onRefine,
  initialPrompt = '',
}: PromptPanelProps) {
  const auth = useAuth();
  // Initial value only, deliberately: re-syncing to the prop would overwrite whatever the user
  // had typed the moment anything above this re-rendered.
  const [prompt, setPrompt] = useState(initialPrompt);
  // Natural by default: no size is a real answer, and it is the one that was in force before
  // this control existed. Nobody's first generation should quietly come out shrunk.
  const [size, setSize] = useState<SizeChoice>('natural');
  const running = phase.kind !== 'idle' && phase.kind !== 'failed';
  // Every generation is billed to an account's daily allowance, so there is no such thing as
  // an anonymous one. Disabled up front rather than left to fail with a 401 after typing.
  const signedIn = auth.status === 'signedIn';
  const canSubmit = prompt.trim().length > 0 && !running && signedIn;
  const outOfBudget = spend !== null && spend.remainingUsd <= 0;

  return (
    <section className="hud prompt" data-signed-in={signedIn}>
      <h2 className="hud__section">{onRefine ? 'Change this build' : 'Generate a build'}</h2>

      {auth.status === 'anonymous' && (
        <p className="prompt__notice">
          <Link className="hud__link" to="/dashboard">
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
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSubmit) {
            if (onRefine) onRefine(prompt);
            else onGenerate(prompt, size);
          }
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

      {/* Only for a new build. A refine changes the structure on screen and leaves its size
          where the user put it — offering a size here would read as a resize control, which is
          what the scale panel already is. */}
      {!onRefine && (
        <div className="prompt__size">
          <p className="prompt__size-label">Size</p>
          <div className="prompt__sizes" role="radiogroup" aria-label="How big the build should be">
            {SIZE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={size === option.id}
                className={`prompt__size-option ${size === option.id ? 'prompt__size-option--on' : ''}`}
                disabled={running}
                title={option.hint}
                onClick={() => setSize(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="prompt__size-hint">
            {SIZE_OPTIONS.find((option) => option.id === size)?.hint}
            {size !== 'natural' && <span className="prompt__muted"> · {SIZE_NOTE}</span>}
          </p>
        </div>
      )}

      <div className="prompt__actions">
        <button
          type="button"
          onClick={() => onEstimate(prompt, size)}
          disabled={!canSubmit || estimating}
        >
          {estimating ? 'Estimating…' : 'Estimate (free)'}
        </button>
        {running ? (
          <button type="button" className="prompt__primary" onClick={onCancel}>
            Stop watching
          </button>
        ) : onRefine ? (
          <>
            <button
              type="button"
              onClick={() => onGenerate(prompt, size)}
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
            onClick={() => onGenerate(prompt, size)}
            disabled={!canSubmit || outOfBudget}
            title={outOfBudget ? 'Monthly budget reached' : 'Ctrl/Cmd + Enter'}
          >
            Generate
          </button>
        )}
      </div>

      {running && (
        <p className="prompt__status prompt__status--busy">
          <span className="prompt__spinner" aria-hidden="true" />
          {describe(phase)}
        </p>
      )}

      {phase.kind === 'failed' && (
        <p className="prompt__status prompt__status--error" role="alert">
          {phase.message}
        </p>
      )}

      {estimate && !running && (
        <dl className="prompt__estimate">
          {/* Who is serving, and who is paying. There are four providers now and two of them
              are subscriptions, so "what will this cost me" has two very different answers and
              the estimate is meaningless without knowing which one is in force. */}
          <dt>Using</dt>
          <dd>
            {PROVIDER_LABEL[estimate.provider]}
            <span className="prompt__muted"> · {estimate.model}</span>
          </dd>
          <dt>This build</dt>
          <dd>
            {estimate.metered ? (
              <>
                ~{usd(estimate.cachedCallUsd)}
                <span className="prompt__muted"> · up to {usd(estimate.worstCaseUsd)}</span>
              </>
            ) : (
              <>
                free
                <span className="prompt__muted"> · billed to the plan</span>
              </>
            )}
          </dd>
          <dt>Prompt size</dt>
          <dd>{estimate.inputTokens.toLocaleString()} tokens in</dd>
        </dl>
      )}

      {/* The ceiling is about this deployment's card, so it is not the thing to show while a
          subscription is serving: it would be a number that cannot move. */}
      {spend && estimate?.metered !== false && (
        <p className="prompt__budget">
          <span className="prompt__muted">Budget</span> {usd(spend.remainingUsd)} left of{' '}
          {usd(spend.monthlyBudgetUsd)}
          <span className="prompt__muted"> · {spend.callsThisMonth} calls this month</span>
        </p>
      )}
    </section>
  );
}
