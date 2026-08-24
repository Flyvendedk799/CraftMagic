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

import Anthropic from '@anthropic-ai/sdk';
import {
	expand,
	type BuildProgram,
	type ExpandIssue,
	type ExpandResult,
} from '@imaginecraft/core';
import schema from '@imaginecraft/core/schema' with { type: 'json' };
import { repairPrompt, systemPrompt } from './prompt.js';
import { schemaIssues } from './validate.js';
import type { ModelId } from './pricing.js';
import { costOf } from './pricing.js';
import type { SpendLedger } from './spend.js';

export const TOOL_NAME = 'emit_build_program';

export interface GenerateOptions {
	prompt: string;
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
	client: Anthropic;
	ledger: SpendLedger;
}

export async function generateBuild(
	deps: PipelineDeps,
	options: GenerateOptions,
): Promise<GenerateResult> {
	const model = options.model ?? DEFAULT_MODEL;
	const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
	const system = systemPrompt();

	// Rough token estimate for the guard: ~3.8 chars per token is close enough, and the
	// guard's job is to be conservative rather than exact.
	const estimatedInput = Math.ceil((system.length + options.prompt.length) / 3.8) + 500;
	deps.ledger.assertCanAfford(model, estimatedInput, maxTokens);

	const tools: Anthropic.Tool[] = [
		{
			name: TOOL_NAME,
			description:
				'Emit the complete build program for the requested structure. This is the only way to respond. ' +
				'The tool input IS the program object itself — its top-level keys are version, meta, size, ' +
				'palette and components. Do not nest it inside any wrapper object.',
			input_schema: schema as unknown as Anthropic.Tool.InputSchema,
			// NOT strict: true. Strict tool use rejects this schema outright — group children
			// are components, which is a circular `$ref` that strict mode does not support.
			// The schema is still enforced, just on our side: ajv below checks structure and
			// the expander checks semantics, and both feed the single repair round.
		},
	];

	const messages: Anthropic.MessageParam[] = [
		{ role: 'user', content: options.prompt },
	];

	let totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

	const callModel = async (purpose: string): Promise<Anthropic.Message> => {
		options.onProgress?.({ stage: 'thinking' });

		const stream = deps.client.messages.stream(
			{
				model,
				max_tokens: maxTokens,
				// Marking the system prompt cacheable is the single biggest cost lever here:
				// it is identical on every generation, so after the first call this prefix
				// bills at a tenth of its normal rate.
				system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
				output_config: { effort: options.effort ?? 'medium' },
				tools,
				tool_choice: { type: 'tool', name: TOOL_NAME },
				messages,
			},
			options.signal ? { signal: options.signal } : undefined,
		);

		// Coarse progress: count components as their JSON streams in, so the UI can show
		// the build assembling rather than a spinner.
		let seen = 0;
		stream.on('inputJson', (partial: string) => {
			const count = (partial.match(/"type"\s*:/g) ?? []).length;
			if (count > seen) {
				seen = count;
				options.onProgress?.({ stage: 'emitting', components: count });
			}
		});

		const message = await stream.finalMessage();

		const entry = deps.ledger.record(model, purpose, message.usage);
		totals = {
			input: totals.input + message.usage.input_tokens,
			output: totals.output + message.usage.output_tokens,
			cacheRead: totals.cacheRead + (message.usage.cache_read_input_tokens ?? 0),
			cacheWrite: totals.cacheWrite + (message.usage.cache_creation_input_tokens ?? 0),
			cost: totals.cost + entry.costUsd,
		};
		return message;
	};

	const first = await callModel('generate');
	let toolUse = findToolUse(first);
	if (!toolUse) {
		throw new GenerationError(
			`the model did not call ${TOOL_NAME} (stop_reason: ${first.stop_reason})`,
		);
	}

	options.onProgress?.({ stage: 'validating' });
	let program = unwrapProgram(toolUse.input) as BuildProgram;
	options.onProgram?.(program, 'generate');
	let structural = schemaIssues(program);
	let expansion = expand(program);
	let repaired = false;
	let problems = [...structural, ...expansion.errors];

	// Exactly one repair round. The system prompt is cached by now, so this costs little,
	// but a loop here is how a small balance disappears.
	if (problems.length > 0) {
		options.onProgress?.({ stage: 'repairing', issues: problems.length });

		messages.push({ role: 'assistant', content: first.content });
		messages.push({
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: toolUse.id,
					content: repairPrompt(problems),
					is_error: true,
				},
			],
		});

		deps.ledger.assertCanAfford(model, estimatedInput * 2, maxTokens);
		const second = await callModel('repair');
		const repairedUse = findToolUse(second);
		if (repairedUse) {
			const candidate = unwrapProgram(repairedUse.input) as BuildProgram;
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
				toolUse = repairedUse;
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

function findToolUse(message: Anthropic.Message): Anthropic.ToolUseBlock | undefined {
	return message.content.find(
		(block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === TOOL_NAME,
	);
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
export { costOf };
