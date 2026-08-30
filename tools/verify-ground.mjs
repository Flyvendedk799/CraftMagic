/**
 * The empty plot is buildable — checked by actually clicking it.
 *
 * The unit tests cover `raycastVoxel`'s ground fallback and `placementCell`'s handling of a
 * ground hit, and neither of them can catch the failure that mattered: an empty build framed
 * on the middle of its own volume puts the floor in a strip along the bottom edge, so the
 * pointer never meets it and the plot looks like one that ignores clicks. That is a fact
 * about the camera, the projection and the size of the viewport together, and the only way
 * to check it is to open the page, click where a person would click, and see whether a block
 * appears.
 *
 *   node tools/verify-ground.mjs [origin]
 *
 * Free — no account, no model call. `?build=empty` is a bundled program.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGIN = process.argv[2] ?? process.env.CM_ORIGIN ?? 'http://localhost:3016';
const outFile = process.argv[3] ?? 'out/ground.png';

const EDGE = [
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) {
	console.error('Edge not found.');
	process.exit(1);
}

const port = 9300 + (process.pid % 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-ground-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(
	EDGE,
	[
		'--headless=new', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
		'--hide-scrollbars', '--window-size=1280,900',
		`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
	],
	{ stdio: 'ignore' },
);

function cdp(socket) {
	let nextId = 1;
	const pending = new Map();
	socket.addEventListener('message', (event) => {
		const msg = JSON.parse(event.data);
		const waiter = pending.get(msg.id);
		if (!waiter) return;
		pending.delete(msg.id);
		if (msg.error) waiter.reject(new Error(msg.error.message));
		else waiter.resolve(msg.result);
	});
	return (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params }));
		});
}

let failures = 0;
const check = (label, ok, detail = '') => {
	if (!ok) failures++;
	console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
};

try {
	let wsUrl;
	for (let i = 0; i < 60 && !wsUrl; i++) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			wsUrl = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
		} catch {
			// Browser still starting.
		}
		if (!wsUrl) await sleep(250);
	}
	if (!wsUrl) throw new Error('devtools endpoint never came up');

	const socket = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
	});

	const send = cdp(socket);
	await send('Page.enable');
	await send('Runtime.enable');
	const evaluate = async (expression) =>
		(await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;

	await send('Page.navigate', { url: `${ORIGIN}/editor?build=empty` });
	for (let i = 0; i < 120; i++) {
		if ((await evaluate("document.querySelector('.editor')?.dataset.remaining")) === '0') break;
		await sleep(300);
	}
	check('the empty plot renders', (await evaluate("document.querySelector('.editor')?.dataset.remaining")) === '0');
	check('the app bar is on the editor too', await evaluate("!!document.querySelector('.editor > .nav')"));
	await sleep(600);

	// Dead centre of the canvas — where someone opening an empty plot clicks first, and the
	// reason the camera has to be aimed at the floor rather than at mid-height.
	const point = JSON.parse(
		await evaluate(`
			(() => {
				const r = document.querySelector('.editor__canvas canvas').getBoundingClientRect();
				return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
			})()
		`),
	);

	const before = await evaluate("document.querySelector('.editor').dataset.edits");

	await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 });
	await sleep(300);
	const readout = await evaluate("document.querySelector('.hover-readout')?.textContent ?? ''");
	check('hovering the middle of an empty plot finds the ground', readout.includes('Ground'), readout.trim());

	await send('Input.dispatchMouseEvent', { ...point, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 });
	await sleep(120);
	await send('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 });
	await sleep(900);

	const after = await evaluate("document.querySelector('.editor').dataset.edits");
	check('clicking it places a block', Number(after) === Number(before) + 1, `${before} → ${after} edits`);

	// The block count lives in the HUD's "Details" section, which is collapsed by default.
	await evaluate(`
		(() => {
			const head = [...document.querySelectorAll('.section__head')]
				.find((h) => h.textContent.includes('Details'));
			if (head && head.getAttribute('aria-expanded') !== 'true') head.click();
			return true;
		})()
	`);
	await sleep(200);

	const blocks = await evaluate(`
		(() => {
			const dt = [...document.querySelectorAll('.hud__stats dt')];
			const i = dt.findIndex((n) => n.textContent === 'Blocks');
			return i < 0 ? null : [...document.querySelectorAll('.hud__stats dd')][i].textContent;
		})()
	`);
	check('the build now holds exactly one block', Number(String(blocks).replace(/[^0-9]/g, '')) === 1, String(blocks));

	// The floor is only under the build's own footprint. Clicking well outside it must stay a
	// miss, or the bounds stop meaning anything.
	const outside = JSON.parse(
		await evaluate(`
			(() => {
				const r = document.querySelector('.editor__canvas canvas').getBoundingClientRect();
				return JSON.stringify({ x: r.x + r.width - 8, y: r.y + r.height - 8 });
			})()
		`),
	);
	const edits = await evaluate("document.querySelector('.editor').dataset.edits");
	await send('Input.dispatchMouseEvent', { ...outside, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 });
	await sleep(120);
	await send('Input.dispatchMouseEvent', { ...outside, type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 });
	await sleep(600);
	check(
		'the ground outside the build bounds is not buildable',
		(await evaluate("document.querySelector('.editor').dataset.edits")) === edits,
	);

	const shot = await send('Page.captureScreenshot', { format: 'png' });
	fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
	fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
	console.log(`\nshot   ${outFile}  ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB`);

	socket.close();
} catch (err) {
	console.error(String(err));
	failures++;
} finally {
	child.kill();
	await sleep(300);
	try {
		fs.rmSync(profile, { recursive: true, force: true });
	} catch {
		// Windows holds the browser profile open for a moment after the process exits, and the
		// rm throws EPERM rather than waiting. A temp directory outliving the run by a few
		// hundred milliseconds is not a test result, and letting it escape turns a green run
		// into a non-zero exit with a stack trace where the summary should be.
	}
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
