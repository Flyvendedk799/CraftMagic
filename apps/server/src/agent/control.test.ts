/**
 * The website's controls over a job — pause, resume, undo, cancel — and the moves they may make.
 *
 * Each control is a move between statuses, and the first version of these routes wrote their
 * status whatever the job was doing. The cases that went wrong are the ones pinned here:
 *
 * - pausing a finished build marked it `paused` for good;
 * - pausing a build still queued for an offline world took it out of the set that is replayed
 *   when the world connects, so it never arrived;
 * - undo did not move the job at all, so the progress stream the website opened for the undo
 *   replayed the stored `done` and closed before the first block came back out.
 *
 * And the stale-job cutoff, which a paused build has to survive while its world is connected.
 *
 * Driven through `app.inject()` like the rest. "Connected" is a fake connection attached to the
 * app's own hub, which records what would have gone down the socket.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expand, samples, type ServerToAgent } from '@craftmagic/core';
import { buildTestApp, closeTestDb, openTestDb, type TestApp } from '../testing/harness.js';
import { JOB_CONTROLS } from './routes.js';

const db = await openTestDb();
const withDb = db ? describe : describe.skip;

let harness: TestApp;
let user: { cookie: string; id: string; email: string };
let stranger: { cookie: string; id: string; email: string };

const { grid } = expand(samples.cottage!);
const gridBody = { size: grid.size, palette: grid.palette, voxels: Array.from(grid.voxels) };

beforeAll(async () => {
	if (!db) return;
	harness = await buildTestApp(db);
	user = await harness.signUp('control');
	stranger = await harness.signUp('control-stranger');
});

afterAll(async () => {
	if (!db) return;
	await harness?.app.close();
	await closeTestDb();
});

interface Sent {
	agentId: string;
	jobId: string;
	messages: ServerToAgent[];
}

/**
 * A job in a given status, on a freshly paired world of its own.
 *
 * A world of its own because an agent takes one job at a time, and every case here wants one.
 * The status is written straight to the row: getting a job to `paused` honestly takes a mod,
 * and what is under test is what the routes do from each status, not how it got there.
 */
async function jobIn(status: string, options: { online: boolean }): Promise<Sent> {
	const minted = await harness.call('POST', '/api/agent/pair-codes', { cookie: user.cookie });
	const claimed = await harness.call('POST', '/api/agent/claim', {
		body: { code: minted.body.code, mcVersion: '26.2', modVersion: 'vitest', envType: 'integrated' },
	});
	const agentId = claimed.body.agentId as string;

	const messages: ServerToAgent[] = [];
	if (options.online) {
		await harness.hub.attach({
			agentId,
			agentName: 'Test World',
			send: (message) => messages.push(message),
			close: () => undefined,
		});
	}

	const saved = await harness.call('POST', '/api/builds', {
		cookie: user.cookie,
		body: { name: `Control ${status}`, program: samples.cottage, grid: gridBody },
	});
	const queued = await harness.call('POST', '/api/agent/jobs', {
		cookie: user.cookie,
		body: { agentId, buildId: saved.body.id },
	});
	expect(queued.status).toBe(202);
	const jobId = queued.body.id as string;

	await harness.db.query('UPDATE agent_jobs SET status = $2, progress_placed = 40, progress_total = 40 WHERE id = $1', [
		jobId,
		status,
	]);
	messages.length = 0; // the offer, if it went out, is not what these tests are about
	return { agentId, jobId, messages };
}

async function statusOf(jobId: string): Promise<string> {
	const read = await harness.call('GET', `/api/agent/jobs/${jobId}`, { cookie: user.cookie });
	return read.body.status as string;
}

async function control(action: string, jobId: string, cookie = user.cookie) {
	return harness.call('POST', `/api/agent/jobs/${jobId}/${action}`, { cookie });
}

const ALL_STATUSES = [
	'pending',
	'offered',
	'previewing',
	'building',
	'paused',
	'undoing',
	'done',
	'undone',
	'cancelled',
	'failed',
];

withDb('job controls move only between the statuses they make sense from', () => {
	for (const [action, rule] of Object.entries(JOB_CONTROLS)) {
		for (const from of ALL_STATUSES) {
			const allowed = (rule.from as readonly string[]).includes(from);
			it(`${action} from ${from} is ${allowed ? `allowed, to ${rule.to}` : 'refused'}`, async () => {
				const job = await jobIn(from, { online: true });
				const response = await control(action, job.jobId);

				if (allowed) {
					expect(response.status).toBe(200);
					expect(response.body.status).toBe(rule.to);
					expect(await statusOf(job.jobId)).toBe(rule.to);
					// And the mod was told, in its own words.
					expect(job.messages).toContainEqual({ t: `job.${action}`, jobId: job.jobId });
				} else {
					expect(response.status).toBe(409);
					expect(response.body.error).toBe('invalid_state');
					expect(response.body.status).toBe(from);
					expect(await statusOf(job.jobId)).toBe(from);
					expect(job.messages).toEqual([]);
				}
			});
		}
	}

	it('pins the table itself', () => {
		// A change to who may do what is a product decision, and should have to change this line.
		expect(JOB_CONTROLS.pause.from).toEqual(['building']);
		expect(JOB_CONTROLS.resume.from).toEqual(['paused']);
		expect(JOB_CONTROLS.undo.from).toEqual(['done']);
		expect([...JOB_CONTROLS.cancel.from].sort()).toEqual(
			['building', 'offered', 'paused', 'pending', 'previewing', 'undoing'].sort(),
		);
	});
});

withDb('controls that need the mod refuse while the world is offline', () => {
	for (const [action, from] of [
		['pause', 'building'],
		['resume', 'paused'],
		['undo', 'done'],
	] as const) {
		it(`${action} answers agent_offline and leaves the job ${from}`, async () => {
			const job = await jobIn(from, { online: false });
			const response = await control(action, job.jobId);
			expect(response.status).toBe(409);
			expect(response.body.error).toBe('agent_offline');
			expect(await statusOf(job.jobId)).toBe(from);
		});
	}

	it('never takes a job queued for an offline world out of the replay set', async () => {
		const job = await jobIn('pending', { online: false });
		expect((await control('pause', job.jobId)).status).toBe(409);
		expect(await statusOf(job.jobId)).toBe('pending');

		const replayed = await harness.store.pendingJobsFor(job.agentId);
		expect(replayed.map((j) => j.id)).toContain(job.jobId);
	});

	it('still cancels a job queued for an offline world — the row is all there is to stop', async () => {
		const job = await jobIn('pending', { online: false });
		const response = await control('cancel', job.jobId);
		expect(response.status).toBe(200);
		expect(await statusOf(job.jobId)).toBe('cancelled');
		expect(await harness.store.pendingJobsFor(job.agentId)).toEqual([]);
	});
});

withDb('undo is a state the progress stream can see', () => {
	it('moves done to undoing, so a stream opened for the undo does not replay done', async () => {
		const job = await jobIn('done', { online: true });
		expect((await control('undo', job.jobId)).status).toBe(200);

		// The replay the events route sends first is the row's status.
		const row = await harness.store.getJob(job.jobId, user.id);
		expect(row?.status).toBe('undoing');
		// The counts are left alone: the mod reports them falling from here.
		expect(row?.progressPlaced).toBe(40);
	});

	it("clears a previous undo's refusal when undo is asked again", async () => {
		const job = await jobIn('done', { online: true });
		await harness.db.query("UPDATE agent_jobs SET error = 'could not undo: nope' WHERE id = $1", [job.jobId]);
		expect((await control('undo', job.jobId)).status).toBe(200);
		expect((await harness.store.getJob(job.jobId, user.id))?.error).toBeNull();
	});
});

withDb("controls on someone else's job", () => {
	for (const action of Object.keys(JOB_CONTROLS)) {
		it(`${action} is a 404 and moves nothing`, async () => {
			const job = await jobIn(action === 'resume' ? 'paused' : action === 'undo' ? 'done' : 'building', {
				online: true,
			});
			const before = await statusOf(job.jobId);
			const response = await control(action, job.jobId, stranger.cookie);
			expect(response.status).toBe(404);
			expect(await statusOf(job.jobId)).toBe(before);
			expect(job.messages).toEqual([]);
		});
	}
});

withDb('the stale-job cutoff', () => {
	async function age(jobId: string, minutes: number): Promise<void> {
		await harness.db.query(
			`UPDATE agent_jobs SET updated_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
			[jobId, String(minutes)],
		);
	}

	it('keeps a paused job that the mod is still reporting on — the keepalive refreshes it', async () => {
		const job = await jobIn('paused', { online: true });
		await age(job.jobId, 4);
		// What the mod's 30-second keepalive does to the row: same status, same counts, fresh time.
		await harness.store.updateJob(job.jobId, { status: 'paused', placed: 40, total: 40 });

		expect((await harness.store.activeJob(job.agentId))?.id).toBe(job.jobId);
		expect(await harness.store.reapStaleJobs(job.agentId)).toBe(0);
		expect(await statusOf(job.jobId)).toBe('paused');
	});

	it('reaps a paused job nobody has heard from in over five minutes, as it would a building one', async () => {
		const job = await jobIn('paused', { online: true });
		await age(job.jobId, 6);

		expect(await harness.store.activeJob(job.agentId)).toBeNull();
		expect(await harness.store.reapStaleJobs(job.agentId)).toBe(1);
		expect(await statusOf(job.jobId)).toBe('failed');
	});

	it('counts an undo in progress as occupying the world', async () => {
		const job = await jobIn('undoing', { online: true });
		expect((await harness.store.activeJob(job.agentId))?.id).toBe(job.jobId);
	});

	it('does not count a finished undo', async () => {
		const job = await jobIn('undone', { online: true });
		expect(await harness.store.activeJob(job.agentId)).toBeNull();
	});
});
