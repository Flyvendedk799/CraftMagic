/**
 * What a job offer looks like on the wire, now that a build can be one tile of a world.
 *
 * Two properties are pinned here, and only the second one is new. The first is that an
 * ordinary offer is unchanged — same keys, same order of magnitude of bytes, no `region: null`
 * — because the field was added optional precisely so that a mod built before worlds existed
 * keeps working against a server built after them. An optional field is only optional if
 * somebody checks; the moment a `region` key appears on a lone build, "optional" has quietly
 * become "always sent, sometimes empty", and the mod that ships with the current release is
 * the one that finds out.
 *
 * The second is that the region survives a round trip through JSON intact. The offer is the
 * one message with arithmetic in it: `offset` is what the mod adds to the anchor, so a field
 * that arrives as a string, or an anchor that loses its rotation on the way, is not a display
 * bug — it is a map delivered into the wrong squares.
 *
 * Anchors get their own block because the server now does maths with them rather than storing
 * them for the website to print. A rotation of 7 or an x of NaN used to be a bad status line;
 * it is now the origin sixteen regions are measured from.
 */

import { describe, expect, it } from 'vitest';
import {
	AGENT_LIMITS,
	isBuildAnchor,
	parseAgentMessage,
	type BuildAnchor,
	type JobRegion,
	type ServerToAgent,
} from '../index.js';

/** The shape the hub builds, minus whichever half of it is under test. */
const LONE_OFFER = {
	t: 'job.offer',
	jobId: 'job-1',
	buildId: 'build-1',
	name: 'Oak Cottage',
	size: { x: 5, y: 7, z: 11 },
	blockCount: 412,
	dataUrl: '/api/agent/jobs/job-1/schem',
} satisfies ServerToAgent;

const REGION: JobRegion = {
	worldId: 'world-1',
	index: 5,
	total: 16,
	rx: 1,
	rz: 1,
	offset: { x: 128, y: 0, z: 128 },
	anchor: { x: -40, y: 64, z: 210, rotation: 1, dimension: 'minecraft:overworld' },
};

describe('a lone build offer is what it always was', () => {
	it('carries no region key at all', () => {
		const wire = JSON.parse(JSON.stringify(LONE_OFFER)) as Record<string, unknown>;

		expect('region' in wire).toBe(false);
		expect(Object.keys(wire).sort()).toEqual(
			['blockCount', 'buildId', 'dataUrl', 'jobId', 'name', 'size', 't'].sort(),
		);
	});

	it('round-trips byte-identically', () => {
		expect(JSON.stringify(JSON.parse(JSON.stringify(LONE_OFFER)))).toBe(JSON.stringify(LONE_OFFER));
	});
});

describe('a region offer round-trips', () => {
	const offer = { ...LONE_OFFER, region: REGION } satisfies ServerToAgent;
	const wire = JSON.parse(JSON.stringify(offer)) as Extract<ServerToAgent, { t: 'job.offer' }>;

	it('keeps every field the mod reads', () => {
		expect(wire.region).toEqual(REGION);
	});

	it('keeps the offset as numbers, which the mod adds to the anchor', () => {
		for (const axis of ['x', 'y', 'z'] as const) {
			expect(typeof wire.region!.offset[axis]).toBe('number');
		}
	});

	it('keeps the anchor rotation, which decides how the offset is turned', () => {
		// Dropping this is the failure that looks like a bug in the world document: every
		// region built correctly, and laid out across the wrong squares of the map.
		expect(wire.region!.anchor?.rotation).toBe(1);
		expect(wire.region!.anchor?.dimension).toBe('minecraft:overworld');
	});

	it('leaves the rest of the offer untouched', () => {
		const { region, ...rest } = wire;
		expect(region).toBeDefined();
		expect(rest).toEqual(LONE_OFFER);
	});
});

describe('region 0 carries no anchor', () => {
	it('is the one a player places, so it has nothing to be relative to yet', () => {
		const first: JobRegion = { ...REGION, index: 0, rx: 0, rz: 0, offset: { x: 0, y: 0, z: 0 } };
		delete first.anchor;

		const wire = JSON.parse(JSON.stringify({ ...LONE_OFFER, region: first })) as Extract<
			ServerToAgent,
			{ t: 'job.offer' }
		>;
		expect(wire.region!.anchor).toBeUndefined();
		expect(wire.region!.offset).toEqual({ x: 0, y: 0, z: 0 });
	});
});

describe('a reported anchor is checked before it is believed', () => {
	it('accepts one from a current mod', () => {
		expect(isBuildAnchor({ x: 1, y: 2, z: 3, rotation: 0 })).toBe(true);
		expect(isBuildAnchor({ x: -1, y: 64, z: 3, rotation: 3, dimension: 'minecraft:the_nether' })).toBe(
			true,
		);
	});

	it('refuses a rotation that is not a quarter turn', () => {
		for (const rotation of [4, -1, 7, '1', null, undefined]) {
			expect(isBuildAnchor({ x: 0, y: 0, z: 0, rotation })).toBe(false);
		}
	});

	it('refuses coordinates that are not finite numbers', () => {
		expect(isBuildAnchor({ x: Number.NaN, y: 0, z: 0, rotation: 0 })).toBe(false);
		expect(isBuildAnchor({ x: Number.POSITIVE_INFINITY, y: 0, z: 0, rotation: 0 })).toBe(false);
		expect(isBuildAnchor({ x: '0', y: 0, z: 0, rotation: 0 })).toBe(false);
		expect(isBuildAnchor({ y: 0, z: 0, rotation: 0 })).toBe(false);
	});

	it('refuses a dimension that is not a key', () => {
		expect(isBuildAnchor({ x: 0, y: 0, z: 0, rotation: 0, dimension: 7 })).toBe(false);
		// Null in particular: gson writes an absent string that way unless it is told not to.
		expect(isBuildAnchor({ x: 0, y: 0, z: 0, rotation: 0, dimension: null })).toBe(false);
	});

	it('refuses anything that is not an object', () => {
		for (const junk of [null, undefined, 'anchor', 3, []]) {
			expect(isBuildAnchor(junk)).toBe(false);
		}
	});
});

describe('a job.state carrying an anchor still parses', () => {
	it('reaches the server with the anchor attached', () => {
		const frame = JSON.stringify({
			t: 'job.state',
			jobId: 'job-1',
			state: 'building',
			progress: { placed: 0, total: 412 },
			anchor: { x: -40, y: 64, z: 210, rotation: 1, dimension: 'minecraft:overworld' },
		});

		const parsed = parseAgentMessage(frame);
		expect(parsed?.t).toBe('job.state');
		const anchor = (parsed as { anchor?: BuildAnchor }).anchor;
		expect(isBuildAnchor(anchor)).toBe(true);
		expect(anchor?.rotation).toBe(1);
	});

	it('still parses one from a mod that reports no anchor', () => {
		const parsed = parseAgentMessage(
			JSON.stringify({ t: 'job.state', jobId: 'job-1', state: 'done' }),
		);
		expect(parsed?.t).toBe('job.state');
		expect(isBuildAnchor((parsed as { anchor?: unknown }).anchor)).toBe(false);
	});
});

describe('the announced limit', () => {
	it('is a value both sides can name, not a literal in the handshake', () => {
		// It used to be written inline in `hello.ok` and enforced nowhere. Naming it is what
		// makes "the server promised 500,000" a thing the server can check it kept.
		expect(AGENT_LIMITS.maxVolume).toBe(500_000);
	});
});
