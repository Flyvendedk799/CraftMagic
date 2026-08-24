/**
 * Screenshot a page once it has actually finished rendering.
 *
 * `--screenshot --virtual-time-budget` is not usable here: meshing happens on a worker
 * thread, so virtual time runs out while the main thread sits idle waiting, and the capture
 * lands on an empty scene. This drives Edge over CDP instead and waits for a readiness
 * signal from the page itself.
 *
 *   node tools/shot.mjs <url> <output.png> [readySelector] [readyAttr] [readyValue]
 *
 * Defaults wait for `[data-remaining="0"]`, which the editor sets when every chunk is meshed.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [url, outFile, selector = '.editor', attr = 'data-remaining', want = '0'] = process.argv.slice(2);
if (!url || !outFile) {
	console.error('usage: node tools/shot.mjs <url> <output.png> [selector] [attr] [value]');
	process.exit(1);
}

const EDGE_CANDIDATES = [
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!edge) {
	console.error('Edge not found. Looked in:\n  ' + EDGE_CANDIDATES.join('\n  '));
	process.exit(1);
}

const port = 9222 + Math.floor(process.pid % 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-shot-'));

const child = spawn(
	edge,
	[
		'--headless=new',
		'--disable-gpu',
		'--use-gl=swiftshader',
		'--enable-unsafe-swiftshader',
		'--hide-scrollbars',
		'--window-size=1280,900',
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		'about:blank',
	],
	{ stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
	for (let i = 0; i < 60; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/list`);
			const targets = await res.json();
			const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
			if (page) return page.webSocketDebuggerUrl;
		} catch {
			// Browser still starting.
		}
		await sleep(250);
	}
	throw new Error('devtools endpoint never came up');
}

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

let exitCode = 0;
try {
	const wsUrl = await findTarget();
	const socket = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
	});

	const send = cdp(socket);
	await send('Page.enable');
	await send('Runtime.enable');
	await send('Page.navigate', { url });

	// Poll the page for its own readiness flag rather than guessing a delay.
	const deadline = Date.now() + 60_000;
	let ready = false;
	let lastSeen = '(none)';
	while (Date.now() < deadline) {
		const { result } = await send('Runtime.evaluate', {
			expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? String(el.getAttribute(${JSON.stringify(attr)})) : null; })()`,
			returnByValue: true,
		});
		lastSeen = result.value ?? '(no element)';
		if (lastSeen === want) {
			ready = true;
			break;
		}
		await sleep(300);
	}

	if (!ready) {
		console.error(`timed out waiting for ${selector}[${attr}="${want}"] — last saw "${lastSeen}"`);
		exitCode = 1;
	}

	// One more frame so the newly uploaded geometry is actually painted.
	await sleep(600);

	const shot = await send('Page.captureScreenshot', { format: 'png' });
	fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
	fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
	console.log(`${outFile}  ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB  (${attr}=${lastSeen})`);

	socket.close();
} catch (err) {
	console.error(String(err));
	exitCode = 1;
} finally {
	child.kill();
	await sleep(300);
	fs.rmSync(profile, { recursive: true, force: true });
}

process.exit(exitCode);
