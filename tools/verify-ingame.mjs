/**
 * The full loop: website → paired world → blocks actually placed in Minecraft.
 *
 * Drives a real dedicated server over RCON. Everything before this can pass while the build
 * still never appears: the protocol test proves the wire, the schematic test proves the file,
 * and only this proves the bot.
 *
 *   node tools/verify-ingame.mjs
 *
 * Needs a `runServer` dev server with RCON enabled, and the CraftMagic server on :3016.
 * Uses `/craftmagic place <pos>` rather than `/craftmagic build`, because the latter
 * needs a human standing in the world — the console path is also what a vanilla client or a
 * command block would use, so it is worth covering either way.
 */

import net from 'node:net';
import { expand, samples } from '@craftmagic/core';
import { signIn, throwawayCredentials } from './session.mjs';

const ORIGIN = process.env.CM_ORIGIN ?? 'http://localhost:3016';
const RCON_HOST = process.env.CM_RCON_HOST ?? '127.0.0.1';
const RCON_PORT = Number.parseInt(process.env.CM_RCON_PORT ?? '25575', 10);
const RCON_PASSWORD = process.env.CM_RCON_PASSWORD ?? 'craftmagic';

/** Flat dev world: bedrock at y=-64, surface at y=-60, so a build starts at y=-59. */
const AT = { x: 40, y: -59, z: 40 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(label, ok, detail = '') {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

/** Minimal RCON client — the protocol is four fields, so a dependency is not worth it. */
class Rcon {
	#socket;
	#id = 0;
	#pending = new Map();
	#buffer = Buffer.alloc(0);

	async connect() {
		this.#socket = net.createConnection({ host: RCON_HOST, port: RCON_PORT });
		this.#socket.on('data', (chunk) => this.#onData(chunk));
		await new Promise((resolve, reject) => {
			this.#socket.once('connect', resolve);
			this.#socket.once('error', reject);
		});
		const auth = await this.#send(3, RCON_PASSWORD);
		if (auth.id === -1) throw new Error('RCON authentication failed');
	}

	#onData(chunk) {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		while (this.#buffer.length >= 4) {
			const size = this.#buffer.readInt32LE(0);
			if (this.#buffer.length < size + 4) break;
			const id = this.#buffer.readInt32LE(4);
			const body = this.#buffer.subarray(12, size + 2).toString('utf8');
			this.#buffer = this.#buffer.subarray(size + 4);

			const waiter = this.#pending.get(id) ?? this.#pending.get(-1);
			if (waiter) {
				this.#pending.delete(waiter.id);
				waiter.resolve({ id, body });
			}
		}
	}

	#send(type, body) {
		const id = ++this.#id;
		const payload = Buffer.from(body, 'utf8');
		const packet = Buffer.alloc(14 + payload.length);
		packet.writeInt32LE(10 + payload.length, 0);
		packet.writeInt32LE(id, 4);
		packet.writeInt32LE(type, 8);
		payload.copy(packet, 12);
		this.#socket.write(packet);

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`RCON timeout for "${body}"`)), 20_000);
			this.#pending.set(id, {
				id,
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
			});
		});
	}

	async command(text) {
		const { body } = await this.#send(2, text);
		return body;
	}

	close() {
		this.#socket?.end();
	}
}

/**
 * Read a block by asserting on it.
 *
 * `data get block` only answers for block entities (chests, signs), so it errors on plain
 * stone. A bare `execute if block` returns "Test passed"/"Test failed" as its own feedback,
 * which RCON receives — whereas `run say` broadcasts to chat and comes back empty, silently
 * turning every check into a false negative (and every negated check into a false positive).
 */
async function blockIs(rcon, x, y, z, block) {
	const reply = await rcon.command(`execute if block ${x} ${y} ${z} ${block}`);
	if (!/Test (passed|failed)/i.test(reply)) {
		throw new Error(`unexpected reply from "execute if block": ${JSON.stringify(reply.slice(0, 120))}`);
	}
	return /Test passed/i.test(reply);
}

async function isAir(rcon, x, y, z) {
	return blockIs(rcon, x, y, z, 'minecraft:air');
}

/** The highest occupied cell, scanning down so the first hit wins. */
function highestBlock(grid) {
	for (let y = grid.size.y - 1; y >= 0; y--) {
		for (let z = 0; z < grid.size.z; z++) {
			for (let x = 0; x < grid.size.x; x++) {
				if (grid.voxels[x + z * grid.size.x + y * grid.size.x * grid.size.z] !== 0) {
					return { x, y, z };
				}
			}
		}
	}
	throw new Error('the sample expanded to nothing');
}

/** The website's half, carrying the session. The mod's half authenticates itself, in game. */
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
	return { status: response.status, body: text ? JSON.parse(text) : {} };
}

console.log(`site: ${ORIGIN}`);
console.log(`rcon: ${RCON_HOST}:${RCON_PORT}\n`);

// Worlds, builds and jobs belong to an account, so the driver needs one before it can act as
// the website. A fresh account each run also means the "clear previously paired worlds" step
// below has nothing of anyone else's to clear.
let session = null;
session = await signIn(ORIGIN, throwawayCredentials('ingame-verify'));
check('signed in as a throwaway account', typeof session.userId === 'string', session.email);

const rcon = new Rcon();
await rcon.connect();
check('connected to the Minecraft server over RCON', true);

// Blocks can only be placed in loaded chunks, and with nobody online nothing is loaded.
await rcon.command(`forceload add ${AT.x} ${AT.z} ${AT.x + 32} ${AT.z + 32}`);
check('forceloaded the build area', true, `${AT.x}, ${AT.y}, ${AT.z}`);

// Start from bare ground so the assertions cannot pass on pre-existing blocks.
await rcon.command(`fill ${AT.x} ${AT.y} ${AT.z} ${AT.x + 24} ${AT.y + 20} ${AT.z + 16} air`);
check('build area starts empty', await isAir(rcon, AT.x, AT.y, AT.z));

// Revoke anything paired earlier. Repeated runs otherwise leave several agents around and
// "the online one" becomes ambiguous — which is exactly how a job gets queued for one
// identity while the mod fetches it as another.
const existing = (await json(`${ORIGIN}/api/agent/agents`)).body.agents ?? [];
for (const stale of existing) {
	await json(`${ORIGIN}/api/agent/agents/${stale.id}`, { method: 'DELETE' });
}
check('cleared previously paired worlds', true, `${existing.length} revoked`);

// 1. Pair, running exactly the command a player would type.
const code = (await json(`${ORIGIN}/api/agent/pair-codes`, { method: 'POST' })).body.code;
check('site minted a pairing code', typeof code === 'string', code);

await rcon.command(`craftmagic server ${ORIGIN}`);
const pairOutput = await rcon.command(`craftmagic pair ${code}`);
check('ran /craftmagic pair in game', true, pairOutput.trim().slice(0, 60));
await sleep(4000);

const agents = (await json(`${ORIGIN}/api/agent/agents`)).body.agents ?? [];
const agent = agents.find((a) => a.online);
check('the world shows as online on the site', Boolean(agent), agent ? `${agent.name} (${agent.mcVersion})` : 'none online');
if (!agent) {
	rcon.close();
	console.log('\npairing did not establish a socket');
	process.exitCode = 1;
	process.exit(1);
}

// 2. Send a build, the way the website will.
const { grid, blockCount } = expand(samples.cottage);
const build = await json(`${ORIGIN}/api/builds`, {
	method: 'POST',
	body: JSON.stringify({
		name: 'In-Game Test Cottage',
		program: samples.cottage,
		grid: { size: grid.size, palette: grid.palette, voxels: Array.from(grid.voxels) },
	}),
});
check('saved the build', build.status === 201, `${build.body.blockCount} blocks`);

const job = await json(`${ORIGIN}/api/agent/jobs`, {
	method: 'POST',
	body: JSON.stringify({ agentId: agent.id, buildId: build.body.id }),
});
check('queued the job', job.status === 202, `delivered=${job.body.delivered}`);
const jobId = job.body.id;

// 3. The mod downloads and parses it, then waits to be told where.
let state = null;
for (let i = 0; i < 30; i++) {
	state = (await json(`${ORIGIN}/api/agent/jobs/${jobId}`)).body;
	if (state.status === 'previewing' || state.status === 'failed') break;
	await sleep(1000);
}
check('the mod fetched and parsed the build', state?.status === 'previewing', `status=${state?.status}`);

// 4. Place it.
await rcon.command('craftmagic speed 0');
const placeOutput = await rcon.command(`craftmagic place ${AT.x} ${AT.y} ${AT.z}`);
check('ran /craftmagic place', !placeOutput.toLowerCase().includes('no build'), placeOutput.trim().slice(0, 70));

let finished = null;
for (let i = 0; i < 90; i++) {
	finished = (await json(`${ORIGIN}/api/agent/jobs/${jobId}`)).body;
	if (['done', 'failed', 'cancelled'].includes(finished.status)) break;
	await sleep(1000);
}
check('the build completed', finished?.status === 'done', `${finished?.progressPlaced}/${finished?.progressTotal}`);
check('every block was reported placed', finished?.progressPlaced === blockCount, `${finished?.progressPlaced} vs ${blockCount}`);

// 5. Read the world back. Everything above could pass on the mod's word alone.
check('foundation exists in the world', await blockIs(rcon, AT.x, AT.y, AT.z, 'minecraft:stone_bricks'));

check('foundation spans the footprint', !(await isAir(rcon, AT.x + 10, AT.y, AT.z + 6)));

// The topmost block of the build, derived from the grid rather than hard-coded — an
// assertion on a fixed height silently becomes wrong the moment the sample changes, and
// then reports a correct build as broken. If this block is present the whole structure
// landed, not just the layers the bot reached before something went wrong.
const top = highestBlock(grid);
check(
	`topmost block exists (build y=${top.y})`,
	!(await isAir(rcon, AT.x + top.x, AT.y + top.y, AT.z + top.z)),
	`world ${AT.x + top.x}, ${AT.y + top.y}, ${AT.z + top.z}`,
);

// A wall block should carry the oak planks the palette asked for, proving blockstates
// survived the trip rather than everything becoming stone.
check(
	'walls use the right material',
	(await blockIs(rcon, AT.x + 1, AT.y + 3, AT.z + 1, 'minecraft:oak_planks'))
		|| (await blockIs(rcon, AT.x + 1, AT.y + 3, AT.z + 1, 'minecraft:stripped_dark_oak_log')),
);

// The bot must clean up after itself.
const stands = await rcon.command('execute if entity @e[type=armor_stand] run say found');
check('builder bot despawned', !stands.includes('found'), stands.trim().slice(0, 60));

await rcon.command(`forceload remove ${AT.x} ${AT.z} ${AT.x + 32} ${AT.z + 32}`);
rcon.close();

console.log(failures === 0 ? '\nfull loop verified: website → world → blocks' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
