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
 *
 * A world is a run of such jobs, one per region, and the run has an order that only this
 * class can see: region 0 is placed by a player and reports where it landed, and every later
 * region is measured from that report. So the hub also holds the two facts that ordering
 * needs — which world a job is a region of, and where each world's first region ended up.
 * Both are deliberately in memory. A socket does not survive a restart and neither does the
 * mod's idea of what it is halfway through building; persisting a half-delivered world
 * belongs with the world rows, not here.
 */

import { AGENT_LIMITS, type AgentLimits, type BuildAnchor, type JobRegion, type ServerToAgent } from '@craftmagic/core';
import type { AgentStore, JobRow } from './store.js';

export interface Connection {
	agentId: string;
	agentName: string;
	/**
	 * What this agent said it would accept, from its own `hello.ok`.
	 *
	 * Carried on the connection rather than read from a constant, so the number that is
	 * enforced is the number that was promised to *this* socket. Raising the constant in a
	 * later release must not retroactively let the server overrun a mod still running the old
	 * one.
	 */
	limits?: AgentLimits;
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

	/**
	 * Which world region an in-flight job is, by job id.
	 *
	 * The job row itself cannot say: a region is an ordinary build as far as the database is
	 * concerned, which is exactly the property that lets the whole engine downstream of the
	 * world document stay unchanged. Keeping the mapping here also means a reconnect re-offers
	 * a region *as* a region — `attach` replays pending jobs, and replaying one of them as a
	 * lone build would centre a region of a map on whoever happened to be standing nearby.
	 */
	private readonly regionJobs = new Map<string, JobRegion>();

	/** Where region 0 of each world in flight reported that it landed. */
	private readonly worldAnchors = new Map<string, BuildAnchor>();

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
		for (const job of waiting) await this.offer(job, this.regionJobs.get(job.id));
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

	/**
	 * Push a job to its agent, if it is connected. Returns whether it went out.
	 *
	 * `region` marks the job as one tile of a world. Omitted, the job is a lone build and
	 * every line below behaves as it always has.
	 */
	async offer(job: JobRow, region?: JobRegion): Promise<boolean> {
		const connection = this.connections.get(job.agentId);
		if (!connection) return false;

		// Unscoped on purpose: the offer is sent to the agent the job already names, and the
		// caller's ownership was checked when the job was created.
		const build = await this.store.getBuildForAgent(job.buildId);
		if (!build) return this.refuse(job, 'build no longer exists');

		// The handshake promises a ceiling and until now nothing looked at it again, so a build
		// past it was queued, downloaded and only then discovered to be impossible — after the
		// player had been told it was on its way. Refusing here turns that into one sentence
		// the moment it is asked for.
		const maxVolume = (connection.limits ?? AGENT_LIMITS).maxVolume;
		if (build.blockCount > maxVolume) {
			return this.refuse(
				job,
				`"${build.name}" is ${build.blockCount} blocks and ${connection.agentName} accepts at most ${maxVolume}`,
			);
		}

		// A region after the first has to be measured from somewhere, and the only thing that
		// knows where is region 0's own report. Until that report arrives there is no honest
		// answer to "where does this go", so the job fails with the reason rather than being
		// sent to be dropped wherever a player is standing.
		let placement = region;
		if (region && region.index > 0) {
			const anchor = this.worldAnchors.get(region.worldId);
			if (!anchor) {
				return this.refuse(
					job,
					`region ${region.index + 1} of ${region.total} cannot be placed until the first region reports where it landed`,
				);
			}
			placement = { ...region, anchor };
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
			// Spread rather than `region: placement`, so an ordinary build's offer carries no
			// key at all — the same bytes a mod that predates worlds has always been sent.
			...(placement ? { region: placement } : {}),
		});

		if (placement) this.regionJobs.set(job.id, placement);

		if (job.status === 'pending') {
			await this.store.updateJob(job.id, { status: 'offered' });
			this.emit(job.id, { jobId: job.id, status: 'offered' });
		}
		return true;
	}

	/** Fail a job with a reason the website can show, rather than sending it. */
	private async refuse(job: JobRow, reason: string): Promise<false> {
		await this.store.updateJob(job.id, { status: 'failed', error: reason });
		this.emit(job.id, { jobId: job.id, status: 'failed', error: reason });
		return false;
	}

	/**
	 * Record what an agent reported about a job, for the sake of the regions still to come.
	 *
	 * Only region 0's anchor is kept. Every region reports the corner it built from, and
	 * letting a later one overwrite the world's anchor would move the origin of the map
	 * halfway through delivering it — each remaining region would then be offset from the last
	 * one placed instead of from the first, so the world would walk away across the map.
	 */
	noteJobState(jobId: string, state: string, anchor?: BuildAnchor): void {
		const region = this.regionJobs.get(jobId);
		if (!region) return;

		if (region.index === 0 && anchor) this.worldAnchors.set(region.worldId, anchor);

		if (state === 'done' || state === 'cancelled' || state === 'failed') {
			this.regionJobs.delete(jobId);
			// The run is over once its last region is; nothing after it needs the anchor.
			if (region.index === region.total - 1) this.worldAnchors.delete(region.worldId);
		}
	}

	/** Where region 0 of a world landed, once it has said. Undefined until then. */
	worldAnchor(worldId: string): BuildAnchor | undefined {
		return this.worldAnchors.get(worldId);
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
