/**
 * The promises the hub is expected to keep before an offer leaves the building.
 *
 * The first is the block ceiling. It has been in every `hello.ok` since the socket existed and
 * was checked in exactly no places, so a build past it was queued, told to the player as on its
 * way, downloaded over the wire and only then discovered to be more than the mod would take.
 * A promise nothing enforces is not a limit, it is a comment.
 *
 * The second is the order a world arrives in. A world is a run of ordinary builds, one region
 * each, and every region after the first is placed relative to where the first one landed. That
 * anchor comes back from the game, so there is a window — between offering region 0 and hearing
 * about it — in which region 1 has nowhere to go. Offering it anyway does not fail loudly: the
 * mod centres it on whoever is standing nearby, which is precisely the "every region lands on
 * top of the last" bug this whole tier had to be built around.
 *
 * The third is that the order survives the process. The anchor and the region both live on the
 * job rows now, and a hub that has just started has to find them there rather than refusing
 * the rest of a map it has every fact about.
 *
 * Driven against a hand-written store rather than the database, because none of these are
 * about SQL. All are about what the hub does in the seconds before it calls `send`.
 */

import { describe, expect, it } from 'vitest';
import { AGENT_LIMITS, deliveryOffset, type JobRegion, type ServerToAgent } from '@craftmagic/core';
import { AgentHub, type Connection } from './hub.js';
import type { AgentStore, JobRow, WorldAnchorRecord } from './store.js';

const AGENT = 'agent-1';

function job(id: string, buildId: string, region: JobRegion | null = null): JobRow {
	return {
		id,
		agentId: AGENT,
		buildId,
		status: 'pending',
		progressPlaced: 0,
		progressTotal: 0,
		anchor: null,
		error: null,
		region,
	};
}

type FakeBuild = number | { blockCount: number; sizeX: number; sizeZ: number };

/**
 * A store that answers the questions the hub asks it and records the answers it is given.
 *
 * `failures` is the interesting one: a refused offer is not a silent no-op, it is a job the
 * website has to be able to show a reason for. `anchors` is what a restarted hub finds in the
 * rows.
 */
function fakeStore(
	builds: Record<string, FakeBuild>,
	pending: JobRow[] = [],
	anchors: Record<string, WorldAnchorRecord> = {},
) {
	const failures = new Map<string, string | null>();
	let reaped = 0;
	let anchorLookups = 0;
	const store = {
		async getBuildForAgent(id: string) {
			if (!(id in builds)) return null;
			const build = builds[id]!;
			const shape = typeof build === 'number' ? { blockCount: build, sizeX: 16, sizeZ: 16 } : build;
			return { id, name: `Build ${id}`, sizeX: shape.sizeX, sizeY: 16, sizeZ: shape.sizeZ, blockCount: shape.blockCount };
		},
		async updateJob(id: string, patch: { status?: string; error?: string | null }) {
			if (patch.status === 'failed') failures.set(id, patch.error ?? null);
			return null;
		},
		async pendingJobsFor() {
			return pending;
		},
		// A reconnect closes the books on anything that went quiet mid-build. Counted rather than
		// stubbed away, so a test can assert the hub actually asks.
		async reapStaleJobs() {
			reaped++;
			return 0;
		},
		async worldAnchor(worldId: string) {
			anchorLookups++;
			return anchors[worldId] ?? null;
		},
	} as unknown as AgentStore;

	return { store, failures, reaped: () => reaped, anchorLookups: () => anchorLookups };
}

function fakeConnection(maxVolume = AGENT_LIMITS.maxVolume) {
	const sent: ServerToAgent[] = [];
	const connection: Connection = {
		agentId: AGENT,
		agentName: 'Minecraft world',
		limits: { maxVolume },
		send: (message) => void sent.push(message),
		close: () => undefined,
	};
	return { connection, sent };
}

function offers(sent: ServerToAgent[]) {
	return sent.filter((message): message is Extract<ServerToAgent, { t: 'job.offer' }> => message.t === 'job.offer');
}

const REGION_SIZE = 128;

function region(index: number, rx: number, rz: number, total = 4): JobRegion {
	return {
		worldId: 'world-1',
		index,
		total,
		rx,
		rz,
		offset: { x: rx * REGION_SIZE, y: 0, z: rz * REGION_SIZE },
	};
}

describe('the announced block ceiling is enforced, not just announced', () => {
	it('refuses a build past it with a reason, and sends nothing', async () => {
		const { store, failures } = fakeStore({ 'build-big': AGENT_LIMITS.maxVolume + 1 });
		const hub = new AgentHub(store);
		const { connection, sent } = fakeConnection();
		await hub.attach(connection);

		expect((await hub.offer(job('job-1', 'build-big'))).kind).toBe('refused');
		expect(offers(sent)).toHaveLength(0);
		expect(failures.get('job-1')).toContain(String(AGENT_LIMITS.maxVolume));
	});

	it('lets a build exactly at the ceiling through', async () => {
		// The boundary is the half of this worth writing down. "At most" that rejects the value
		// itself is the kind of off-by-one that only shows up as a build nobody can send twice.
		const { store } = fakeStore({ 'build-exact': AGENT_LIMITS.maxVolume });
		const hub = new AgentHub(store);
		const { connection, sent } = fakeConnection();
		await hub.attach(connection);

		expect((await hub.offer(job('job-1', 'build-exact'))).kind).toBe('delivered');
		expect(offers(sent)).toHaveLength(1);
	});

	it('enforces what this socket was told, not what the constant says today', async () => {
		// An older mod announced a smaller ceiling. Raising the constant in a release must not
		// retroactively let the server overrun a world still running the previous one.
		const { store, failures } = fakeStore({ 'build-1': 1_000 });
		const hub = new AgentHub(store);
		const { connection, sent } = fakeConnection(500);
		await hub.attach(connection);

		expect((await hub.offer(job('job-1', 'build-1'))).kind).toBe('refused');
		expect(offers(sent)).toHaveLength(0);
		expect(failures.get('job-1')).toContain('500');
	});

	it('applies to a region of a world like anything else', async () => {
		const { store, failures } = fakeStore({ 'build-big': AGENT_LIMITS.maxVolume + 1 });
		const hub = new AgentHub(store);
		const { connection, sent } = fakeConnection();
		await hub.attach(connection);

		expect((await hub.offer(job('job-1', 'build-big'), region(0, 0, 0))).kind).toBe('refused');
		expect(offers(sent)).toHaveLength(0);
		expect(failures.get('job-1')).toBeDefined();
	});
});

describe('an offline world is not a refusal', () => {
	it('leaves the job pending rather than failing it', async () => {
		// The two used to be the same `false`, so the route answered 202 for both and the site
		// printed "queued" over a job that was already dead. A job for a world that is merely
		// switched off really is queued — it lands when the player next starts the game.
		const { store, failures } = fakeStore({ 'build-1': 10 }, []);
		const hub = new AgentHub(store);

		const outcome = await hub.offer(job('job-1', 'build-1'));
		expect(outcome.kind).toBe('offline');
		expect(failures.size).toBe(0);
	});
});

describe('a world arrives in order', () => {
	async function world() {
		const { store, failures } = fakeStore({ 'build-r0': 40_000, 'build-r1': 40_000 });
		const hub = new AgentHub(store);
		const { connection, sent } = fakeConnection();
		await hub.attach(connection);
		return { hub, sent, failures };
	}

	it('offers region 0 with no anchor, because a player is about to choose one', async () => {
		const { hub, sent } = await world();

		expect((await hub.offer(job('job-r0', 'build-r0'), region(0, 0, 0))).kind).toBe('delivered');
		expect(offers(sent)[0]!.region).toEqual(region(0, 0, 0));
		expect(offers(sent)[0]!.region!.anchor).toBeUndefined();
	});

	it('refuses region 1 while region 0 has not said where it landed', async () => {
		const { hub, sent, failures } = await world();
		await hub.offer(job('job-r0', 'build-r0'), region(0, 0, 0));

		expect((await hub.offer(job('job-r1', 'build-r1'), region(1, 1, 0))).kind).toBe('refused');
		expect(offers(sent)).toHaveLength(1);
		expect(failures.get('job-r1')).toContain('region 2 of 4');
	});

	it('offers region 1 once the anchor comes back, with the anchor attached', async () => {
		const { hub, sent } = await world();
		await hub.offer(job('job-r0', 'build-r0'), region(0, 0, 0));

		const anchor = { x: -40, y: 64, z: 210, rotation: 1, dimension: 'minecraft:overworld' } as const;
		hub.noteJobState('job-r0', 'building', anchor);
		expect(hub.worldAnchor('world-1')).toEqual(anchor);

		expect((await hub.offer(job('job-r1', 'build-r1'), region(1, 1, 0))).kind).toBe('delivered');
		expect(offers(sent)[1]!.region).toEqual({ ...region(1, 1, 0), anchor });
	});

	it('reads the region off the job row when the caller passes none', async () => {
		// The route still passes it; a replay after a restart cannot, and the row is what it has.
		const { hub, sent } = await world();
		await hub.offer(job('job-r0', 'build-r0', region(0, 0, 0)));
		expect(offers(sent)[0]!.region).toEqual(region(0, 0, 0));
	});

	it('keeps region 0 as the origin, whatever later regions report', async () => {
		// Every region reports the corner it built from. Letting a later one become the world's
		// anchor would measure each remaining region from the last one placed rather than from
		// the first, and the map would walk away across the world as it was delivered.
		const { hub } = await world();
		await hub.offer(job('job-r0', 'build-r0'), region(0, 0, 0));

		const first = { x: 0, y: 64, z: 0, rotation: 0 } as const;
		hub.noteJobState('job-r0', 'building', first);
		await hub.offer(job('job-r1', 'build-r1'), region(1, 1, 0));
		hub.noteJobState('job-r1', 'building', { x: 128, y: 64, z: 0, rotation: 0 });

		expect(hub.worldAnchor('world-1')).toEqual(first);
	});

	it('ignores an anchor from a job that is not a region at all', async () => {
		const { hub } = await world();
		hub.noteJobState('job-unrelated', 'building', { x: 9, y: 9, z: 9, rotation: 0 });
		expect(hub.worldAnchor('world-1')).toBeUndefined();
	});

	it('forgets the world once its last region is finished', async () => {
		const { hub } = await world();
		await hub.offer(job('job-r0', 'build-r0'), region(0, 0, 0, 2));
		hub.noteJobState('job-r0', 'done', { x: 0, y: 64, z: 0, rotation: 0 });

		await hub.offer(job('job-r1', 'build-r1'), region(1, 1, 0, 2));
		expect(hub.worldAnchor('world-1')).toBeDefined();

		hub.noteJobState('job-r1', 'done');
		expect(hub.worldAnchor('world-1')).toBeUndefined();
	});

	it('does not let a second run of the same map inherit the first run’s anchor', async () => {
		// The map was sent once and placed. Sending it again offers a fresh region 0, and until
		// that one reports, region 1 of the new run has nowhere honest to go — the old corner is
		// wherever the old copy stands, which is exactly not where the player is about to aim.
		const { hub, failures } = await world();
		await hub.offer(job('job-a0', 'build-r0'), region(0, 0, 0, 2));
		hub.noteJobState('job-a0', 'done', { x: 0, y: 64, z: 0, rotation: 0 });

		await hub.offer(job('job-b0', 'build-r0'), region(0, 0, 0, 2));
		expect((await hub.offer(job('job-b1', 'build-r1'), region(1, 1, 0, 2))).kind).toBe('refused');
		expect(failures.get('job-b1')).toContain('first region');
	});
});

describe('the run survives a restart', () => {
	it('recovers region 0’s anchor from the rows when memory has never heard of the world', async () => {
		// A hub that has just started: nothing in memory, but the rows carry region 0's anchor
		// (from the mod's first progress frame) and its region (migration 009).
		const anchor = { x: 10, y: 64, z: 20, rotation: 0 } as const;
		const { store, anchorLookups } = fakeStore(
			{ 'build-r1': 40_000 },
			[],
			{ 'world-1': { anchor, footprint: { x: 128, z: 128 } } },
		);
		const hub = new AgentHub(store);
		const { connection, sent } = fakeConnection();
		await hub.attach(connection);

		expect((await hub.offer(job('job-r1', 'build-r1', region(1, 1, 0)))).kind).toBe('delivered');
		expect(offers(sent)[0]!.region?.anchor).toEqual(anchor);
		expect(anchorLookups()).toBe(1);

		// And caches it, so the next region does not ask the database again.
		await hub.offer(job('job-r2', 'build-r1', region(2, 0, 1)));
		expect(anchorLookups()).toBe(1);
	});

	it('learns region 0’s anchor from a frame that arrives after the restart, via the row’s region', async () => {
		const { store } = fakeStore({ 'build-r0': 40_000, 'build-r1': 40_000 });
		const hub = new AgentHub(store);
		const { connection, sent } = fakeConnection();
		await hub.attach(connection);

		// The cache is empty, so the only thing that says this frame is about region 0 is the
		// hint the socket handler reads off the job row.
		const anchor = { x: 0, y: 64, z: 0, rotation: 0 } as const;
		hub.noteJobState('job-r0', 'building', anchor, region(0, 0, 0));
		expect(hub.worldAnchor('world-1')).toEqual(anchor);

		expect((await hub.offer(job('job-r1', 'build-r1', region(1, 1, 0)))).kind).toBe('delivered');
		expect(offers(sent)[0]!.region?.anchor).toEqual(anchor);
	});

	it('re-offers a pending region as a region on reconnect, from the row alone', async () => {
		// `attach` replays whatever the database still calls pending, and this used to depend on
		// an in-memory map that a restart empties. Replayed without its region the offer becomes
		// "put this somewhere", and one square of the map lands wherever the player is standing.
		const anchor = { x: 0, y: 64, z: 0, rotation: 2 } as const;
		const pending = [job('job-r1', 'build-r1', region(1, 1, 0))];
		const { store } = fakeStore({ 'build-r1': 40_000 }, pending, {
			'world-1': { anchor, footprint: { x: 128, z: 128 } },
		});
		const hub = new AgentHub(store);

		const { connection, sent } = fakeConnection();
		await hub.attach(connection);

		const replayed = offers(sent);
		expect(replayed).toHaveLength(1);
		expect(replayed[0]!.region?.index).toBe(1);
		expect(replayed[0]!.region?.anchor?.rotation).toBe(2);
	});
});

describe('a truncated edge region under a quarter turn', () => {
	it('is offered with its offset corrected for the difference in footprint', async () => {
		// A 300×300 map in 128-blocks regions: the south row is 44 deep. Placed at a quarter turn,
		// the mod's `anchor + turn(offset)` lands that row 84 blocks off, because the corner it
		// builds from is the low corner of the *turned* box and a 44-deep box turns differently
		// from a 128-deep one. The server hands over the corrected offset; the mod's sum is
		// unchanged.
		const { store } = fakeStore({
			'build-r0': { blockCount: 40_000, sizeX: 128, sizeZ: 128 },
			'build-edge': { blockCount: 10_000, sizeX: 128, sizeZ: 44 },
		});
		const hub = new AgentHub(store);
		const { connection, sent } = fakeConnection();
		await hub.attach(connection);

		await hub.offer(job('job-r0', 'build-r0'), region(0, 0, 0, 9));
		const anchor = { x: -40, y: 64, z: 210, rotation: 1 } as const;
		hub.noteJobState('job-r0', 'building', anchor);

		const edge: JobRegion = { worldId: 'world-1', index: 6, total: 9, rx: 0, rz: 2, offset: { x: 0, y: 0, z: 256 } };
		expect((await hub.offer(job('job-edge', 'build-edge'), edge)).kind).toBe('delivered');

		const sentRegion = offers(sent)[1]!.region!;
		expect(sentRegion.offset).toEqual(deliveryOffset(edge.offset, 1, { x: 128, z: 128 }, { x: 128, z: 44 }));
		expect(sentRegion.offset).toEqual({ x: 0, y: 0, z: 172 });
	});

	it('leaves a full region’s offset byte for byte as it was', async () => {
		const { store } = fakeStore({
			'build-r0': { blockCount: 40_000, sizeX: 128, sizeZ: 128 },
			'build-r1': { blockCount: 40_000, sizeX: 128, sizeZ: 128 },
		});
		const hub = new AgentHub(store);
		const { connection, sent } = fakeConnection();
		await hub.attach(connection);

		await hub.offer(job('job-r0', 'build-r0'), region(0, 0, 0));
		hub.noteJobState('job-r0', 'building', { x: 0, y: 64, z: 0, rotation: 3 });
		await hub.offer(job('job-r1', 'build-r1'), region(1, 1, 0));
		expect(offers(sent)[1]!.region!.offset).toEqual(region(1, 1, 0).offset);
	});
});

describe('a reconnect closes the books on what went quiet', () => {
	it('reaps jobs left mid-build by a dropped socket', async () => {
		// Nothing ever moved a job out of `building` when the connection went, so the row kept
		// its status forever — and since that row is what answers "is this agent busy", one
		// dropped socket made a Minecraft world permanently un-buildable with a 409. The mod has
		// just told us what it is really doing, which is the moment the stale row is knowably
		// stale.
		const { store, reaped } = fakeStore({ 'build-a': 10 }, []);
		const hub = new AgentHub(store);

		expect(reaped()).toBe(0);
		await hub.attach(fakeConnection().connection);
		expect(reaped()).toBe(1);
	});
});

describe('a reconnect re-offers a region as a region', () => {
	it('does not replay it as a lone build a player would have to aim', async () => {
		// The in-memory path, for a hub that never restarted: the cache still knows the region
		// and the anchor, and the row need not be consulted.
		const pending = [job('job-r1', 'build-r1')];
		const { store } = fakeStore({ 'build-r0': 40_000, 'build-r1': 40_000 }, pending);
		const hub = new AgentHub(store);

		const first = fakeConnection();
		await hub.attach(first.connection);
		await hub.offer(job('job-r0', 'build-r0'), region(0, 0, 0));
		hub.noteJobState('job-r0', 'done', { x: 0, y: 64, z: 0, rotation: 2 });
		await hub.offer(pending[0]!, region(1, 1, 0));

		const second = fakeConnection();
		await hub.attach(second.connection);

		const replayed = offers(second.sent);
		expect(replayed).toHaveLength(1);
		expect(replayed[0]!.region?.index).toBe(1);
		expect(replayed[0]!.region?.anchor?.rotation).toBe(2);
	});
});
