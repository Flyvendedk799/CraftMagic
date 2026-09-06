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
 *
 * Both used to be *only* in memory, on the reasoning that a socket does not survive a restart
 * and neither does the mod's idea of what it is halfway through. That was half right. The mod
 * does forget — but the rows do not, and a server restarted between region 3 and region 4 of
 * a sixteen-region map had every fact it needed in the database and refused the remaining
 * twelve with "region 0 has not reported where it landed". Since migration 009 the region
 * rides on the job row and the anchor was always on it, so what this class keeps in memory is
 * now a cache in front of `store.worldAnchor`, not the only copy.
 */

import {
	AGENT_LIMITS,
	deliveryOffset,
	type AgentLimits,
	type BuildAnchor,
	type JobRegion,
	type ServerToAgent,
} from '@craftmagic/core';
import type { AgentStore, JobRow, WorldAnchorRecord } from './store.js';

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

/**
 * What happened to an offer.
 *
 * `offer` used to return a bare boolean, and the two falses meant opposite things: an agent
 * that is merely offline leaves the job pending to land when the player next starts the
 * game, while a refusal has already failed the job. The route could not tell them apart, so
 * it answered 202 either way and the website printed "queued" over a row that was already
 * dead — the one outcome the user most needed to hear about was the one that looked normal.
 */
export type OfferResult =
  | { kind: 'delivered' }
  | { kind: 'offline' }
  | { kind: 'refused'; reason: string };

export interface JobEvent {
	jobId: string;
	status: string;
	placed?: number;
	total?: number;
	anchor?: unknown;
	error?: string | null;
}

/** A region job in flight, with the footprint of the build it carries. */
interface RegionJob {
	region: JobRegion;
	footprint: { x: number; z: number };
}

export class AgentHub {
	/** One connection per agent; a reconnect replaces the old socket. */
	private readonly connections = new Map<string, Connection>();
	private readonly jobListeners = new Map<string, Set<JobListener>>();

	/**
	 * Which world region an in-flight job is, by job id, with its build's footprint.
	 *
	 * A cache: the row carries the region too (`JobRow.region`), and `attach` and
	 * `noteJobState` both fall back to it. What the cache adds is the footprint, which is
	 * read off the build at offer time and is what region 0's anchor record needs.
	 */
	private readonly regionJobs = new Map<string, RegionJob>();

	/**
	 * Where region 0 of each world in flight reported that it landed.
	 *
	 * Written the moment the mod's first progress frame arrives, so a region 1 sent a
	 * millisecond later does not have to wait for the row. Read before the store, and filled
	 * from the store on a miss — see `anchorFor`.
	 */
	private readonly worldAnchors = new Map<string, WorldAnchorRecord>();

	constructor(private readonly store: AgentStore) {}

	async attach(connection: Connection): Promise<void> {
		// A second connection for the same agent means the old one is stale — a mod that
		// reconnected after a network blip, or a world reopened. Drop the old socket rather
		// than fanning a job out to both.
		const existing = this.connections.get(connection.agentId);
		if (existing && existing !== connection) existing.close();

		this.connections.set(connection.agentId, connection);

		// Close the books on anything that was mid-build when the socket went. The mod has just
		// reconnected and told us what it is actually doing, so a row still claiming to be
		// building is describing a build that stopped happening — and it would otherwise sit
		// there forever, since nothing else ever moved a job out of an active status.
		await this.store.reapStaleJobs(connection.agentId);

		// Deliver anything queued while this agent was offline. The row's region wins over the
		// cache: after a restart the cache is empty and the row is the only thing left that
		// knows a pending job is square nine of a map rather than a house.
		const waiting = await this.store.pendingJobsFor(connection.agentId);
		for (const job of waiting) {
			await this.offer(job, job.region ?? this.regionJobs.get(job.id)?.region);
		}
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
	 * `region` marks the job as one tile of a world; omitted, the job's own row is consulted,
	 * and a job with neither is a lone build and every line below behaves as it always has.
	 */
	async offer(job: JobRow, regionArg?: JobRegion): Promise<OfferResult> {
		const connection = this.connections.get(job.agentId);
		if (!connection) return { kind: 'offline' };

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

		const region = regionArg ?? job.region ?? undefined;
		const footprint = { x: build.sizeX, z: build.sizeZ };

		// A region after the first has to be measured from somewhere, and the only thing that
		// knows where is region 0's own report. Until that report arrives there is no honest
		// answer to "where does this go", so the job fails with the reason rather than being
		// sent to be dropped wherever a player is standing.
		let placement = region;
		if (region && region.index > 0) {
			const record = await this.anchorFor(region.worldId);
			if (!record) {
				return this.refuse(
					job,
					`region ${region.index + 1} of ${region.total} cannot be placed until the first region reports where it landed`,
				);
			}
			// The offset the mod adds is pre-corrected for a truncated edge region under a
			// quarter turn — see `deliveryOffset`. A full region, or an unrotated map, gets the
			// offset back untouched, so the wire is unchanged for the common case.
			const offset = record.footprint
				? deliveryOffset(region.offset, record.anchor.rotation, record.footprint, footprint)
				: region.offset;
			placement = { ...region, offset, anchor: record.anchor };
		} else if (region) {
			// A fresh region 0 is a fresh run. Whatever an earlier run of the same map reported
			// must not be inherited by this one's later regions while this region 0 has not yet
			// said where *it* landed.
			this.worldAnchors.delete(region.worldId);
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

		// The uncorrected region is what is cached: a reconnect replays it through this same
		// method, which corrects it again against whatever region 0 reported.
		if (region) this.regionJobs.set(job.id, { region, footprint });

		if (job.status === 'pending') {
			await this.store.updateJob(job.id, { status: 'offered' });
			this.emit(job.id, { jobId: job.id, status: 'offered' });
		}
		return { kind: 'delivered' };
	}

	/** Fail a job with a reason the website can show, rather than sending it. */
	private async refuse(job: JobRow, reason: string): Promise<OfferResult> {
		await this.store.updateJob(job.id, { status: 'failed', error: reason });
		this.emit(job.id, { jobId: job.id, status: 'failed', error: reason });
		return { kind: 'refused', reason };
	}

	/**
	 * Region 0's report for a world: the cache, then the rows.
	 *
	 * The store answers from the latest region 0 job of that world, which is what makes a
	 * restart survivable and a second run of the same map independent of the first. A store
	 * without the method — the hand-written one in the tests — simply has no rows to ask.
	 */
	private async anchorFor(worldId: string): Promise<WorldAnchorRecord | undefined> {
		const cached = this.worldAnchors.get(worldId);
		if (cached) return cached;
		const stored = await this.store.worldAnchor?.(worldId);
		if (stored) this.worldAnchors.set(worldId, stored);
		return stored ?? undefined;
	}

	/**
	 * Record what an agent reported about a job, for the sake of the regions still to come.
	 *
	 * Only region 0's anchor is kept. Every region reports the corner it built from, and
	 * letting a later one overwrite the world's anchor would move the origin of the map
	 * halfway through delivering it — each remaining region would then be offset from the last
	 * one placed instead of from the first, so the world would walk away across the map.
	 *
	 * `regionHint` is the job row's own region, for the frame that arrives after a restart
	 * has emptied the cache. The row cannot carry the footprint, so an anchor learned that
	 * way is stored without one and `anchorFor` goes to the store, which joins the build.
	 */
	noteJobState(jobId: string, state: string, anchor?: BuildAnchor, regionHint?: JobRegion | null): void {
		const cached = this.regionJobs.get(jobId);
		const region = cached?.region ?? regionHint ?? undefined;
		if (!region) return;

		if (region.index === 0 && anchor) {
			this.worldAnchors.set(region.worldId, { anchor, footprint: cached?.footprint ?? null });
		}

		if (state === 'done' || state === 'cancelled' || state === 'failed') {
			this.regionJobs.delete(jobId);
			// The run is over once its last region is; nothing after it needs the anchor.
			if (region.index === region.total - 1) this.worldAnchors.delete(region.worldId);
		}
	}

	/** Where region 0 of a world landed, once it has said. Undefined until then. */
	worldAnchor(worldId: string): BuildAnchor | undefined {
		return this.worldAnchors.get(worldId)?.anchor;
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
