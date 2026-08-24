/**
 * Live agent connections and job dispatch.
 *
 * The database is the record of what a job *is*; this is the record of who is reachable
 * right now. Keeping them separate matters: a job survives a restart, a socket does not, and
 * conflating the two is how you end up unable to explain why a build never arrived.
 *
 * On connect, an agent is handed any job that was queued while it was away — the site can
 * queue a build for a world that is currently offline, and it lands when the player next
 * starts the game.
 */

import type { ServerToAgent } from '@imaginecraft/core';
import type { AgentStore, JobRow } from './store.js';

export interface Connection {
	agentId: string;
	agentName: string;
	send: (message: ServerToAgent) => void;
	close: () => void;
}

type JobListener = (event: JobEvent) => void;

export interface JobEvent {
	jobId: string;
	status: string;
	placed?: number;
	total?: number;
	anchor?: unknown;
	error?: string | null;
}

export class AgentHub {
	/** One connection per agent; a reconnect replaces the old socket. */
	private readonly connections = new Map<string, Connection>();
	private readonly jobListeners = new Map<string, Set<JobListener>>();

	constructor(private readonly store: AgentStore) {}

	async attach(connection: Connection): Promise<void> {
		// A second connection for the same agent means the old one is stale — a mod that
		// reconnected after a network blip, or a world reopened. Drop the old socket rather
		// than fanning a job out to both.
		const existing = this.connections.get(connection.agentId);
		if (existing && existing !== connection) existing.close();

		this.connections.set(connection.agentId, connection);

		// Deliver anything queued while this agent was offline.
		const waiting = await this.store.pendingJobsFor(connection.agentId);
		for (const job of waiting) await this.offer(job);
	}

	detach(agentId: string, connection: Connection): void {
		// Only clear if this exact socket is still the registered one, or a slow close from a
		// replaced socket would evict its replacement.
		if (this.connections.get(agentId) === connection) this.connections.delete(agentId);
	}

	isOnline(agentId: string): boolean {
		return this.connections.has(agentId);
	}

	onlineAgentIds(): string[] {
		return [...this.connections.keys()];
	}

	/** Push a job to its agent, if it is connected. Returns whether it went out. */
	async offer(job: JobRow): Promise<boolean> {
		const connection = this.connections.get(job.agentId);
		if (!connection) return false;

		// Unscoped on purpose: the offer is sent to the agent the job already names, and the
		// caller's ownership was checked when the job was created.
		const build = await this.store.getBuildForAgent(job.buildId);
		if (!build) {
			await this.store.updateJob(job.id, { status: 'failed', error: 'build no longer exists' });
			this.emit(job.id, { jobId: job.id, status: 'failed', error: 'build no longer exists' });
			return false;
		}

		connection.send({
			t: 'job.offer',
			jobId: job.id,
			buildId: build.id,
			name: build.name,
			size: { x: build.sizeX, y: build.sizeY, z: build.sizeZ },
			blockCount: build.blockCount,
			// Relative: the mod resolves it against its own configured origin, so the same
			// job works whether it reached us through a tunnel, a domain or a raw IP.
			dataUrl: `/api/agent/jobs/${job.id}/schem`,
		});

		if (job.status === 'pending') {
			await this.store.updateJob(job.id, { status: 'offered' });
			this.emit(job.id, { jobId: job.id, status: 'offered' });
		}
		return true;
	}

	cancel(job: JobRow): void {
		this.connections.get(job.agentId)?.send({ t: 'job.cancel', jobId: job.id });
	}

	revoke(agentId: string): void {
		const connection = this.connections.get(agentId);
		if (!connection) return;
		connection.send({ t: 'session.revoked' });
		connection.close();
	}

	// --- job progress fan-out to the website -----------------------------

	subscribe(jobId: string, listener: JobListener): () => void {
		if (!this.jobListeners.has(jobId)) this.jobListeners.set(jobId, new Set());
		this.jobListeners.get(jobId)!.add(listener);
		return () => {
			const set = this.jobListeners.get(jobId);
			set?.delete(listener);
			if (set && set.size === 0) this.jobListeners.delete(jobId);
		};
	}

	emit(jobId: string, event: JobEvent): void {
		for (const listener of this.jobListeners.get(jobId) ?? []) {
			try {
				listener(event);
			} catch {
				// One broken browser stream must not stop the others.
			}
		}
	}
}
