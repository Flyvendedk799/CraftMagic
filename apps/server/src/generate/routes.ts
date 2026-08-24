/**
 * Generation API.
 *
 *   POST /api/generations/estimate   what a call would cost — free, no model call
 *   POST /api/generations            start one, returns { id }
 *   GET  /api/generations/:id/events SSE progress, terminating with the program
 *   GET  /api/spend                  ledger summary
 *
 * The estimate endpoint exists because this project runs on a small fixed balance: the UI
 * shows the price before the user commits, and `count_tokens` is free, so asking costs
 * nothing.
 *
 * Both endpoints that reach the model require an account, including the free estimate. Not
 * for tidiness: an anonymous caller has no identity to meter, so on a public deployment one
 * stranger with a loop could spend the entire month's balance before anyone noticed. An
 * account is the smallest thing that makes "30 a day each" mean anything.
 *
 * Two limits then guard the paid path and they are not interchangeable. `SpendLedger` is the
 * hard money stop: it is sized on what the call could cost at `max_tokens`, it runs before
 * every request, and it is the reason a bug cannot drain the balance. The per-user daily quota
 * is fairness on top of that — it stops one account from spending the month's budget before
 * anyone else gets a turn. The ledger check stays first and unconditional; the quota is never
 * skipped, and if it cannot be enforced the request is refused rather than let through.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from '../auth/session.js';
import { generateBuild, GenerationError, TOOL_NAME } from './pipeline.js';
import { systemPrompt } from './prompt.js';
import { costOf, worstCaseCost, type ModelId } from './pricing.js';
import type { GenerationQuota } from './quota.js';
import { BudgetExceededError, type SpendLedger } from './spend.js';
import { GenerationStore } from './store.js';
import schema from '@imaginecraft/core/schema' with { type: 'json' };

export interface GenerateRoutesOptions {
	ledger: SpendLedger;
	model: ModelId;
	apiKey: string | undefined;
	maxTokens?: number;
	auth: Auth;
	/** Null when there is no database: the quota is off, the ledger is not. */
	quota: GenerationQuota | null;
}

const DEFAULT_MAX_TOKENS = 16_000;
/** Long enough for a detailed brief, short enough that nobody pastes a novel into it. */
const MAX_PROMPT_LENGTH = 600;

export function generateRoutes(options: GenerateRoutesOptions): FastifyPluginAsync {
	return async (app) => {
		const store = new GenerationStore();
		const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
		// Constructed once: the client pools connections, and re-creating it per request
		// would throw away keep-alive and the retry configuration.
		const client = options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : undefined;

		const spendSummary = () => {
			const s = options.ledger.summary();
			return {
				spentThisMonthUsd: s.spentThisMonthUsd,
				remainingUsd: s.remainingUsd,
				monthlyBudgetUsd: s.monthlyBudgetUsd,
				callsThisMonth: s.callsThisMonth,
			};
		};

		function readPrompt(body: unknown): string | null {
			const prompt = (body as { prompt?: unknown } | null)?.prompt;
			if (typeof prompt !== 'string') return null;
			const trimmed = prompt.trim();
			if (trimmed.length === 0 || trimmed.length > MAX_PROMPT_LENGTH) return null;
			return trimmed;
		}

		app.get('/api/spend', async () => spendSummary());

		/**
		 * The gate every model-reaching route passes through.
		 *
		 * Returns the caller, or null having already answered. The no-database case is a 503
		 * rather than a 401 because it is not the caller's fault and there is nothing they can
		 * do about it — but it is still a refusal, because without the database there is no
		 * quota, and an unmetered generation endpoint is how a fixed balance disappears.
		 */
		async function payingUser(request: FastifyRequest, reply: FastifyReply) {
			if (!options.quota) {
				await reply.code(503).send({
					error: 'no_database',
					message: 'accounts are unavailable on this server, so generation cannot be metered',
				});
				return null;
			}
			return options.auth.requireUser(request, reply);
		}

		app.post('/api/generations/estimate', async (request, reply) => {
			if (!client) return reply.code(503).send({ error: 'no_api_key' });
			// Free to the caller, but it still reaches Anthropic and still consumes a rate
			// limit shared with the paid path.
			if (!(await payingUser(request, reply))) return;

			const prompt = readPrompt(request.body);
			if (!prompt) {
				return reply.code(400).send({ error: 'bad_prompt', maxLength: MAX_PROMPT_LENGTH });
			}

			// count_tokens is not billed, so the UI can price every keystroke-completed prompt.
			const counted = await client.messages.countTokens({
				model: options.model,
				system: [{ type: 'text', text: systemPrompt() }],
				tools: [
					{
						name: TOOL_NAME,
						description: 'Emit the complete build program for the requested structure.',
						input_schema: schema as unknown as Anthropic.Tool.InputSchema,
					},
				],
				messages: [{ role: 'user', content: prompt }],
			});

			const typicalOutput = 5000;
			return {
				model: options.model,
				inputTokens: counted.input_tokens,
				firstCallUsd: costOf(options.model, {
					input_tokens: counted.input_tokens,
					output_tokens: typicalOutput,
				}).totalUsd,
				cachedCallUsd: costOf(options.model, {
					input_tokens: 120,
					output_tokens: typicalOutput,
					cache_read_input_tokens: counted.input_tokens,
				}).totalUsd,
				worstCaseUsd: worstCaseCost(options.model, counted.input_tokens, maxTokens),
				spend: spendSummary(),
			};
		});

		app.post('/api/generations', async (request, reply) => {
			if (!client) return reply.code(503).send({ error: 'no_api_key' });

			const user = await payingUser(request, reply);
			if (!user) return;

			const prompt = readPrompt(request.body);
			if (!prompt) {
				return reply.code(400).send({ error: 'bad_prompt', maxLength: MAX_PROMPT_LENGTH });
			}

			// Refuse before creating a generation, so an over-budget request fails loudly
			// here rather than as an error event moments later.
			try {
				options.ledger.assertCanAfford(options.model, 12_000, maxTokens);
			} catch (err) {
				if (err instanceof BudgetExceededError) {
					return reply.code(402).send({ error: 'budget_exceeded', message: err.message, spend: spendSummary() });
				}
				throw err;
			}

			// Then fairness. There is no branch that skips this: `payingUser` above has already
			// refused the two ways it could have been skipped — no account, and no database to
			// count against.
			const quota = options.quota!;
			const verdict = await quota.check(user.id, user.dailyGenQuota);
			if (!verdict.allowed) {
				return reply.code(429).send({
					error: 'quota_exceeded',
					message: `You have used all ${verdict.quota} of today's generations. The allowance frees up 24 hours after each one.`,
					used: verdict.used,
					quota: verdict.quota,
				});
			}

			// Recorded before the model is called, and counted whatever happens to it. A
			// generation that fails still cost money and still has to count against the quota,
			// or a prompt that reliably fails validation becomes free and unlimited.
			const recordId = await quota.start(user.id, prompt, options.model);

			const generation = store.create(prompt);
			// Bound after the guard above: TypeScript will not carry the null-check narrowing
			// into a hoisted function declaration, since one could be called from anywhere.
			const brief: string = prompt;
			const anthropic = client;

			// Deliberately not awaited: the response returns an id immediately and progress
			// arrives over SSE.
			void runGeneration();
			return reply.code(202).send({ id: generation.id });

			async function runGeneration(): Promise<void> {
				try {
					const result = await generateBuild(
						{ client: anthropic, ledger: options.ledger },
						{
							prompt: brief,
							model: options.model,
							effort: 'medium',
							maxTokens,
							onProgress: (event) => {
								store.emit(generation.id, {
									type: 'progress',
									stage: event.stage,
									...(event.stage === 'emitting' ? { components: event.components } : {}),
									...(event.stage === 'done' ? { blockCount: event.blockCount } : {}),
								});
							},
						},
					);

					// Written before the event is emitted: the row is the only durable record of
					// a paid call, and the browser can survive learning about it a few
					// milliseconds later.
					if (recordId) {
						await quota
							.finish(recordId, {
								status: result.status,
								inputTokens: result.usage.inputTokens,
								outputTokens: result.usage.outputTokens,
								costUsd: result.usage.costUsd,
								program: result.program,
							})
							.catch((err: unknown) => app.log.warn({ err }, 'could not record the generation'));
					}

					const spend = spendSummary();
					store.emit(generation.id, {
						type: 'done',
						// The *program* is returned, not voxels: the browser expands it itself,
						// which is what gives a generated build the same live param sliders as a
						// built-in sample, for free.
						program: result.program,
						blockCount: result.expansion.blockCount,
						status: result.status,
						repaired: result.repaired,
						issues: result.issues,
						costUsd: result.usage.costUsd,
						spentThisMonthUsd: spend.spentThisMonthUsd,
						remainingUsd: spend.remainingUsd,
					});
				} catch (err) {
					const message =
						err instanceof GenerationError || err instanceof BudgetExceededError
							? err.message
							: `generation failed: ${(err as Error).message}`;
					app.log.error({ err }, 'generation failed');

					if (recordId) {
						await quota
							.finish(recordId, { status: 'failed', error: { message } })
							.catch((e: unknown) => app.log.warn({ err: e }, 'could not record the failure'));
					}

					store.emit(generation.id, { type: 'error', message });
				}
			}
		});

		app.get<{ Params: { id: string } }>('/api/generations/:id/events', (request, reply) => {
			reply.raw.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-transform',
				Connection: 'keep-alive',
				// Without this, a buffering proxy holds the whole stream until it completes,
				// which turns live progress back into a spinner.
				'X-Accel-Buffering': 'no',
			});

			const send = (event: unknown) => {
				reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
			};

			const subscription = store.subscribe(request.params.id, (event) => {
				send(event);
				if (event.type === 'done' || event.type === 'error') reply.raw.end();
			});

			if (!subscription) {
				send({ type: 'error', message: 'unknown generation' });
				reply.raw.end();
				return;
			}

			if (subscription.finished) {
				reply.raw.end();
				return;
			}

			request.raw.on('close', () => subscription.unsubscribe());
		});
	};
}
