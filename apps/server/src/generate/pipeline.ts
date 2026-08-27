/**
 * Prompt → build program → voxels.
 *
 * The model's only job is to emit a `BuildProgram` through one forced tool call. It never
 * writes prose and never places a block directly. Everything after that — validating,
 * expanding, computing block orientation — is deterministic code, which is what keeps a
 * generation cheap enough to be worth doing on a small budget.
 *
 * Cost discipline is structural here, not advisory:
 *  - the system prompt is marked cacheable, so repeat calls pay ~10% for that prefix
 *  - the budget guard runs before the request, sized on `max_tokens`
 *  - exactly one repair round is allowed, ever
 */

import {
	expand,
	type BuildProgram,
	type ExpandIssue,
	type ExpandResult,
} from '@craftmagic/core';
import schema from '@craftmagic/core/schema' with { type: 'json' };
import { refinePrompt, repairPrompt, systemPrompt } from './prompt.js';
import { schemaIssues } from './validate.js';
import type { ModelId } from './pricing.js';
import type { Provider, ProviderSession } from './providers.js';
import { TOOL_NAME } from './providers.js';
import type { SpendLedger } from './spend.js';

export { TOOL_NAME } from './providers.js';

export interface GenerateOptions {
	prompt: string;
	/**
	 * Refine this program instead of inventing one.
	 *
	 * The whole program goes back to the model, which is what lets "make the roof steeper"
	 * keep the same palette, anchoring and component order rather than producing a different
	 * building that merely matches a description.
	 */
	refineOf?: BuildProgram;
	model?: ModelId;
	/** Lower effort means less thinking and fewer tokens. Meaningful on cost. */
	effort?: 'low' | 'medium' | 'high';
	maxTokens?: number;
	/** Called with coarse progress so a UI can show something during the 10–60s wait. */
	onProgress?: (event: ProgressEvent) => void;
	/**
	 * Called with every program the model emits, before it is validated.
	 *
	 * A paid response must never be thrown away. If expansion fails, the raw program is the
	 * only evidence of what went wrong, and re-requesting it costs real money — so callers
	 * persist it here rather than relying on the return value.
	 */
	onProgram?: (program: BuildProgram, attempt: 'generate' | 'repair') => void;
	signal?: AbortSignal;
}

export type ProgressEvent =
	| { stage: 'thinking' }
	| { stage: 'emitting'; components: number }
	| { stage: 'validating' }
	| { stage: 'repairing'; issues: number }
	| { stage: 'done'; blockCount: number };

export interface GenerateResult {
	program: BuildProgram;
	expansion: ExpandResult;
	status: 'succeeded' | 'succeeded_with_omissions';
	repaired: boolean;
	/** Structural + semantic problems that survived the repair round. */
	issues: ExpandIssue[];
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		costUsd: number;
	};
}

export class GenerationError extends Error {
	constructor(
		message: string,
		readonly issues: ExpandIssue[] = [],
	) {
		super(message);
		this.name = 'GenerationError';
	}
}

const DEFAULT_MODEL: ModelId = 'claude-sonnet-5';
/**
 * A generous build program is a few thousand tokens. 16k leaves headroom for thinking
 * without letting a runaway response cost more than a few cents.
 */
const DEFAULT_MAX_TOKENS = 16_000;

export interface PipelineDeps {
	provider: Provider;
	ledger: SpendLedger;
}

export async function generateBuild(
	deps: PipelineDeps,
	options: GenerateOptions,
): Promise<GenerateResult> {
	const model = options.model ?? DEFAULT_MODEL;
	const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
	const system = systemPrompt();

	// A refine sends the existing program back as well, which is a few thousand tokens the
	// guard must not overlook — otherwise the ceiling is computed against the wrong call.
	const userContent = options.refineOf
		? refinePrompt(options.refineOf, options.prompt)
		: options.prompt;

	// Rough token estimate for the guard: ~3.8 chars per token is close enough, and the
	// guard's job is to be conservative rather than exact.
	const estimatedInput = Math.ceil((system.length + userContent.length) / 3.8) + 500;
	deps.ledger.assertCanAfford(model, estimatedInput, maxTokens, deps.provider.id);

	const session = deps.provider.session({
		model,
		system,
		schema,
		maxTokens,
		...(options.effort ? { effort: options.effort } : {}),
		...(options.signal ? { signal: options.signal } : {}),
		onComponents: (components) => options.onProgress?.({ stage: 'emitting', components }),
	});

	let totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

	const record = (reply: ProviderReplyLike, purpose: string) => {
		const entry = deps.ledger.record(model, purpose, reply.usage, deps.provider.id);
		totals = {
			input: totals.input + reply.usage.input_tokens,
			output: totals.output + reply.usage.output_tokens,
			cacheRead: totals.cacheRead + (reply.usage.cache_read_input_tokens ?? 0),
			cacheWrite: totals.cacheWrite + (reply.usage.cache_creation_input_tokens ?? 0),
			cost: totals.cost + entry.costUsd,
		};
	};

	options.onProgress?.({ stage: 'thinking' });
	const first = await session.emit(userContent);
	record(first, options.refineOf ? 'refine' : 'generate');

	if (first.input === undefined) {
		throw new GenerationError(
			`the model did not call ${TOOL_NAME} (${first.noToolCallReason ?? 'no tool call'})`,
		);
	}

	options.onProgress?.({ stage: 'validating' });
	let program = unwrapProgram(first.input) as BuildProgram;
	options.onProgram?.(program, 'generate');
	let structural = schemaIssues(program);
	let expansion = expand(program);
	let repaired = false;
	let problems = [...structural, ...expansion.errors];

	// Exactly one repair round. The system prompt is cached by now, so this costs little,
	// but a loop here is how a small balance disappears.
	if (problems.length > 0) {
		options.onProgress?.({ stage: 'repairing', issues: problems.length });

		deps.ledger.assertCanAfford(model, estimatedInput * 2, maxTokens, deps.provider.id);
		options.onProgress?.({ stage: 'thinking' });
		const second = await session.repair(repairPrompt(problems));
		record(second, 'repair');

		if (second.input !== undefined) {
			const candidate = unwrapProgram(second.input) as BuildProgram;
			options.onProgram?.(candidate, 'repair');
			const candidateStructural = schemaIssues(candidate);
			const candidateExpansion = expand(candidate);
			const candidateProblems = [...candidateStructural, ...candidateExpansion.errors];
			// Only accept the repair if it is actually better; a worse second attempt should
			// not replace a nearly-working first one.
			if (candidateProblems.length < problems.length || candidateExpansion.blockCount > expansion.blockCount) {
				program = candidate;
				structural = candidateStructural;
				expansion = candidateExpansion;
				problems = candidateProblems;
			}
			repaired = true;
		}
	}

	if (expansion.blockCount === 0) {
		const detail = problems.length
			? problems.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join('; ')
			: `${program.components?.length ?? 0} components drew nothing inside ${expansion.grid.size.x}x${expansion.grid.size.y}x${expansion.grid.size.z}`;
		throw new GenerationError(`the generated program produced an empty build — ${detail}`, expansion.errors);
	}

	options.onProgress?.({ stage: 'done', blockCount: expansion.blockCount });

	return {
		program,
		expansion,
		// Errors remaining here mean some components were skipped; the rest still built, and
		// showing a partial structure beats showing nothing.
		status: problems.length > 0 ? 'succeeded_with_omissions' : 'succeeded',
		repaired,
		issues: problems,
		usage: {
			inputTokens: totals.input,
			outputTokens: totals.output,
			cacheReadTokens: totals.cacheRead,
			costUsd: totals.cost,
		},
	};
}

function looksLikeProgram(value: unknown): value is BuildProgram {
	return (
		typeof value === 'object' &&
		value !== null &&
		'components' in value &&
		'size' in value &&
		Array.isArray((value as { components?: unknown }).components)
	);
}

/**
 * Accept a program that arrived wrapped, stringified, or both.
 *
 * Three variants have shown up in real responses, all on the *first* attempt:
 *   {"params":  {…}}          the program nested under a wrapper key
 *   {"program": "{…}"}        nested *and* serialized as a JSON string
 *   "{…}"                     the whole input as a string
 *
 * Each one existed only to be reformatted by a repair round, which doubled the cost of a
 * generation. Recovering the program here costs nothing; asking a model to re-emit it costs
 * about five cents.
 */
export function unwrapProgram(input: unknown): unknown {
	const candidates = [input, ...(typeof input === 'object' && input !== null ? Object.values(input) : [])];

	for (const candidate of candidates) {
		if (looksLikeProgram(candidate)) return candidate;

		// Tool inputs are sometimes handed back as JSON text rather than an object.
		if (typeof candidate === 'string' && candidate.trimStart().startsWith('{')) {
			try {
				const parsed: unknown = JSON.parse(candidate);
				if (looksLikeProgram(parsed)) return parsed;
				if (typeof parsed === 'object' && parsed !== null) {
					for (const nested of Object.values(parsed)) {
						if (looksLikeProgram(nested)) return nested;
					}
				}
			} catch {
				// Not JSON after all; fall through and let validation report it.
			}
		}
	}

	return input;
}

/** Re-export so callers can price a hypothetical call without importing pricing directly. */
export { costOf } from './pricing.js';

/** Just the parts of a provider reply the ledger needs. */
interface ProviderReplyLike {
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens?: number | null;
		cache_read_input_tokens?: number | null;
	};
}
