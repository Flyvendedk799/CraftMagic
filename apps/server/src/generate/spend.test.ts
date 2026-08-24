import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { costOf, worstCaseCost } from './pricing.js';
import { BudgetExceededError, SpendLedger } from './spend.js';

const temps: string[] = [];

function ledgerFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-spend-'));
	temps.push(dir);
	return path.join(dir, 'ledger.json');
}

afterEach(() => {
	while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('costOf', () => {
	it('prices input and output at the published rates', () => {
		const cost = costOf('claude-sonnet-5', { input_tokens: 1_000_000, output_tokens: 0 });
		expect(cost.totalUsd).toBeCloseTo(3.0, 6);
		const out = costOf('claude-sonnet-5', { input_tokens: 0, output_tokens: 1_000_000 });
		expect(out.totalUsd).toBeCloseTo(15.0, 6);
	});

	it('charges cache reads at a tenth of input, which is the whole point of caching', () => {
		const cached = costOf('claude-sonnet-5', {
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 1_000_000,
		});
		expect(cached.totalUsd).toBeCloseTo(0.3, 6);
	});

	it('charges cache writes at a premium', () => {
		const written = costOf('claude-sonnet-5', {
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_input_tokens: 1_000_000,
		});
		expect(written.totalUsd).toBeCloseTo(3.75, 6);
	});

	it('prices a realistic generation in cents, not dollars', () => {
		// ~2.4k cached system prompt + short user prompt, ~5k output.
		const cost = costOf('claude-sonnet-5', {
			input_tokens: 120,
			output_tokens: 5_000,
			cache_read_input_tokens: 2_400,
		});
		expect(cost.totalUsd).toBeGreaterThan(0.05);
		expect(cost.totalUsd).toBeLessThan(0.09);
	});
});

describe('worstCaseCost', () => {
	it('assumes every allowed output token is produced', () => {
		// The guard must reason about what a call could cost, not what it usually costs.
		expect(worstCaseCost('claude-sonnet-5', 3_000, 16_000)).toBeCloseTo(
			(3_000 * 3 + 16_000 * 15) / 1_000_000,
			6,
		);
	});
});

describe('SpendLedger', () => {
	it('starts empty and permits an affordable call', () => {
		const ledger = new SpendLedger(ledgerFile(), 4);
		expect(ledger.spentThisMonth()).toBe(0);
		expect(() => ledger.assertCanAfford('claude-sonnet-5', 3_000, 16_000)).not.toThrow();
	});

	it('refuses a call that could breach the ceiling', () => {
		const ledger = new SpendLedger(ledgerFile(), 0.05);
		expect(() => ledger.assertCanAfford('claude-sonnet-5', 3_000, 16_000)).toThrow(
			BudgetExceededError,
		);
	});

	it('refuses *before* spending, based on the worst case rather than the average', () => {
		// A ceiling that a typical call fits under but the worst case does not must still
		// refuse — otherwise one unlucky long response overshoots the balance.
		const ledger = new SpendLedger(ledgerFile(), 0.1);
		expect(() => ledger.assertCanAfford('claude-sonnet-5', 3_000, 16_000)).toThrow();
	});

	it('accumulates recorded spend and blocks once the budget is gone', () => {
		const ledger = new SpendLedger(ledgerFile(), 0.5);
		for (let i = 0; i < 6; i++) {
			ledger.record('claude-sonnet-5', 'generate', { input_tokens: 100, output_tokens: 5_000 });
		}
		expect(ledger.spentThisMonth()).toBeGreaterThan(0.4);
		expect(() => ledger.assertCanAfford('claude-sonnet-5', 3_000, 16_000)).toThrow(
			BudgetExceededError,
		);
	});

	it('persists across restarts, so a bounced server cannot reset the budget', () => {
		const file = ledgerFile();
		const first = new SpendLedger(file, 4);
		first.record('claude-sonnet-5', 'generate', { input_tokens: 1000, output_tokens: 1000 });
		const spent = first.spentThisMonth();

		const reopened = new SpendLedger(file, 4);
		expect(reopened.spentThisMonth()).toBeCloseTo(spent, 10);
		expect(reopened.summary().callsThisMonth).toBe(1);
	});

	it('survives a corrupt ledger without crashing the server', () => {
		const file = ledgerFile();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '{ not json');
		const ledger = new SpendLedger(file, 4);
		expect(ledger.spentThisMonth()).toBe(0);
	});

	it('reports a summary a human can read', () => {
		const ledger = new SpendLedger(ledgerFile(), 4);
		ledger.record('claude-sonnet-5', 'generate', {
			input_tokens: 120,
			output_tokens: 5_000,
			cache_read_input_tokens: 2_400,
		});
		const summary = ledger.summary();
		expect(summary.callsThisMonth).toBe(1);
		expect(summary.remainingUsd).toBeLessThan(4);
		expect(summary.remainingUsd).toBeGreaterThan(3.8);
		expect(summary.entries[0]!.purpose).toBe('generate');
	});

	it('only counts the current calendar month toward the ceiling', () => {
		const file = ledgerFile();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify([
				{
					at: '2020-01-15T00:00:00.000Z',
					model: 'claude-sonnet-5',
					purpose: 'generate',
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					costUsd: 99,
				},
			]),
		);
		const ledger = new SpendLedger(file, 4);
		expect(ledger.spentThisMonth()).toBe(0);
		expect(ledger.summary().lifetimeUsd).toBe(99);
	});
});
