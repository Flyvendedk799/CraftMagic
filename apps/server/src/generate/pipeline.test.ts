import { describe, expect, it, vi } from 'vitest';
import { generateBuild, unwrapProgram } from './pipeline.js';
import type { Provider, ProviderReply, ProviderSession, SessionOptions } from './providers.js';
import { PATCH_TOOL_NAME } from './providers.js';
import { BudgetExceededError, type SpendLedger } from './spend.js';

/**
 * Shape captured from a real generation: the whole program arrived nested under a `params`
 * key rather than as the tool input itself. It happened on the first attempt of every run,
 * and the repair round existed only to reformat it — so this doubled the cost of every
 * generation until it was handled.
 */
const wrapped = {
	params: {
		version: 1,
		meta: { name: 'Stone Windmill' },
		size: { x: 11, y: 24, z: 11 },
		palette: { wall_primary: 'minecraft:stone_bricks' },
		components: [
			{ type: 'box', pos: [0, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'wall_primary' } },
		],
	},
};

const plain = wrapped.params;

describe('unwrapProgram', () => {
	it('passes a correctly shaped program through untouched', () => {
		expect(unwrapProgram(plain)).toBe(plain);
	});

	it('unwraps a program nested under a wrapper key', () => {
		expect(unwrapProgram(wrapped)).toBe(wrapped.params);
	});

	it('unwraps regardless of what the wrapper key is called', () => {
		const other = { build_program: plain };
		expect(unwrapProgram(other)).toBe(plain);
	});

	it('parses a program handed back as a JSON string', () => {
		// Seen in a real response: {"program": "{…}"} — wrapped *and* serialized.
		const stringified = { program: JSON.stringify(plain) };
		expect(unwrapProgram(stringified)).toMatchObject({ meta: { name: 'Stone Windmill' } });
	});

	it('parses a bare JSON string input', () => {
		expect(unwrapProgram(JSON.stringify(plain))).toMatchObject({ size: { x: 11 } });
	});

	it('ignores a string that is not JSON', () => {
		expect(unwrapProgram('{ not json at all')).toBe('{ not json at all');
	});

	it('leaves genuinely malformed input alone so validation can report it', () => {
		const junk = { nothing: 'useful' };
		expect(unwrapProgram(junk)).toBe(junk);
		expect(unwrapProgram(null)).toBeNull();
		expect(unwrapProgram('a string')).toBe('a string');
	});

	it('does not mistake a program-shaped fragment for the whole program', () => {
		// `components` must be an array — an object with those keys but a non-array
		// components field is not a program.
		const decoy = { size: {}, components: 'not an array' };
		expect(unwrapProgram(decoy)).toBe(decoy);
	});
});

/** A program that expands to real blocks with no problems at all. */
const goodProgram = {
	version: 1,
	meta: { name: 'Test Box' },
	size: { x: 4, y: 4, z: 4 },
	palette: { wall_primary: 'minecraft:stone_bricks' },
	components: [
		{ type: 'box', pos: [0, 0, 0], size: [4, 4, 4], fill: { type: 'solid', role: 'wall_primary' } },
	],
};

/** Builds — but one component is broken, so the repair round is entered. */
const flawedProgram = {
	...goodProgram,
	components: [
		...goodProgram.components,
		{ type: 'box', pos: ['nonsense', 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'wall_primary' } },
	],
};

const reply = (input: unknown): ProviderReply => ({
	input,
	usage: { input_tokens: 100, output_tokens: 100 },
});

function fakeLedger(overrides: Partial<SpendLedger> = {}): SpendLedger {
	return {
		assertCanAfford: vi.fn(),
		record: vi.fn(() => ({ costUsd: 0.01 })),
		...overrides,
	} as unknown as SpendLedger;
}

function providerOf(makeSession: () => ProviderSession): Provider {
	return { id: 'anthropic', session: makeSession };
}

describe('generateBuild transient failures', () => {
	it('retries the opening call on a transient provider failure, on a fresh session', async () => {
		// `retry-after: 0` keeps the test fast; the code path is the same as a real backoff.
		const overloaded = Object.assign(new Error('529 overloaded'), {
			status: 529,
			headers: { 'retry-after': '0' },
		});
		let sessions = 0;
		const provider = providerOf(() => {
			sessions += 1;
			const failing = sessions === 1;
			return {
				emit: vi.fn(async () => {
					if (failing) throw overloaded;
					return reply(goodProgram);
				}),
				repair: vi.fn(),
			};
		});

		const result = await generateBuild({ provider, ledger: fakeLedger() }, { prompt: 'a box' });

		expect(result.status).toBe('succeeded');
		// The failed session's thread already holds the user turn, so the retry must not
		// re-emit into it — a fresh session is the only safe restart.
		expect(sessions).toBe(2);
	});

	it('does not retry an error that is the request’s own fault', async () => {
		const badRequest = Object.assign(new Error('400 invalid'), { status: 400 });
		let sessions = 0;
		const provider = providerOf(() => {
			sessions += 1;
			return {
				emit: vi.fn(async () => {
					throw badRequest;
				}),
				repair: vi.fn(),
			};
		});

		await expect(
			generateBuild({ provider, ledger: fakeLedger() }, { prompt: 'a box' }),
		).rejects.toBe(badRequest);
		expect(sessions).toBe(1);
	});

	it('keeps the first program when the repair round cannot be afforded', async () => {
		// The first call is allowed, the repair guard refuses. The paid, partly-working
		// program must come back with omissions rather than vanish into the thrown error.
		let calls = 0;
		const ledger = fakeLedger({
			assertCanAfford: vi.fn(() => {
				calls += 1;
				if (calls > 1) throw new BudgetExceededError(1, 1, 1);
			}),
		} as Partial<SpendLedger>);
		const repair = vi.fn();
		const provider = providerOf(() => ({
			emit: vi.fn(async () => reply(flawedProgram)),
			repair,
		}));

		const result = await generateBuild({ provider, ledger }, { prompt: 'a box' });

		expect(result.status).toBe('succeeded_with_omissions');
		expect(result.repaired).toBe(false);
		expect(result.expansion.blockCount).toBeGreaterThan(0);
		expect(repair).not.toHaveBeenCalled();
	});

	it('emits partial previews from the streaming tool JSON', async () => {
		const json = JSON.stringify(goodProgram);
		const provider: Provider = {
			id: 'anthropic',
			session: (options) => ({
				emit: async () => {
					// Simulate the stream: growing prefixes, then the whole thing. The throttle
					// admits the first parseable one immediately (previewAt starts at 0).
					for (let end = 40; end <= json.length; end += 60) {
						options.onPartial?.(json.slice(0, end));
					}
					options.onPartial?.(json);
					return reply(goodProgram);
				},
				repair: vi.fn(),
			}),
		};

		const events: unknown[] = [];
		await generateBuild(
			{ provider, ledger: fakeLedger() },
			{ prompt: 'a box', onProgress: (event) => events.push(event) },
		);

		const previews = events.filter(
			(event): event is { stage: 'emitting'; components: number; partial: object } =>
				typeof event === 'object' &&
				event !== null &&
				(event as { stage?: string }).stage === 'emitting' &&
				(event as { partial?: unknown }).partial !== undefined,
		);
		expect(previews.length).toBeGreaterThanOrEqual(1);
		expect(previews[0]!.partial).toMatchObject({ size: goodProgram.size });
	});

	it('escalates to a second repair only while the build is still empty', async () => {
		// Valid nowhere: the one component never draws, so blockCount stays 0 through the
		// first repair — the exact situation the escalation exists for.
		const broken = {
			...goodProgram,
			components: [
				{ type: 'box', pos: ['nonsense', 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'wall_primary' } },
			],
		};
		let repairs = 0;
		const afford = vi.fn();
		const provider = providerOf(() => ({
			emit: vi.fn(async () => reply(broken)),
			repair: vi.fn(async () => {
				repairs += 1;
				return reply(repairs === 1 ? broken : goodProgram);
			}),
		}));

		const result = await generateBuild(
			{ provider, ledger: fakeLedger({ assertCanAfford: afford } as Partial<SpendLedger>) },
			{ prompt: 'a box' },
		);

		expect(repairs).toBe(2);
		expect(result.status).toBe('succeeded');
		expect(result.repaired).toBe(true);
		// The escalated round is gated at a stricter bar than the first repair's 2x.
		const multipliers = afford.mock.calls.map((call) => (call[1] as number));
		expect(multipliers[2]).toBeGreaterThan(multipliers[1]!);
	});

	it('does not escalate when the flawed build still stands', async () => {
		// One component is broken but the rest built: the paid, partly-working program comes
		// back with omissions after the single repair round — a second round would be spend
		// with nothing to gain.
		let repairs = 0;
		const provider = providerOf(() => ({
			emit: vi.fn(async () => reply(flawedProgram)),
			repair: vi.fn(async () => {
				repairs += 1;
				return reply(flawedProgram);
			}),
		}));

		const result = await generateBuild({ provider, ledger: fakeLedger() }, { prompt: 'a box' });

		expect(repairs).toBe(1);
		expect(result.status).toBe('succeeded_with_omissions');
	});

	it('keeps the first program when the repair call itself fails transiently', async () => {
		const overloaded = Object.assign(new Error('503 unavailable'), { status: 503 });
		const provider = providerOf(() => ({
			emit: vi.fn(async () => reply(flawedProgram)),
			repair: vi.fn(async () => {
				throw overloaded;
			}),
		}));

		const result = await generateBuild({ provider, ledger: fakeLedger() }, { prompt: 'a box' });

		expect(result.status).toBe('succeeded_with_omissions');
		expect(result.repaired).toBe(false);
		expect(result.expansion.blockCount).toBeGreaterThan(0);
	});
});

describe('generateBuild diff refine', () => {
	/** Capture the session options so tests can assert what tools were on offer. */
	function capturingProvider(session: ProviderSession): { provider: Provider; options: () => SessionOptions } {
		let captured: SessionOptions | null = null;
		return {
			provider: {
				id: 'anthropic',
				session: (options) => {
					captured = options;
					return session;
				},
			},
			options: () => captured!,
		};
	}

	const patchReply = (ops: unknown[]): ProviderReply => ({
		input: { ops },
		tool: PATCH_TOOL_NAME,
		usage: { input_tokens: 100, output_tokens: 50 },
	});

	it('offers the patch tool and a cached user turn on refine turns only', async () => {
		const session: ProviderSession = {
			emit: vi.fn(async () => reply(goodProgram)),
			repair: vi.fn(),
		};

		const fresh = capturingProvider(session);
		await generateBuild({ provider: fresh.provider, ledger: fakeLedger() }, { prompt: 'a box' });
		expect(fresh.options().patchSchema).toBeUndefined();
		expect(fresh.options().cacheUserContent).toBeUndefined();

		const refine = capturingProvider(session);
		await generateBuild(
			{ provider: refine.provider, ledger: fakeLedger() },
			{ prompt: 'more moss', refineOf: goodProgram as never },
		);
		expect(refine.options().patchSchema).toBeDefined();
		expect(refine.options().cacheUserContent).toBe(true);
	});

	it('applies patch ops against the id-tagged base program', async () => {
		const emit = vi.fn(async (userContent: string) => {
			// The program shown to the model carries generated ids for ops to address.
			expect(userContent).toContain('"id": "c1"');
			return patchReply([
				{ op: 'setPalette', role: 'wall_primary', block: 'minecraft:mossy_stone_bricks' },
				{
					op: 'addComponent',
					component: {
						type: 'box',
						id: 'plinth',
						pos: [0, 0, 0],
						size: [4, 1, 4],
						fill: { type: 'solid', role: 'wall_primary' },
					},
				},
			]);
		});
		const provider = providerOf(() => ({ emit: emit as never, repair: vi.fn() }));

		const result = await generateBuild(
			{ provider, ledger: fakeLedger() },
			{ prompt: 'mossier, with a plinth', refineOf: goodProgram as never },
		);

		expect(result.status).toBe('succeeded');
		expect(result.program.palette.wall_primary).toBe('minecraft:mossy_stone_bricks');
		expect(result.program.components).toHaveLength(2);
		expect(result.program.components[0]!.id).toBe('c1');
		expect(result.program.components[1]!.id).toBe('plinth');
		// Untouched parts survive by construction.
		expect(result.program.components[0]!).toMatchObject({ type: 'box', size: [4, 4, 4] });
	});

	it('feeds unapplicable ops to the repair round like any other problem', async () => {
		const repair = vi.fn(async (problems: string) => {
			expect(problems).toContain('BAD_PATCH');
			expect(problems).toContain('no-such-id');
			return reply({ ...goodProgram, meta: { name: 'Fixed' } });
		});
		const provider = providerOf(() => ({
			emit: vi.fn(async () => patchReply([{ op: 'removeComponent', target: 'no-such-id' }])),
			repair,
		}));

		const result = await generateBuild(
			{ provider, ledger: fakeLedger() },
			{ prompt: 'remove the roof', refineOf: goodProgram as never },
		);

		expect(repair).toHaveBeenCalledOnce();
		expect(result.repaired).toBe(true);
		expect(result.program.meta.name).toBe('Fixed');
	});

	it('honours ops that arrived through the emit tool anyway', async () => {
		const provider = providerOf(() => ({
			// Same ops payload, but tool name absent — as the emit tool would deliver it.
			emit: vi.fn(async () => reply({ ops: [{ op: 'setMeta', name: 'Renamed' }] })),
			repair: vi.fn(),
		}));

		const result = await generateBuild(
			{ provider, ledger: fakeLedger() },
			{ prompt: 'rename it', refineOf: goodProgram as never },
		);

		expect(result.program.meta.name).toBe('Renamed');
		expect(result.program.components).toHaveLength(1);
	});
});
