import { describe, expect, it } from 'vitest';
import { describeProviderError } from './providerError.js';

/** What an SDK actually throws: a status, and a message that is the raw response body. */
function sdkError(status: number, body: string): Error & { status: number } {
  return Object.assign(new Error(`${status} ${body}`), { status });
}

const RATE_LIMIT = '{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}';

describe('describeProviderError', () => {
  it('tells a subscription 429 apart from a metered one, because the fix is different', () => {
    const onPlan = describeProviderError(sdkError(429, RATE_LIMIT), 'claude-code', 'claude-sonnet-5');
    const onKey = describeProviderError(sdkError(429, RATE_LIMIT), 'anthropic', 'claude-sonnet-5');

    // A plan is shared with everything signed in to it, so "another tool is using it" is the
    // likely cause and has to be said. A key is not shared, so it would be a red herring.
    // Leads with the model, because a plan meters each one separately and switching model is
    // the fix that works immediately — diagnosed on a deployment where Haiku answered 200 in
    // the same second Sonnet was refused.
    expect(onPlan).toMatch(/refused this call for `claude-sonnet-5`/);
    expect(onPlan).toMatch(/limits each model separately/);
    expect(onPlan).toMatch(/claude` CLI/);
    expect(onKey).toMatch(/rate-limiting this key/i);
    expect(onKey).not.toMatch(/CLI/);
  });

  it('names the right CLI for Codex', () => {
    expect(describeProviderError(sdkError(429, RATE_LIMIT), 'codex', 'gpt-5-codex')).toMatch(/codex` CLI/);
  });

  it('sends a rejected subscription to the CLI, and a rejected key to Settings', () => {
    expect(describeProviderError(sdkError(401, '{}'), 'claude-code', 'claude-sonnet-5')).toMatch(
      /Run `claude`/,
    );
    expect(describeProviderError(sdkError(401, '{}'), 'anthropic', 'claude-sonnet-5')).toMatch(
      /key was rejected/i,
    );
  });

  it('quotes a 400 back with the model that caused it', () => {
    // The archetype: `effort` on a model that has no adaptive thinking. The user never typed
    // that parameter, so the message has to name the setting they *did* choose.
    const message = describeProviderError(
      sdkError(400, '{"error":{"message":"This model does not support the effort parameter."}}'),
      'claude-code',
      'claude-haiku-4-5-20251001',
    );
    expect(message).toContain('does not support the effort parameter');
    expect(message).toContain('claude-haiku-4-5-20251001');
    expect(message).toMatch(/Settings/);
  });

  it('names the model on a 404, which is what a typo in the model box looks like', () => {
    expect(describeProviderError(sdkError(404, '{}'), 'anthropic', 'claude-sonnet-6')).toContain(
      'claude-sonnet-6',
    );
  });

  it('says a 5xx is the provider’s fault, so nobody goes looking through their settings', () => {
    expect(describeProviderError(sdkError(503, '{}'), 'openai', 'gpt-5')).toMatch(/their side/i);
  });

  it('ignores the placeholder "Error" body Anthropic sends with a 429', () => {
    // Forwarding it produced `generation failed: 429 {"message":"Error"}`, which is the exact
    // shape of message this module exists to stop.
    const message = describeProviderError(sdkError(429, RATE_LIMIT), 'claude-code', 'claude-sonnet-5');
    expect(message).not.toContain('"Error"');
  });

  it('passes a genuine provider sentence through when the status is unremarkable', () => {
    expect(
      describeProviderError(sdkError(422, '{"error":{"message":"prompt is too long"}}'), 'anthropic', 'x'),
    ).toBe('prompt is too long');
  });

  it('is null when it has nothing better to say than the raw error', () => {
    // Null rather than "something went wrong": the status and body at least give someone
    // something to search for, and a vague sentence takes even that away.
    expect(describeProviderError(new Error('socket hang up'), 'anthropic', 'claude-sonnet-5')).toBeNull();
    expect(describeProviderError(sdkError(418, '{}'), 'anthropic', 'claude-sonnet-5')).toBeNull();
  });
});
