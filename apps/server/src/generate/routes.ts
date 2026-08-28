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
import { sizeBrief, systemPrompt } from './prompt.js';
import { costOf, isPricingKnown, isSubscription, worstCaseCost, type ProviderId } from './pricing.js';
import { providerErrorFacts } from '@flyvendedk799/ai-auth';
import { describeProviderError } from './providerError.js';
import { providerFor, type Provider } from './providers.js';
import type { GenerationQuota } from './quota.js';
import type { AiSettings } from '../settings/store.js';
import { BudgetExceededError, type SpendLedger } from './spend.js';
import { GenerationStore } from './store.js';
import schema from '@craftmagic/core/schema' with { type: 'json' };
import { isSizeChoice, type BuildProgram, type SizeChoice } from '@craftmagic/core';

export interface GenerateRoutesOptions {
	ledger: SpendLedger;
	/**
	 * The provider, model and key in force right now.
	 *
	 * Resolved per request rather than captured at boot, because an admin can change all three
	 * from the settings page and a value read once at startup would keep the old key alive
	 * until someone redeployed — which is most of the reason the settings page exists.
	 */
	resolveAi: () => Promise<AiSettings>;
	maxTokens?: number;
	/**
	 * Builds the provider for a subscription, for a given account.
	 *
	 * Takes the user because a subscription is *theirs*: an account that has connected its own
	 * Claude plan generates on that plan, and only an account that has not falls back to
	 * whatever login the server's machine happens to have. Injected rather than imported
	 * because it reads a keychain and a database, neither of which the routes should know
	 * about and neither of which a test should need.
	 */
	subscriptionProvider?: (id: ProviderId, userId: string) => Promise<Provider | null>;
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
		// Cached by provider+key rather than rebuilt per request: an SDK client pools
		// connections, and constructing one per request throws away keep-alive. Keying on the
		// credential means a settings change swaps the client on the next request instead of
		// needing a restart.
		let cachedClient: { key: string; provider: Provider } | null = null;
		const providerFor_ = async (ai: AiSettings, userId: string): Promise<Provider | null> => {
			// A subscription is never cached: it is per account, and the token behind it is
			// refreshed out from under us, so a pooled client would go on presenting a stale one
			// and would hand one person's plan to the next person to ask.
			if (isSubscription(ai.provider)) {
				return (await options.subscriptionProvider?.(ai.provider, userId)) ?? null;
			}
			if (!ai.apiKey) return null;
			const key = `${ai.provider}:${ai.apiKey}`;
			if (cachedClient?.key !== key) {
				cachedClient = { key, provider: providerFor(ai.provider, ai.apiKey) };
			}
			return cachedClient.provider;
		};

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

		/**
		 * The size the caller asked for.
		 *
		 * An unrecognised value is ignored rather than refused: it changes how big the build
		 * comes out, not whether it is valid, and failing a paid request over a stale query
		 * string would be a poor trade.
		 */
		function readSize(body: unknown): SizeChoice | undefined {
			const value = (body as { size?: unknown } | null)?.size;
			return isSizeChoice(value) ? value : undefined;
		}

		/**
		 * The program a refine is editing.
		 *
		 * Three outcomes, kept distinct on purpose: absent (a normal generation), a usable
		 * program, or `'invalid'`. Treating a malformed one as absent would quietly turn
		 * "change this build" into "make a different build", losing the user's work with no
		 * error to explain it.
		 *
		 * Only shape is checked here; the expander is the real validator, and it runs on the
		 * result anyway.
		 */
		function readRefineOf(body: unknown): BuildProgram | 'invalid' | null {
			const value = (body as { refineOf?: unknown } | null)?.refineOf;
			if (value === undefined || value === null) return null;
			if (
				typeof value !== 'object' ||
				!('components' in value) ||
				!Array.isArray((value as { components: unknown }).components) ||
				!('size' in value)
			) {
				return 'invalid';
			}
			return value as BuildProgram;
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
			const ai = await options.resolveAi();
			// Deliberately no readiness gate. Estimating needs a credential only on the one
			// branch below that asks Anthropic to count tokens for free, and that branch already
			// tests for the key it needs; every other path is local arithmetic over the prompt
			// and the schema.
			//
			// The gate that used to be here asked `resolveAi`, which answers about the *machine*
			// — is there a `claude` login on this box. A deployment whose credentials are
			// per-account has no machine login by design, so the answer was always no, and the
			// estimate refused with "no_api_key" on a server that was generating happily. It
			// went unnoticed because generation itself resolves the credential per user, a few
			// lines further down, and only this route disagreed.
			if (!(await payingUser(request, reply))) return;

			const prompt = readPrompt(request.body);
			if (!prompt) {
				return reply.code(400).send({ error: 'bad_prompt', maxLength: MAX_PROMPT_LENGTH });
			}

			const system = systemPrompt();
			// The size brief is part of the user turn, so it is part of what the call costs.
			const brief = sizeBrief(readSize(request.body));
			const userTurn = brief ? `${prompt}\n\n${brief}` : prompt;
			let inputTokens: number;
			let exact: boolean;

			// The free token counter needs an API key, which a subscription does not have. Rather
			// than spend a subscription call to price a call that costs nothing, estimate locally.
			if (ai.provider === 'anthropic' && ai.apiKey) {
				// count_tokens is not billed, so the UI can price every prompt for free.
				const counted = await new Anthropic({ apiKey: ai.apiKey }).messages.countTokens({
					model: ai.model,
					system: [{ type: 'text', text: system }],
					tools: [
						{
							name: TOOL_NAME,
							description: 'Emit the complete build program for the requested structure.',
							input_schema: schema as unknown as Anthropic.Tool.InputSchema,
						},
					],
					messages: [{ role: 'user', content: userTurn }],
				});
				inputTokens = counted.input_tokens;
				exact = true;
			} else {
				// OpenAI has no free token-counting endpoint, and calling the model to find out
				// what a call costs would defeat the point. ~3.8 chars per token, rounded up,
				// plus the schema — an estimate that errs high, which is the safe direction.
				inputTokens = Math.ceil((system.length + userTurn.length + JSON.stringify(schema).length) / 3.8);
				exact = false;
			}

			const typicalOutput = 5000;
			return {
				provider: ai.provider,
				model: ai.model,
				inputTokens,
				/** False when the count is a local approximation rather than the provider's own. */
				exact,
				pricingKnown: isSubscription(ai.provider) || isPricingKnown(ai.model),
				/** False on a subscription: the plan is already paid for, so every figure is zero. */
				metered: !isSubscription(ai.provider),
				firstCallUsd: costOf(
					ai.model,
					{ input_tokens: inputTokens, output_tokens: typicalOutput },
					ai.provider,
				).totalUsd,
				cachedCallUsd: costOf(
					ai.model,
					{ input_tokens: 120, output_tokens: typicalOutput, cache_read_input_tokens: inputTokens },
					ai.provider,
				).totalUsd,
				worstCaseUsd: worstCaseCost(ai.model, inputTokens, maxTokens, ai.provider),
				spend: spendSummary(),
			};
		});

		app.post('/api/generations', async (request, reply) => {
			const ai = await options.resolveAi();

			// The account comes first now, because for a subscription provider it *is* the
			// credential: which plan pays is a fact about who is asking.
			const user = await payingUser(request, reply);
			if (!user) return;

			const provider = await providerFor_(ai, user.id);
			if (!provider) {
				return reply.code(503).send({
					error: 'no_api_key',
					message: isSubscription(ai.provider)
						? 'No Claude subscription is connected for this account. Connect one in Settings.'
						: 'This deployment has no API key configured.',
				});
			}

			const prompt = readPrompt(request.body);
			if (!prompt) {
				return reply.code(400).send({ error: 'bad_prompt', maxLength: MAX_PROMPT_LENGTH });
			}

			// A refine carries the program being changed. Rejected rather than ignored if it is
			// not a program: silently generating something new would throw away the build the
			// user was working on, which is the one outcome a refine must never produce.
			const refineOf = readRefineOf(request.body);
			if (refineOf === 'invalid') {
				return reply.code(400).send({
					error: 'bad_refine',
					message: 'refineOf must be a build program object',
				});
			}

			// Refuse before creating a generation, so an over-budget request fails loudly
			// here rather than as an error event moments later.
			try {
				// The provider matters as much as the model: a subscription call has no worst case
				// to compare against the ceiling, and without passing it this guard refuses free work
				// on the grounds that a metered call would have been expensive.
				options.ledger.assertCanAfford(ai.model, refineOf ? 20_000 : 12_000, maxTokens, ai.provider);
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
			const recordId = await quota.start(user.id, prompt, ai.model);

			const size = readSize(request.body);
			const generation = store.create(prompt);
			// Bound after the guard above: TypeScript will not carry the null-check narrowing
			// into a hoisted function declaration, since one could be called from anywhere.
			const brief: string = prompt;
			const chosen = provider;
			const model = ai.model;
			const refining = refineOf;
			const chosenSize = size;

			// Deliberately not awaited: the response returns an id immediately and progress
			// arrives over SSE.
			void runGeneration();
			return reply.code(202).send({ id: generation.id });

			async function runGeneration(): Promise<void> {
				try {
					const result = await generateBuild(
						{ provider: chosen, ledger: options.ledger },
						{
							prompt: brief,
							...(refining ? { refineOf: refining } : {}),
							...(chosenSize ? { size: chosenSize } : {}),
							model,
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
					// A provider failure is described in terms of the credential that was used, not
					// in terms of the protocol: the remedy for a 429 on a plan is nothing like the
					// remedy for a 429 on a key, and the raw body says neither.
					const described =
						err instanceof GenerationError || err instanceof BudgetExceededError
							? null
							: describeProviderError(err, ai.provider, ai.model);
					const message =
						err instanceof GenerationError || err instanceof BudgetExceededError
							? err.message
							: (described ?? `generation failed: ${(err as Error).message}`);
					// What the provider actually said, kept apart from what we chose to say about
					// it. Only the prose used to be recorded, which meant a failure was
					// undiagnosable the moment the terminal scrolled: the message asserted a
					// cause, and nothing anywhere retained the status code or the rate-limit
					// headers that would have shown the assertion was wrong.
					const facts = providerErrorFacts(err);
					app.log.error({ err, facts }, 'generation failed');

					if (recordId) {
						await quota
							.finish(recordId, {
								status: 'failed',
								error: {
									message,
									provider: ai.provider,
									// Nulls are dropped rather than stored: a row full of them reads
									// as "we looked and found nothing", when the truth is usually
									// that the error never reached a provider at all.
									...(facts.status !== null ? { status: facts.status } : {}),
									...(facts.retryAfter !== null ? { retryAfter: facts.retryAfter } : {}),
									...(facts.planStatus !== null ? { planStatus: facts.planStatus } : {}),
									...(facts.utilization !== null ? { utilization: facts.utilization } : {}),
									...(facts.detail !== null ? { detail: facts.detail } : {}),
								},
							})
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
