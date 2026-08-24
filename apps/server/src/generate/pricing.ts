/**
 * Model pricing and cost accounting.
 *
 * Rates are deliberately the *standard* published rates, not promotional ones. Under-
 * estimating spend is the dangerous direction: it would let the budget guard wave through
 * a call that actually costs more than it thinks. Over-estimating only means the ceiling
 * bites slightly early, which is the safe failure.
 */

export type ModelId = 'claude-sonnet-5' | 'claude-opus-5' | 'claude-haiku-4-5';

export interface ModelPricing {
	/** USD per million input tokens. */
	input: number;
	/** USD per million output tokens. */
	output: number;
}

/** USD per million tokens. Verify against https://anthropic.com/pricing before changing. */
export const PRICING: Record<ModelId, ModelPricing> = {
	// Sonnet 5 had promotional $2/$10 rates into 2026; budgeting uses the standard rates.
	'claude-sonnet-5': { input: 3.0, output: 15.0 },
	'claude-opus-5': { input: 5.0, output: 25.0 },
	'claude-haiku-4-5': { input: 1.0, output: 5.0 },
};

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
	const rates = PRICING[model];
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
	const rates = PRICING[model];
	return (estimatedInputTokens * rates.input + maxTokens * rates.output) / 1_000_000;
}

export function formatUsd(amount: number): string {
	if (amount < 0.01) return `$${amount.toFixed(4)}`;
	return `$${amount.toFixed(2)}`;
}
