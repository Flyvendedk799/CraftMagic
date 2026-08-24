/**
 * End-to-end test of the agent protocol, without Minecraft.
 *
 * Impersonates the mod: mints a pairing code the way the website will, claims it, opens the
 * WebSocket with the resulting token, receives a job offer, fetches the `.schem` over HTTPS,
 * and reports progress back — checking the server's view after each step.
 *
 * Worth having separately from the in-game test: when a real build fails, this says whether
 * the fault is in the protocol or in the mod.
 *
 * The two halves authenticate differently, and that is the point rather than an inconvenience.
 * Anything the *website* does carries a session cookie; anything the *mod* does carries an
 * agent token and no cookie at all. Mixing them up is exactly the mistake this catches — a
 * session check on the schematic route would break send-to-game in a way that looks like a mod
 * bug.
 */

import fs from 'node:fs';
import path from 'node:path';
import { expand, samples, writeSchematic } from '@imaginecraft/core';
import { signIn, throwawayCredentials } from './session.mjs';

const ORIGIN = process.env.IC_ORIGIN ?? 'http://localhost:3016';
const WS_ORIGIN = ORIGIN.replace(/^http/, 'ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(label, ok, detail = '') {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

/** The website's half. Every one of these carries the session, like a browser would. */
async function json(url, options = {}) {
	const response = await fetch(url, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...(session ? { Cookie: session.cookie } : {}),
			...(options.headers ?? {}),
		},
	});
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { raw: text };
	}
	return { status: response.status, body };
}

console.log(`target: ${ORIGIN}\n`);

// 0. Sign in. Builds, pairing and jobs all belong to an account.
let session = null;
session = await signIn(ORIGIN, throwawayCredentials('agent-verify'));
check('signed in as a throwaway account', typeof session.userId === 'string', session.email);

// 1. Save a build, the way the website will when you press "Send to game".
const { grid, blockCount } = expand(samples.cottage);
const saved = await json(`${ORIGIN}/api/builds`, {
	method: 'POST',
	body: JSON.stringify({
		name: 'Agent Test Cottage',
		program: samples.cottage,
		grid: { size: grid.size, palette: grid.palette, voxels: Array.from(grid.voxels) },
	}),
});
check('save a build', saved.status === 201, `id=${saved.body.id} blocks=${saved.body.blockCount}`);
check('server counted the same blocks', saved.body.blockCount === blockCount, `${saved.body.blockCount} vs ${blockCount}`);
const buildId = saved.body.id;

// 2. Pair, as a player would: the site shows a code, the mod claims it.
const codeResponse = await json(`${ORIGIN}/api/agent/pair-codes`, { method: 'POST' });
check('mint a pairing code', codeResponse.status === 201, codeResponse.body.code);
const code = codeResponse.body.code;
check('code is 6 unambiguous characters', /^[A-HJ-NP-Z2-9]{6}$/.test(code ?? ''), code);

const claim = await json(`${ORIGIN}/api/agent/claim`, {
	method: 'POST',
	body: JSON.stringify({ code, mcVersion: '26.2', modVersion: '0.1.0-test', envType: 'integrated' }),
});
check('claim the code', claim.status === 200, `agent=${claim.body.agentId}`);
const { agentToken, agentId } = claim.body;

const reclaim = await json(`${ORIGIN}/api/agent/claim`, {
	method: 'POST',
	body: JSON.stringify({ code, mcVersion: '26.2', modVersion: '0.1.0-test', envType: 'integrated' }),
});
check('a code cannot be claimed twice', reclaim.status === 404);

const badCode = await json(`${ORIGIN}/api/agent/claim`, {
	method: 'POST',
	body: JSON.stringify({ code: 'ZZZZZZ' }),
});
check('an unknown code is rejected', badCode.status === 404);

// 3. Connect as the mod would.
const socket = new WebSocket(`${WS_ORIGIN}/agent/ws`, {
	headers: { Authorization: `Bearer ${agentToken}` },
});
const inbox = [];
socket.addEventListener('message', (event) => inbox.push(JSON.parse(event.data)));

await new Promise((resolve, reject) => {
	socket.addEventListener('open', resolve, { once: true });
	socket.addEventListener('error', () => reject(new Error('socket failed')), { once: true });
});

socket.send(
	JSON.stringify({
		t: 'hello',
		protocolVersion: 1,
		modVersion: '0.1.0-test',
		mcVersion: '26.2',
		envType: 'integrated',
	}),
);

const waitFor = async (predicate, label, ms = 10_000) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const found = inbox.find(predicate);
		if (found) return found;
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${label}`);
};

const helloOk = await waitFor((m) => m.t === 'hello.ok', 'hello.ok');
check('authenticated handshake', helloOk.t === 'hello.ok', `agentName="${helloOk.agentName}"`);

const agents = await json(`${ORIGIN}/api/agent/agents`);
const me = agents.body.agents?.find((a) => a.id === agentId);
check('agent shows as online', me?.online === true, `mcVersion=${me?.mcVersion}`);

// 4. Send the build to that world.
const job = await json(`${ORIGIN}/api/agent/jobs`, {
	method: 'POST',
	body: JSON.stringify({ agentId, buildId }),
});
check('queue a job', job.status === 202, `delivered=${job.body.delivered}`);
const jobId = job.body.id;

const offer = await waitFor((m) => m.t === 'job.offer', 'job.offer');
check('agent received the offer over the socket', offer.jobId === jobId, `name="${offer.name}" blocks=${offer.blockCount}`);
check('offer carries a data url', typeof offer.dataUrl === 'string', offer.dataUrl);

const busy = await json(`${ORIGIN}/api/agent/jobs`, {
	method: 'POST',
	body: JSON.stringify({ agentId, buildId }),
});
check('a second job for a busy agent is refused', busy.status === 409);

// 5. Fetch the build the way the mod will.
const schemResponse = await fetch(`${ORIGIN}${offer.dataUrl}`, {
	headers: { Authorization: `Bearer ${agentToken}` },
});
const schemBytes = new Uint8Array(await schemResponse.arrayBuffer());
check('fetch the schematic with the agent token', schemResponse.status === 200, `${schemBytes.length} bytes`);
check('it is gzipped NBT', schemBytes[0] === 0x1f && schemBytes[1] === 0x8b);

const expected = writeSchematic(grid, { name: 'Agent Test Cottage' });
check('bytes match what the exporter produces', schemBytes.length === expected.length, `${schemBytes.length} vs ${expected.length}`);

const unauthorised = await fetch(`${ORIGIN}${offer.dataUrl}`);
check('the schematic requires a token', unauthorised.status === 401);

// The two schemes are not interchangeable in either direction. A session cookie is not an
// agent credential, and accepting one here would mean any signed-in user could read any
// build by guessing a job id.
const withCookieOnly = await fetch(`${ORIGIN}${offer.dataUrl}`, { headers: { Cookie: session.cookie } });
check('a session cookie is not an agent token', withCookieOnly.status === 401, `HTTP ${withCookieOnly.status}`);

// And the website's half is not reachable without a session. This is the check that would
// have caught the anonymous-scope hole: a signed-out visitor listing somebody else's worlds.
for (const [label, method, url] of [
	['list worlds', 'GET', '/api/agent/agents'],
	['mint a pairing code', 'POST', '/api/agent/pair-codes'],
	['queue a job', 'POST', '/api/agent/jobs'],
	['read a job', 'GET', `/api/agent/jobs/${jobId}`],
	['save a build', 'POST', '/api/builds'],
]) {
	const anonymous = await fetch(`${ORIGIN}${url}`, {
		method,
		headers: { 'Content-Type': 'application/json' },
		...(method === 'POST' ? { body: '{}' } : {}),
	});
	check(`signed out cannot ${label}`, anonymous.status === 401, `HTTP ${anonymous.status}`);
}

// 6. Report progress, and confirm the server tracked it.
socket.send(JSON.stringify({ t: 'job.ack', jobId }));
socket.send(
	JSON.stringify({
		t: 'job.state',
		jobId,
		state: 'building',
		progress: { placed: 500, total: blockCount },
		anchor: { x: 100, y: 64, z: -20, rotation: 1 },
	}),
);
await sleep(500);

const midway = await json(`${ORIGIN}/api/agent/jobs/${jobId}`);
check('server recorded progress', midway.body.progressPlaced === 500, `${midway.body.progressPlaced}/${midway.body.progressTotal}`);
check('server recorded the anchor', midway.body.anchor?.x === 100, JSON.stringify(midway.body.anchor));
check('status moved to building', midway.body.status === 'building');

socket.send(
	JSON.stringify({ t: 'job.state', jobId, state: 'done', progress: { placed: blockCount, total: blockCount } }),
);
await sleep(500);

const finished = await json(`${ORIGIN}/api/agent/jobs/${jobId}`);
check('job completed', finished.body.status === 'done', `${finished.body.progressPlaced} placed`);

const afterDone = await json(`${ORIGIN}/api/agent/jobs`, {
	method: 'POST',
	body: JSON.stringify({ agentId, buildId }),
});
check('a finished job frees the agent', afterDone.status === 202);

// Keep the schematic so the Minecraft-side parser can be run against it.
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync(path.join('out', 'agent-delivered.schem'), schemBytes);
console.log('\nwrote out/agent-delivered.schem');

socket.close();
console.log(failures === 0 ? '\nall agent protocol checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
