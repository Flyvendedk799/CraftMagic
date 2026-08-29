import { describe, expect, it, vi } from 'vitest';
import { generateBuild, unwrapProgram } from './pipeline.js';
import type { Provider, ProviderReply, ProviderSession } from './providers.js';
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
