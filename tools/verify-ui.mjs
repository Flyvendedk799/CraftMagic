/**
 * Free UI checks — no model call.
 *
 * Seeds sessionStorage with a program generated earlier, reloads, and confirms the build is
 * restored and the HUD stays within its bounds even with a long warning on screen. Both are
 * things that only break in a real browser.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const programFile = process.argv[2] ?? 'out/stone-watchtower.program.json';
const outFile = process.argv[3] ?? 'ui-restored.png';
const ORIGIN = process.env.CM_ORIGIN ?? 'http://localhost:3016';

const EDGE = [
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const program = JSON.parse(fs.readFileSync(programFile, 'utf8'));
const port = 9700 + (process.pid % 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-verify-'));
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

let exitCode = 0;
try {
	let wsUrl;
	for (let i = 0; i < 60 && !wsUrl; i++) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			wsUrl = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
		} catch { /* starting */ }
		if (!wsUrl) await sleep(250);
	}
	if (!wsUrl) throw new Error('devtools never came up');

	const socket = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', () => reject(new Error('socket failed')), { once: true });
	});

	const send = cdp(socket);
	await send('Page.enable');
	await send('Runtime.enable');

	const evaluate = async (expression) => {
		const { result, exceptionDetails } = await send('Runtime.evaluate', {
			expression, returnByValue: true, awaitPromise: true,
		});
		if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluate failed');
		return result.value;
	};
	const waitFor = async (expr, label, ms) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (await evaluate(expr)) return;
			await sleep(300);
		}
		throw new Error(`timed out waiting for ${label}`);
	};

	await send('Page.navigate', { url: `${ORIGIN}/?build=cottage` });
	await waitFor("document.querySelector('.editor')?.dataset.remaining === '0'", 'first load', 60_000);

	// Seed a generated build, then reload — the restore path is what we are testing.
	await evaluate(
		// localStorage, not sessionStorage. Generated builds moved when it turned out that a
		// link-opened tab starts with an empty session store in Chromium, so every generated
		// build's guide came out as the cottage. Seeding the old store left this report
		// describing a restored generation it had never actually restored.
		`localStorage.setItem('craftmagic.generated', ${JSON.stringify(
			JSON.stringify([['gen:1', program]]),
		)}), true`,
	);
	await send('Page.navigate', { url: `${ORIGIN}/?build=gen:1` });
	await waitFor("document.querySelector('.editor')?.dataset.remaining === '0'", 'restored build', 60_000);
	await sleep(700);

	// The HUD collapses into sections now and several start closed, so the stats and the
	// generate button are not on screen until they are opened — which this report read as
	// "size / blocks undefined" and "picker button MISSING", describing a working editor as a
	// broken one. A driver has to open what it needs, exactly as a person would.
	await evaluate(`(() => {
		for (const title of ['Details', 'Build', 'Generate']) {
			const head = [...document.querySelectorAll('.section__head')]
				.find((h) => h.textContent.includes(title));
			if (head && head.getAttribute('aria-expanded') !== 'true') head.click();
		}
		return true;
	})()`);
	await sleep(400);

	const restored = await evaluate(`
		(() => {
			const dd = [...document.querySelectorAll('.hud__stats dd')].map((n) => n.textContent);
			const hud = document.querySelector('.hud--top');
			return {
				build: document.querySelector('.editor').dataset.build,
				name: dd[0], size: dd[1], blocks: dd[2],
				// The generated build now lives in the build menu rather than in a wall of buttons,
				// so the question is whether the menu knows about it — the ✦ prefix that used to
				// mark it apart went away with the wall.
				restoredButton:
					document.querySelector('.buildmenu__name')?.textContent === 'Stone Watchtower',
				params: document.querySelectorAll('.param').length,
				hudWidth: Math.round(hud.getBoundingClientRect().width),
				viewportWidth: window.innerWidth,
			};
		})()
	`);

	// Force a very long warning into the panel to prove the width cap holds.
	const stretched = await evaluate(`
		(() => {
			const hud = document.querySelector('.hud--top');
			const p = document.createElement('p');
			p.className = 'hud__generated';
			p.textContent = 'x'.repeat(400);
			hud.appendChild(p);
			return Math.round(hud.getBoundingClientRect().width);
		})()
	`);

	const shot = await send('Page.captureScreenshot', { format: 'png' });
	fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
	fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));

	console.log('--- restored from localStorage ---');
	console.log(`build          ${restored.build}`);
	console.log(`name           ${restored.name}`);
	console.log(`size / blocks  ${restored.size} / ${restored.blocks}`);
	console.log(`build menu     ${restored.restoredButton ? 'names the restored build' : 'WRONG BUILD'}`);
	console.log(`param sliders  ${restored.params}`);
	console.log(`hud width      ${restored.hudWidth}px of ${restored.viewportWidth}px viewport`);
	console.log(`with 400 chars ${stretched}px  ${stretched === restored.hudWidth ? '(unchanged — cap holds)' : '(GREW — cap failed)'}`);
	console.log(`shot           ${outFile}`);

	if (!restored.restoredButton) exitCode = 1;
	if (stretched !== restored.hudWidth) exitCode = 1;

	socket.close();
} catch (err) {
	console.error(err.message);
	exitCode = 1;
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

process.exitCode = exitCode;
