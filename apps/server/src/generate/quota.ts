/**
 * Per-user generation quota, and the `generations` audit rows.
 *
 * Two different jobs, one table, so they live together.
 *
 * The quota is **fairness, not a money stop**. `SpendLedger` is the hard ceiling and stays
 * exactly where it is: it is sized on what a call *could* cost at `max_tokens` and it runs
 * before every request. This only stops one account from consuming the whole month's balance
 * before anyone else gets a turn.
 *
 * Losing the database does not quietly disable the quota — it disables *generation*. An
 * unmeterable generation endpoint on a public port is how a fixed balance disappears, so the
 * route refuses rather than falls back. `user_id` is not nullable on this path for the same
 * reason: a row with no owner is a call nothing can be charged for.
 *
 * "Daily" is a rolling 24 hours rather than a calendar day. A calendar day has to pick a
 * timezone, and whichever one is picked is wrong for someone; a rolling window also spreads
 * the reset out instead of releasing every account at the same instant.
 */

import type { Db } from '../db/pool.js';

export interface QuotaVerdict {
	allowed: boolean;
	used: number;
	quota: number;
}

export type GenerationStatus =
	| 'queued'
	| 'streaming'
	| 'validating'
	| 'repairing'
	| 'succeeded'
	| 'succeeded_with_omissions'
	| 'failed';

export class GenerationQuota {
	constructor(private readonly db: Db) {}

	/**
	 * Generations started by this user in the last 24 hours.
	 *
	 * Counts *started*, not succeeded. Charging only for successes would make a prompt that
	 * reliably fails validation a free, unbounded way to spend the shared balance.
	 */
	async usedToday(userId: string): Promise<number> {
		const { rows } = await this.db.query<{ count: string }>(
			`SELECT count(*) FROM generations
			 WHERE user_id = $1 AND created_at > now() - interval '24 hours'`,
			[userId],
		);
		return Number.parseInt(rows[0]?.count ?? '0', 10);
	}

	async check(userId: string, quota: number): Promise<QuotaVerdict> {
		const used = await this.usedToday(userId);
		return { allowed: used < quota, used, quota };
	}

	/** Written before the model is called, so an abandoned or crashed run still counts. */
	async start(userId: string, prompt: string, model: string): Promise<string> {
		const { rows } = await this.db.query<{ id: string }>(
			`INSERT INTO generations (user_id, prompt, status, model)
			 VALUES ($1, $2, 'queued', $3)
			 RETURNING id`,
			[userId, prompt, model],
		);
		return rows[0]!.id;
	}

	async finish(
		id: string,
		result: {
			status: GenerationStatus;
			inputTokens?: number;
			outputTokens?: number;
			costUsd?: number;
			program?: unknown;
			error?: unknown;
		},
	): Promise<void> {
		await this.db.query(
			`UPDATE generations
			 SET status        = $2,
			     input_tokens  = $3,
			     output_tokens = $4,
			     cost_usd      = $5,
			     program       = $6,
			     error         = $7,
			     finished_at   = now()
			 WHERE id = $1`,
			[
				id,
				result.status,
				result.inputTokens ?? null,
				result.outputTokens ?? null,
				result.costUsd ?? null,
				result.program === undefined ? null : JSON.stringify(result.program),
				result.error === undefined ? null : JSON.stringify(result.error),
			],
		);
	}
}
