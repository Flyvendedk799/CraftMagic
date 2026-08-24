/**
 * The per-user generation quota, and the two ways it must never be skipped.
 *
 * No test here reaches Anthropic. Every case either has no API key configured, or exhausts the
 * quota first — the refusals all happen before a client call, which is the property being
 * checked as much as it is a way to keep the suite free.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, closeTestDb, openTestDb, type TestApp } from '../testing/harness.js';
import { GenerationQuota } from './quota.js';

const db = await openTestDb();
const withDb = db ? describe : describe.skip;

let harness: TestApp;

beforeAll(async () => {
	if (!db) return;
	// A key that is never used: the routes construct a client from it, and every request below
	// is refused before that client is touched. Without one they would 503 on `no_api_key` and
	// prove nothing about the quota.
	harness = await buildTestApp(db, { apiKey: 'sk-ant-not-a-real-key' });
});

afterAll(async () => {
	if (!db) return;
	await harness?.app.close();
	await closeTestDb();
});

/** An account whose allowance is already spent, without spending anything. */
async function userAtLimit(label: string, quota: number): Promise<string> {
	const user = await harness.signUp(label);
	await db!.query('UPDATE users SET daily_gen_quota = $2 WHERE id = $1', [user.id, quota]);
	return user.cookie;
}

withDb('GenerationQuota', () => {
	it('counts a user\'s generations in the last 24 hours', async () => {
		const quota = new GenerationQuota(db!);
		const user = await harness.signUp('quota-count');

		expect(await quota.usedToday(user.id)).toBe(0);

		await quota.start(user.id, 'a small stone windmill', 'claude-sonnet-5');
		await quota.start(user.id, 'a fishing hut on stilts', 'claude-sonnet-5');
		expect(await quota.usedToday(user.id)).toBe(2);
	});

	it('ignores generations older than the window', async () => {
		const quota = new GenerationQuota(db!);
		const user = await harness.signUp('quota-window');

		await db!.query(
			`INSERT INTO generations (user_id, prompt, status, created_at)
			 VALUES ($1, 'yesterday', 'succeeded', now() - interval '25 hours')`,
			[user.id],
		);
		expect(await quota.usedToday(user.id)).toBe(0);
	});

	it('counts started, not succeeded', async () => {
		// Otherwise a prompt that reliably fails validation is a free, unbounded way to spend
		// the shared balance.
		const quota = new GenerationQuota(db!);
		const user = await harness.signUp('quota-failed');

		const id = await quota.start(user.id, 'something that will fail', 'claude-sonnet-5');
		await quota.finish(id, { status: 'failed', error: { message: 'expansion failed' } });

		expect(await quota.usedToday(user.id)).toBe(1);
	});

	it('allows up to the limit and refuses past it', async () => {
		const quota = new GenerationQuota(db!);
		const user = await harness.signUp('quota-limit');

		expect(await quota.check(user.id, 2)).toEqual({ allowed: true, used: 0, quota: 2 });
		await quota.start(user.id, 'one', 'claude-sonnet-5');
		expect((await quota.check(user.id, 2)).allowed).toBe(true);
		await quota.start(user.id, 'two', 'claude-sonnet-5');
		expect(await quota.check(user.id, 2)).toEqual({ allowed: false, used: 2, quota: 2 });
	});

	it('records the tokens and cost of a finished generation', async () => {
		const quota = new GenerationQuota(db!);
		const user = await harness.signUp('quota-record');

		const id = await quota.start(user.id, 'a round stone watchtower', 'claude-sonnet-5');
		await quota.finish(id, {
			status: 'succeeded',
			inputTokens: 9_700,
			outputTokens: 4_200,
			costUsd: 0.0912,
			program: { version: 1 },
		});

		const { rows } = await db!.query(
			'SELECT status, model, input_tokens, output_tokens, cost_usd, program, finished_at FROM generations WHERE id = $1',
			[id],
		);
		const row = rows[0]!;
		expect(row.status).toBe('succeeded');
		expect(row.model).toBe('claude-sonnet-5');
		expect(row.input_tokens).toBe(9_700);
		expect(row.output_tokens).toBe(4_200);
		expect(Number(row.cost_usd)).toBeCloseTo(0.0912, 6);
		expect(row.program).toEqual({ version: 1 });
		expect(row.finished_at).not.toBeNull();
	});

	it('does not count one user\'s generations against another', async () => {
		const quota = new GenerationQuota(db!);
		const [mine, theirs] = await Promise.all([harness.signUp('quota-a'), harness.signUp('quota-b')]);

		await quota.start(mine.id, 'mine', 'claude-sonnet-5');
		expect(await quota.usedToday(theirs.id)).toBe(0);
	});
});

withDb('POST /api/generations', () => {
	it('refuses a signed-out caller', async () => {
		// An anonymous caller has no identity to meter, so one loop would drain the balance.
		const anonymous = await harness.call('POST', '/api/generations', { body: { prompt: 'a stone hut' } });
		expect(anonymous.status).toBe(401);
	});

	it('refuses a signed-out caller on the free estimate too', async () => {
		// Free to the caller, but it still reaches Anthropic and shares a rate limit with the
		// paid path.
		const anonymous = await harness.call('POST', '/api/generations/estimate', {
			body: { prompt: 'a stone hut' },
		});
		expect(anonymous.status).toBe(401);
	});

	it('refuses past the quota, with 429 and the numbers', async () => {
		const cookie = await userAtLimit('quota-route', 0);

		const refused = await harness.call('POST', '/api/generations', {
			cookie,
			body: { prompt: 'a small stone windmill with a wooden roof' },
		});

		expect(refused.status).toBe(429);
		expect(refused.body.error).toBe('quota_exceeded');
		expect(refused.body.quota).toBe(0);
		expect(refused.body.used).toBe(0);
	});

	it('writes no generation row for a refused request', async () => {
		const user = await harness.signUp('quota-norow');
		await db!.query('UPDATE users SET daily_gen_quota = 0 WHERE id = $1', [user.id]);

		await harness.call('POST', '/api/generations', { cookie: user.cookie, body: { prompt: 'a hut' } });

		const { rowCount } = await db!.query('SELECT 1 FROM generations WHERE user_id = $1', [user.id]);
		expect(rowCount).toBe(0);
	});

	it('reports the remaining allowance on /api/me', async () => {
		const quota = new GenerationQuota(db!);
		const user = await harness.signUp('quota-me');
		await quota.start(user.id, 'one', 'claude-sonnet-5');

		const me = await harness.call('GET', '/api/me', { cookie: user.cookie });
		const account = me.body.user as { dailyGenQuota: number; generationsUsedToday: number; generationsLeftToday: number };
		expect(account.dailyGenQuota).toBe(30);
		expect(account.generationsUsedToday).toBe(1);
		expect(account.generationsLeftToday).toBe(29);
	});
});

withDb('generation without an API key', () => {
	it('answers 503 rather than failing to start', async () => {
		// Production deliberately runs with no key, so an unauthenticated port cannot spend
		// money. That must be a working server with one feature off, not a crash — and the key
		// check comes first, so it is the answer even for a signed-out caller.
		const keyless = await buildTestApp(db!, { apiKey: undefined });
		try {
			const user = await keyless.signUp('nokey');

			for (const url of ['/api/generations', '/api/generations/estimate']) {
				const response = await keyless.call('POST', url, { cookie: user.cookie, body: { prompt: 'a hut' } });
				expect(response.status).toBe(503);
				expect(response.body.error).toBe('no_api_key');
			}

			// The rest of the server is unaffected.
			expect((await keyless.call('GET', '/api/me', { cookie: user.cookie })).status).toBe(200);
			expect((await keyless.call('GET', '/api/spend')).status).toBe(200);
		} finally {
			await keyless.app.close();
		}
	});
});

withDb('generation without a database', () => {
	it('refuses rather than running unmetered', async () => {
		// The quota is the only per-user limit, so a server that cannot enforce it must not
		// generate at all — an unmeterable endpoint on a public port is how a fixed balance
		// disappears.
		const unmeterable = await buildTestApp(db!, { apiKey: 'sk-ant-not-a-real-key', quota: null });
		try {
			const response = await unmeterable.call('POST', '/api/generations', { body: { prompt: 'a hut' } });
			expect(response.status).toBe(503);
			expect(response.body.error).toBe('no_database');
		} finally {
			await unmeterable.app.close();
		}
	});
});
