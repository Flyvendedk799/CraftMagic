/**
 * Prove the renderer streams a world instead of holding one.
 *
 * The thing this guards is a ceiling, and a ceiling is not something a unit test can stand
 * under. `VoxelWorld` used to mesh every 16³ chunk of whatever it was handed and keep every
 * mesh forever, which is exactly right for a building and fatal for a plot: 512×160×512 is
 * 10,240 chunks, four times the largest build the engine will produce. So this loads one,
 * moves across it and back three times, and asks the three questions that separate streaming
 * from luck — are the chunks near the camera meshed, are the ones left behind actually gone,
 * and does the resident count stay flat lap after lap rather than creeping upwards.
 *
 * The build is saved through the API rather than generated in the page, because the editor's
 * own expander is capped at the engine's 256×160×256 and cannot produce a world. A saved
 * build with no program behind it opens as raw voxels, which is precisely the shape a world
 * region arrives in.
 *
 * Two traps are paid for here, both learned the hard way in this repo:
 *
 *   * Headless Chrome stops compositing once a page is visually static, and the editor
 *     reports meshing progress from a `requestAnimationFrame` callback — so a poll loop can
 *     burn its whole timeout against a build that finished seconds ago. Every wait forces a
 *     frame with a throwaway `captureScreenshot`. `requestAnimationFrame` from the driver
 *     side hangs outright rather than helping.
 *   * The editor's WASD flight is the same problem wearing a different hat, and it is why the
 *     camera is moved by panning instead. The keys are integrated per frame, so a held key
 *     travels exactly as far as the number of frames that happen to run — measured runs of
 *     the identical gesture moved anywhere from a hundred blocks to off the edge of the plot.
 *     A pan is a pointer delta, so the same drag always covers the same ground.
 *
 *   node tools/verify-streaming.mjs [origin]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeVoxels, toBase64 } from '@craftmagic/core';

const ORIGIN = (process.argv[2] ?? process.env.CM_ORIGIN ?? 'http://localhost:3016').replace(/\/+$/, '');
const EMAIL = process.env.CM_STREAM_EMAIL ?? 'verify-streaming@example.test';
const PASSWORD = process.env.CM_STREAM_PASSWORD ?? 'verify-streaming-password-1';

/**
 * How far each leg drags, in pixels of pan.
 *
 * Pan distance is proportional to how far the camera sits from what it is looking at, so this
 * is a fraction of the framing rather than a number of blocks. Chosen to be comfortably past
 * the renderer's hysteresis band — far enough that the trailing edge of the working set is
 * genuinely abandoned — while leaving the view over the plot rather than off the side of it.
 */
const PAN_PIXELS = 220;

/** 32×10×32 chunks — four times the largest build the engine will make, and the point. */
const SIZE = { x: 512, y: 160, z: 512 };
const CHUNKS = Math.ceil(SIZE.x / 16) * Math.ceil(SIZE.y / 16) * Math.ceil(SIZE.z / 16);

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A plot: rolling ground with a grid of towers on it.
 *
 * Terrain rather than noise, deliberately. Noise fills every chunk with faces and would make
 * this a memory test; real ground is a thin shell of visible surface over solid rock under a
 * great deal of air, which is what the working set is sized against.
 */
function plot() {
	const cells = SIZE.x * SIZE.y * SIZE.z;
	const voxels = new Uint16Array(cells);
	const layer = SIZE.x * SIZE.z;
	let blocks = 0;

	for (let z = 0; z < SIZE.z; z++) {
		for (let x = 0; x < SIZE.x; x++) {
			// Floored at 4 rather than left to the sines: they trough below zero, and a
			// column with no blocks in it is a hole through the plot. That is honest terrain
			// as far as the renderer is concerned, but it makes the screenshot look like a
			// streaming failure, which is the one thing this file must not do.
			const height = Math.max(
				4,
				12 + Math.round(6 * Math.sin(x / 37) + 6 * Math.cos(z / 29) + 3 * Math.sin((x + z) / 17)),
			);
			for (let y = 0; y < height; y++) {
				voxels[x + z * SIZE.x + y * layer] = y === height - 1 ? 2 : 1;
				blocks++;
			}
			// A tower every 64 blocks, so there is something tall to see and to leave behind.
			if (x % 64 === 8 && z % 64 === 8) {
				for (let y = height; y < height + 40; y++) {
					for (let dz = 0; dz < 8; dz++) {
						for (let dx = 0; dx < 8; dx++) {
							const wx = x + dx;
							const wz = z + dz;
							if (wx >= SIZE.x || wz >= SIZE.z) continue;
							const shell = dx === 0 || dx === 7 || dz === 0 || dz === 7;
							if (!shell) continue;
							voxels[wx + wz * SIZE.x + y * layer] = 3;
							blocks++;
						}
					}
				}
			}
		}
	}

	return {
		blocks,
		grid: {
			size: SIZE,
			palette: ['minecraft:air', 'minecraft:stone', 'minecraft:grass_block', 'minecraft:bricks'],
			voxels,
		},
	};
}

let cookie = '';
async function api(route, body, method = 'POST') {
	const res = await fetch(ORIGIN + route, {
		method,
		headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const set = res.headers.get('set-cookie');
	if (set) cookie = set.split(';')[0];
	const text = await res.text();
	let parsed = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = { raw: text.slice(0, 200) };
	}
	return { status: res.status, body: parsed };
}

const EDGE = [
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) {
	console.error('Edge not found.');
	process.exit(1);
}

let buildId = null;
let child = null;
let ws = null;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-stream-'));

try {
	let auth = await api('/api/auth/register', { email: EMAIL, password: PASSWORD });
	if (auth.status >= 400) auth = await api('/api/auth/login', { email: EMAIL, password: PASSWORD });
	if (auth.status >= 400) throw new Error(`could not sign in: HTTP ${auth.status}`);

	const world = plot();
	const encoded = toBase64(encodeVoxels(world.grid));
	const saved = await api('/api/builds', {
		name: 'verify-streaming plot',
		library: true,
		detached: true,
		grid: { size: SIZE, palette: world.grid.palette, data: encoded },
	});
	if (saved.status !== 201) throw new Error(`could not save the plot: HTTP ${saved.status}`);
	buildId = saved.body.id;
	console.log(
		`  plot   ${SIZE.x}×${SIZE.y}×${SIZE.z} · ${CHUNKS.toLocaleString()} chunks · ` +
			`${world.blocks.toLocaleString()} blocks · ${(encoded.length / 1048576).toFixed(2)}MB sent\n`,
	);

	const port = 9600 + (process.pid % 300);
	child = spawn(
		EDGE,
		[
			'--headless=new', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
			'--hide-scrollbars', '--window-size=1400,950',
			`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
		],
		{ stdio: 'ignore' },
	);

	let target;
	for (let i = 0; i < 60 && !target; i++) {
		try {
			target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
				(t) => t.type === 'page' && t.webSocketDebuggerUrl,
			);
		} catch { /* still starting */ }
		if (!target) await sleep(250);
	}
	if (!target) throw new Error('devtools never came up');

	ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
	});

	let nextId = 1;
	const pending = new Map();
	const pageErrors = [];
	ws.addEventListener('message', (event) => {
		const message = JSON.parse(event.data);
		const waiter = pending.get(message.id);
		if (waiter) {
			pending.delete(message.id);
			waiter(message.result);
		}
		if (message.method === 'Runtime.exceptionThrown') {
			const d = message.params.exceptionDetails;
			pageErrors.push((d.exception?.description ?? d.text).slice(0, 200));
		}
	});
	const send = (method, params = {}) =>
		new Promise((resolve) => {
			const id = nextId++;
			pending.set(id, resolve);
			ws.send(JSON.stringify({ id, method, params }));
		});

	const evaluate = async (expression) => {
		const { result, exceptionDetails } = await send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluate failed');
		return result.value;
	};

	/** Everything the canvas publishes about its working set, as numbers. */
	const facts = async () =>
		evaluate(`(() => {
			const canvas = document.querySelector('.editor canvas');
			const editor = document.querySelector('.editor');
			if (!canvas || !editor) return null;
			return {
				chunks: Number(canvas.dataset.chunks ?? -1),
				evicted: Number(canvas.dataset.evicted ?? -1),
				streaming: canvas.dataset.streaming ?? '?',
				remaining: Number(editor.dataset.remaining ?? -1),
			};
		})()`);

	/** One forced composite. Nothing that reads a frame counter works without this. */
	const frame = () => send('Page.captureScreenshot', { format: 'jpeg', quality: 1 });

	const waitFor = async (expression, label, ms = 180_000) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (await evaluate(expression)) return true;
			await frame();
			await sleep(150);
		}
		// Says what the page was actually showing when it gave up. A bare timeout here reads
		// exactly like the compositing trap above, which has already caused two false
		// diagnoses in this repo, so it must not be the only thing a failure reports.
		throw new Error(`timed out waiting for ${label} — ${JSON.stringify(await facts())}`);
	};

	await send('Page.enable');
	await send('Runtime.enable');

	// Sign in inside the page, so the tab carries the session the build was saved under.
	await send('Page.navigate', { url: `${ORIGIN}/dashboard` });
	await waitFor('document.readyState === "complete"', 'the dashboard');
	const signedIn = await evaluate(`(async () => {
		const res = await fetch('/api/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: ${JSON.stringify(EMAIL)}, password: ${JSON.stringify(PASSWORD)} }),
		});
		return res.status;
	})()`);
	check('signed in inside the page', signedIn === 200, `HTTP ${signedIn}`);

	await send('Page.navigate', { url: `${ORIGIN}/studio?build=lib:${buildId}` });
	await waitFor("!!document.querySelector('.editor canvas')", 'the editor canvas');

	/**
	 * The mesh queue has drained.
	 *
	 * Deliberately not "and something is on screen": an empty working set is a *result*, not
	 * a reason to keep waiting, and folding it in here would turn a camera that flew off the
	 * plot into a three-minute timeout instead of a failed check with a number beside it.
	 */
	const settle = async (label) => {
		await waitFor(`document.querySelector('.editor')?.dataset.remaining === '0'`, label);
		// One more forced frame, so `data-chunks` reflects the last upload rather than the
		// state one frame before the queue emptied.
		await frame();
		await sleep(150);
		return facts();
	};

	await waitFor(
		"Number(document.querySelector('.editor canvas')?.dataset.chunks ?? 0) > 0",
		'the first chunks of the plot',
	);
	const opened = await settle('the plot to mesh');
	check('the renderer opened a world-sized grid at all', opened !== null);
	check(
		'and knows it cannot hold it',
		opened.streaming === '1',
		`${CHUNKS.toLocaleString()} chunks, streaming=${opened.streaming}`,
	);
	check(
		'chunks near the camera are meshed',
		opened.chunks > 0,
		`${opened.chunks.toLocaleString()} resident`,
	);
	check(
		'and only a fraction of the plot is',
		opened.chunks < CHUNKS / 4,
		`${opened.chunks.toLocaleString()} of ${CHUNKS.toLocaleString()} chunks ` +
			`(${((opened.chunks / CHUNKS) * 100).toFixed(1)}%)`,
	);
	check('nothing has been evicted yet', opened.evicted === 0, `${opened.evicted}`);

	/**
	 * Move the view a fixed distance, by panning with the middle mouse button.
	 *
	 * The obvious way to move here is the editor's own WASD flight, and it is the wrong one:
	 * the keys are integrated per frame, and the number of frames a headless page runs while
	 * a key is held is whatever the compositor felt like — measured runs of the same held key
	 * moved anywhere from a hundred blocks to off the edge of the plot. A pan is a pointer
	 * delta rather than a duration, so the same drag always moves the same distance, and the
	 * test can be about eviction instead of about luck.
	 *
	 * Middle button because that is where pan now lives. It used to be the right one, until the
	 * left button was handed to the tools — a plain drag paints — and the camera took the right
	 * button for orbit and the middle for pan. Panning with the right button after that change
	 * orbits instead, so the camera never leaves home and nothing is ever evicted: this driver
	 * failed three checks that way, correctly, while the renderer was working fine.
	 */
	const pan = async (dx, dy) => {
		const rect = await evaluate(`(() => {
			const r = document.querySelector('.editor canvas').getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height };
		})()`);
		const from = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };

		await send('Input.dispatchMouseEvent', {
			type: 'mousePressed', x: from.x, y: from.y, button: 'middle', buttons: 4, clickCount: 1, pointerType: 'mouse',
		});
		for (let i = 1; i <= 8; i++) {
			await send('Input.dispatchMouseEvent', {
				type: 'mouseMoved',
				x: from.x + (dx * i) / 8,
				y: from.y + (dy * i) / 8,
				button: 'middle', buttons: 4, pointerType: 'mouse',
			});
			await sleep(20);
		}
		await send('Input.dispatchMouseEvent', {
			type: 'mouseReleased', x: from.x + dx, y: from.y + dy, button: 'middle', buttons: 0, clickCount: 1, pointerType: 'mouse',
		});

		// Damping means the pan arrives over several frames, and a static page runs none of
		// them on its own. The total is fixed; only how many frames it takes is not.
		for (let i = 0; i < 12; i++) {
			await frame();
			await sleep(40);
		}
	};

	console.log('');
	const history = [opened.chunks];
	let previous = opened;

	// Out and back, three times, over the same ground.
	//
	// A lap rather than a one-way trip because the second half is the harder case: the way
	// back re-meshes chunks that were just thrown away, so a working set that leaks a little
	// per traversal shows up as a resident count that is bigger at the end of each lap than
	// at the end of the one before. A one-way trip would never reveal that.
	//
	// The assertion is per lap, not per leg, and that is deliberate: going straight back to
	// where you just were is *supposed* to evict nothing, because the hysteresis band is
	// still holding what you left. A leg-by-leg assertion would be demanding thrash.
	for (let lap = 1; lap <= 3; lap++) {
		await pan(-PAN_PIXELS, 0);
		const out = await settle(`the working set to settle after lap ${lap} outbound`);
		await pan(PAN_PIXELS, 0);
		const back = await settle(`the working set to settle after lap ${lap} home`);
		history.push(out.chunks, back.chunks);

		check(
			`lap ${lap} threw away the ground it left behind`,
			back.evicted > previous.evicted,
			`${previous.evicted.toLocaleString()} → ${back.evicted.toLocaleString()} evicted`,
		);
		check(
			`lap ${lap} kept meshing what it moved into`,
			out.chunks > 0 && back.chunks > 0,
			`${out.chunks.toLocaleString()} out, ${back.chunks.toLocaleString()} home`,
		);
		previous = back;
	}

	// The whole point: eviction that does not keep pace with meshing is a leak with extra
	// steps, and it would show here as a resident count climbing lap after lap.
	const peak = Math.max(...history);
	check(
		'the resident set stayed bounded across every lap',
		peak < history[0] * 2.5 && peak < CHUNKS / 4,
		`${history.map((n) => n.toLocaleString()).join(' → ')} chunks (peak ${peak.toLocaleString()})`,
	);
	// The same viewpoint, three times, an eviction cycle apart. If anything were being kept
	// that should not be — a mesh left in the scene, a key left in a set — the third number
	// would be larger than the first, and no other check here would notice.
	const homes = [history[2], history[4], history[6]];
	check(
		'and coming home meshed the same set every lap rather than a bigger one',
		homes[2] <= Math.ceil(homes[0] * 1.05),
		`${homes.map((n) => n.toLocaleString()).join(' → ')} chunks at the same viewpoint`,
	);

	// Taken here rather than at the end: the last thing this drives is an ordinary build, and
	// a picture of one proves nothing about a world.
	const out = process.env.CM_STREAM_SHOT ?? 'out/verify-streaming.png';
	fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
	const shot = await send('Page.captureScreenshot', { format: 'png' });
	fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));

	// A build the engine can actually produce must not go anywhere near any of this.
	await send('Page.navigate', { url: `${ORIGIN}/studio?build=field` });
	await waitFor("!!document.querySelector('.editor canvas')", 'the stress build');
	const field = await settle('the stress build to mesh');
	check(
		'the stress build is still held whole, with nothing evicted',
		field.streaming === '0' && field.evicted === 0,
		`streaming=${field.streaming}, ${field.chunks.toLocaleString()} chunks resident, ${field.evicted} evicted`,
	);

	check('no uncaught errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

	console.log(`\nshot   ${out}`);
} catch (err) {
	console.error(`\n${err.message}`);
	failures++;
} finally {
	ws?.close();
	child?.kill();
	if (buildId) await api(`/api/builds/${buildId}`, null, 'DELETE');
	await sleep(300);
	// Edge can still hold the profile open a moment after being killed, and a failure to
	// delete a temp directory is not a failure of the thing under test.
	try {
		fs.rmSync(profile, { recursive: true, force: true });
	} catch { /* Windows will collect it */ }
}

console.log(failures === 0 ? '\nstreaming verified' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
