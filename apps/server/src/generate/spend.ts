/**
 * Spend ledger and budget ceiling.
 *
 * This exists because the account behind this key holds a small fixed balance meant to last
 * a month. A bug that retries in a loop, or a stray load test, could drain it in minutes —
 * so every call is recorded, and the guard runs *before* the request, sized on what the call
 * could cost at `max_tokens`, not what a typical one does.
 *
 * The ledger is a plain JSON file rather than a database row: it must work before Postgres
 * is wired up, survive a server restart, and be readable by a human who wants to know where
 * the money went.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
	costOf,
	formatUsd,
	worstCaseCost,
	type ModelId,
	type ProviderId,
	type TokenUsage,
} from './pricing.js';

export interface SpendEntry {
	at: string;
	model: ModelId;
	purpose: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	/**
	 * Who served it, when the writer knew.
	 *
	 * Optional because the ledger is a file that outlives its schema: entries written before
	 * there was more than one provider have none, and a reader must not need one. It is what
	 * distinguishes a zero-cost row that was a subscription call from a zero-cost row that was
	 * a metered call which somehow cost nothing.
	 */
	provider?: ProviderId;
}

export interface SpendSummary {
	monthlyBudgetUsd: number;
	spentThisMonthUsd: number;
	remainingUsd: number;
	callsThisMonth: number;
	lifetimeUsd: number;
	entries: SpendEntry[];
}

export class BudgetExceededError extends Error {
	constructor(
		readonly spent: number,
		readonly budget: number,
		readonly wouldCost: number,
	) {
		super(
			`Anthropic monthly budget reached: ${formatUsd(spent)} of ${formatUsd(budget)} used, and this call could cost up to ${formatUsd(wouldCost)}. ` +
				`Raise ANTHROPIC_MONTHLY_BUDGET_USD to continue.`,
		);
		this.name = 'BudgetExceededError';
	}
}

export class SpendLedger {
	private entries: SpendEntry[] = [];

	constructor(
		private readonly file: string,
		readonly monthlyBudgetUsd: number,
	) {
		this.load();
	}

	/** Where the ledger is kept. Reported at startup so a misconfigured path is visible. */
	get path(): string {
		return this.file;
	}

	/**
	 * Prove the ledger can actually be written, before any money can be spent.
	 *
	 * A ledger that cannot be saved is worse than no ledger: `record()` runs *after* Anthropic
	 * has already billed the call, so a failure there loses the entry while the charge stands.
	 * Every later request then reads a ledger missing that spend and happily allows more — the
	 * ceiling silently stops being a ceiling.
	 *
	 * This is a real configuration, not a hypothetical: the container runs as `node` while the
	 * mounted data volume is owned by root, so the first paid call would have hit EACCES.
	 * Callers should run this at startup whenever an API key is present and refuse to serve if
	 * it throws.
	 */
	assertWritable(): void {
		const dir = path.dirname(this.file);
		try {
			fs.mkdirSync(dir, { recursive: true });
			const probe = path.join(dir, `.write-probe-${process.pid}`);
			fs.writeFileSync(probe, 'probe', 'utf8');
			fs.unlinkSync(probe);
		} catch (err) {
			throw new Error(
				`the spend ledger directory ${dir} is not writable (${(err as Error).message}). ` +
					`Refusing to start with an API key configured: spend is recorded after the call ` +
					`is billed, so an unwritable ledger would let the monthly ceiling be exceeded ` +
					`without trace. Fix the directory's ownership, or point ANTHROPIC_SPEND_LEDGER ` +
					`somewhere writable.`,
			);
		}
	}

	private load(): void {
		try {
			if (!fs.existsSync(this.file)) return;
			const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			if (Array.isArray(parsed)) this.entries = parsed as SpendEntry[];
		} catch {
			// A corrupt ledger must not take the server down, but it must not silently reset
			// the recorded spend either — keep the file and start a fresh in-memory list only
			// after moving the old one aside.
			const backup = `${this.file}.corrupt-${Date.now()}`;
			try {
				fs.renameSync(this.file, backup);
			} catch {
				// Nothing more to do; the guard below still applies to this process's calls.
			}
			this.entries = [];
		}
	}

	private save(): void {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2), 'utf8');
	}

	private static monthKey(iso: string): string {
		return iso.slice(0, 7); // YYYY-MM
	}

	spentThisMonth(now = new Date()): number {
		const key = SpendLedger.monthKey(now.toISOString());
		return this.entries
			.filter((e) => SpendLedger.monthKey(e.at) === key)
			.reduce((sum, e) => sum + e.costUsd, 0);
	}

	/**
	 * Throw unless this call can be afforded at its worst case.
	 *
	 * Called before the request, never after — the point is to refuse to spend, not to
	 * report having spent.
	 */
	assertCanAfford(
		model: ModelId,
		estimatedInputTokens: number,
		maxTokens: number,
		provider?: ProviderId,
	): void {
		const spent = this.spentThisMonth();
		// A subscription call has no ceiling to breach: the plan is bought, the deployment's
		// card is not touched, and refusing the work would be the budget guard protecting a
		// balance nothing is going to draw on.
		const ceiling = worstCaseCost(model, estimatedInputTokens, maxTokens, provider);
		if (spent + ceiling > this.monthlyBudgetUsd) {
			throw new BudgetExceededError(spent, this.monthlyBudgetUsd, ceiling);
		}
	}

	record(model: ModelId, purpose: string, usage: TokenUsage, provider?: ProviderId): SpendEntry {
		// Recorded at zero rather than not recorded at all: the token counts are still the
		// truthful measure of what a generation took, and a ledger that silently omitted every
		// subscription call would make "how much work has this deployment done" unanswerable.
		const cost = costOf(model, usage, provider);
		const entry: SpendEntry = {
			at: new Date().toISOString(),
			model,
			purpose,
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			cacheReadTokens: usage.cache_read_input_tokens ?? 0,
			cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
			costUsd: cost.totalUsd,
			...(provider ? { provider } : {}),
		};
		this.entries.push(entry);
		this.save();
		return entry;
	}

	summary(): SpendSummary {
		const spent = this.spentThisMonth();
		const key = SpendLedger.monthKey(new Date().toISOString());
		return {
			monthlyBudgetUsd: this.monthlyBudgetUsd,
			spentThisMonthUsd: spent,
			remainingUsd: Math.max(0, this.monthlyBudgetUsd - spent),
			callsThisMonth: this.entries.filter((e) => SpendLedger.monthKey(e.at) === key).length,
			lifetimeUsd: this.entries.reduce((sum, e) => sum + e.costUsd, 0),
			entries: this.entries,
		};
	}
}
