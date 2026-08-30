/**
 * Two promises the hub is now expected to keep before an offer leaves the building.
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
 * Driven against a hand-written store rather than the database, because neither promise is
 * about SQL. Both are about what the hub does in the seconds before it calls `send`.
 */

import { describe, expect, it } from 'vitest';
import { AGENT_LIMITS, type JobRegion, type ServerToAgent } from '@craftmagic/core';
import { AgentHub, type Connection } from './hub.js';
import type { AgentStore, JobRow } from './store.js';

const AGENT = 'agent-1';

function job(id: string, buildId: string): JobRow {
	return {
		id,
		agentId: AGENT,
		buildId,
		status: 'pending',
		progressPlaced: 0,
		progressTotal: 0,
		anchor: null,
		error: null,
	};
}

/**
 * A store that answers the three questions the hub asks it and records the answers it is given.
 *
 * `failures` is the interesting one: a refused offer is not a silent no-op, it is a job the
 * website has to be able to show a reason for.
 */
function fakeStore(blockCounts: Record<string, number>, pending: JobRow[] = []) {
	const failures = new Map<string, string | null>();
	const store = {
		async getBuildForAgent(id: string) {
			if (!(id in blockCounts)) return null;
			return {
				id,
				name: `Build ${id}`,
				sizeX: 16,
				sizeY: 16,
				sizeZ: 16,
				blockCount: blockCounts[id],
			};
		},
		async updateJob(id: string, patch: { status?: string; error?: string | null }) {
			if (patch.status === 'failed') failures.set(id, patch.error ?? null);
			return null;
		},
		async pendingJobsFor() {
			return pending;
		},
	} as unknown as AgentStore;

	return { store, failures };
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

		expect(await hub.offer(job('job-1', 'build-big'))).toBe(false);
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

		expect(await hub.offer(job('job-1', 'build-exact'))).toBe(true);
		expect(offers(sent)).toHaveLength(1);
	});

	it('enforces what this socket was told, not what the constant says today', async () => {
		// An older mod announced a smaller ceiling. Raising the constant in a release must not
		// retroactively let the server overrun a world still running the previous one.
		const { store, failures } = fakeStore({ 'build-1': 1_000 });
		const hub = new AgentHub(store);
		const { connection, sent } = fakeConnection(500);
		await hub.attach(connection);

		expect(await hub.offer(job('job-1', 'build-1'))).toBe(false);
		expect(offers(sent)).toHaveLength(0);
		expect(failures.get('job-1')).toContain('500');
	});

	it('applies to a region of a world like anything else', async () => {
		const { store, failures } = fakeStore({ 'build-big': AGENT_LIMITS.maxVolume + 1 });
		const hub = new AgentHub(store);
		const { connection, sent } = fakeConnection();
		await hub.attach(connection);

		expect(await hub.offer(job('job-1', 'build-big'), region(0, 0, 0))).toBe(false);
		expect(offers(sent)).toHaveLength(0);
		expect(failures.get('job-1')).toBeDefined();
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

		expect(await hub.offer(job('job-r0', 'build-r0'), region(0, 0, 0))).toBe(true);
		expect(offers(sent)[0]!.region).toEqual(region(0, 0, 0));
		expect(offers(sent)[0]!.region!.anchor).toBeUndefined();
	});

	it('refuses region 1 while region 0 has not said where it landed', async () => {
		const { hub, sent, failures } = await world();
		await hub.offer(job('job-r0', 'build-r0'), region(0, 0, 0));

		expect(await hub.offer(job('job-r1', 'build-r1'), region(1, 1, 0))).toBe(false);
		expect(offers(sent)).toHaveLength(1);
		expect(failures.get('job-r1')).toContain('region 2 of 4');
	});

	it('offers region 1 once the anchor comes back, with the anchor attached', async () => {
		const { hub, sent } = await world();
		await hub.offer(job('job-r0', 'build-r0'), region(0, 0, 0));

		const anchor = { x: -40, y: 64, z: 210, rotation: 1, dimension: 'minecraft:overworld' } as const;
		hub.noteJobState('job-r0', 'building', anchor);
		expect(hub.worldAnchor('world-1')).toEqual(anchor);

		expect(await hub.offer(job('job-r1', 'build-r1'), region(1, 1, 0))).toBe(true);
		expect(offers(sent)[1]!.region).toEqual({ ...region(1, 1, 0), anchor });
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
});

describe('a reconnect re-offers a region as a region', () => {
	it('does not replay it as a lone build a player would have to aim', async () => {
		// `attach` replays whatever the database still calls pending, and the row cannot say it
		// is a region — being an ordinary build is what lets the rest of the engine ignore
		// worlds entirely. Replayed without its region the offer becomes "put this somewhere",
		// and one square of the map lands wherever the player is standing.
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
