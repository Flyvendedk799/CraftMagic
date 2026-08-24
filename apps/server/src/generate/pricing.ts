/**
 * Model pricing and cost accounting.
 *
 * Rates are deliberately the *standard* published rates, not promotional ones. Under-
 * estimating spend is the dangerous direction: it would let the budget guard wave through
 * a call that actually costs more than it thinks. Over-estimating only means the ceiling
 * bites slightly early, which is the safe failure.
 */

/**
 * A model name. A plain string rather than a union because the provider and model are now
 * chosen at runtime on the admin page, so the set is not known at compile time.
 */
export type ModelId = string;

export type ProviderId = 'anthropic' | 'openai';

export interface ModelPricing {
	/** USD per million input tokens. */
	input: number;
	/** USD per million output tokens. */
	output: number;
}

/** USD per million tokens. Verify against the provider's pricing page before changing. */
export const PRICING: Record<string, ModelPricing> = {
	// Sonnet 5 had promotional $2/$10 rates into 2026; budgeting uses the standard rates.
	'claude-sonnet-5': { input: 3.0, output: 15.0 },
	'claude-opus-5': { input: 5.0, output: 25.0 },
	'claude-haiku-4-5': { input: 1.0, output: 5.0 },

	'gpt-5': { input: 1.25, output: 10.0 },
	'gpt-5-mini': { input: 0.25, output: 2.0 },
	'gpt-4.1': { input: 2.0, output: 8.0 },
	'gpt-4.1-mini': { input: 0.4, output: 1.6 },
	'o4-mini': { input: 1.1, output: 4.4 },
};

/**
 * What an unlisted model is assumed to cost.
 *
 * Deliberately expensive. A model can now be typed into a settings field, so the table will
 * fall behind, and the budget guard must never be the thing that discovers it — guessing low
 * would wave through a call costing several times the estimate. Guessing high only makes the
 * ceiling bite early, which is recoverable. This is priced above every model listed above.
 */
export const UNKNOWN_MODEL_PRICING: ModelPricing = { input: 15.0, output: 75.0 };

export function pricingFor(model: ModelId): ModelPricing {
	return PRICING[model] ?? UNKNOWN_MODEL_PRICING;
}

/** True when the model is priced from the table rather than the pessimistic fallback. */
export function isPricingKnown(model: ModelId): boolean {
	return PRICING[model] !== undefined;
}

/** Which provider a model belongs to, inferred from its name. */
export function providerOf(model: ModelId): ProviderId {
	return model.startsWith('claude') ? 'anthropic' : 'openai';
}

/** Cache writes cost more than fresh input; cache reads cost a fraction of it. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export interface TokenUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number | null;
	cache_read_input_tokens?: number | null;
}

export interface CostBreakdown {
	inputUsd: number;
	outputUsd: number;
	cacheWriteUsd: number;
	cacheReadUsd: number;
	totalUsd: number;
}

export function costOf(model: ModelId, usage: TokenUsage): CostBreakdown {
	const rates = pricingFor(model);
	const perToken = (perMillion: number) => perMillion / 1_000_000;

	const inputUsd = usage.input_tokens * perToken(rates.input);
	const outputUsd = usage.output_tokens * perToken(rates.output);
	const cacheWriteUsd =
		(usage.cache_creation_input_tokens ?? 0) * perToken(rates.input) * CACHE_WRITE_MULTIPLIER;
	const cacheReadUsd =
		(usage.cache_read_input_tokens ?? 0) * perToken(rates.input) * CACHE_READ_MULTIPLIER;

	return {
		inputUsd,
		outputUsd,
		cacheWriteUsd,
		cacheReadUsd,
		totalUsd: inputUsd + outputUsd + cacheWriteUsd + cacheReadUsd,
	};
}

/**
 * Worst-case cost of a call before making it, used by the budget guard.
 *
 * Assumes `max_tokens` are all produced, because the guard has to reason about what a call
 * *could* cost, not what a typical one does.
 */
export function worstCaseCost(model: ModelId, estimatedInputTokens: number, maxTokens: number): number {
	const rates = pricingFor(model);
	return (estimatedInputTokens * rates.input + maxTokens * rates.output) / 1_000_000;
}

export function formatUsd(amount: number): string {
	if (amount < 0.01) return `$${amount.toFixed(4)}`;
	return `$${amount.toFixed(2)}`;
}
