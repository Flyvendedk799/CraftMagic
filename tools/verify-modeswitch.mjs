/**
 * Prove the studio does not eat your last edit when you change mode.
 *
 * `StudioPage` mounts a mode through `MODE_PAGES[mode]`, so flipping the pill *unmounts* the
 * page. All three modes autosave on a debounce; only Build ever flushed that debounce on the
 * way out. Architecture and World both carried a comment claiming they did — "cleared on
 * unmount so a page that is navigated away from mid-drag still gets its last state out" — over
 * a `clearTimeout`, which cancels the pending write rather than performing it. Anything drawn
 * in the last 500–600 ms before a mode switch was gone.
 *
 * The window is the whole point, so the test has to be inside it: edit, switch **immediately**,
 * switch back, and look. A driver that paused first would pass against the bug.
 *
 * The usual trap applies — headless Chrome stops compositing on a static page and the editor
 * reports meshing from a rAF callback, so every wait forces a frame with a throwaway
 * `captureScreenshot`.
 *
 *   node tools/verify-modeswitch.mjs [origin]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGIN = (process.argv[2] ?? process.env.CM_ORIGIN ?? 'http://localhost:3016').replace(/\/+$/, '');

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures++;
};

const EDGE = [
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) {
	console.error('Edge not found.');
	process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9700 + (process.pid % 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-switch-'));
const child = spawn(
	EDGE,
	[
		'--headless=new', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
		'--hide-scrollbars', '--window-size=1400,900',
		`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
	],
	{ stdio: 'ignore' },
);

let ws;
let id = 0;
const waiters = new Map();
const pageErrors = [];

try {
	let target;
	for (let i = 0; i < 60 && !target; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/list`);
			target = (await res.json()).find((t) => t.type === 'page');
		} catch {}
		if (!target) await sleep(250);
	}
	if (!target) throw new Error('no debuggable page');

	ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
	await new Promise((r) => ws.addEventListener('open', r));
	ws.addEventListener('message', (event) => {
		const message = JSON.parse(event.data);
		if (waiters.has(message.id)) {
			waiters.get(message.id)(message);
			waiters.delete(message.id);
		}
		if (message.method === 'Runtime.exceptionThrown') {
			const d = message.params.exceptionDetails;
			pageErrors.push((d.exception?.description ?? d.text).slice(0, 200));
		}
	});

	const send = (method, params = {}) =>
		new Promise((resolve) => {
			const next = ++id;
			waiters.set(next, resolve);
			ws.send(JSON.stringify({ id: next, method, params }));
		});
	const evaluate = async (expression) =>
		(await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))
			.result?.result?.value;
	const frame = () => send('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
	const waitFor = async (expression, label, ms = 30_000) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (await evaluate(expression)) return true;
			await frame();
			await sleep(120);
		}
		throw new Error(`timed out waiting for ${label}`);
	};

	await send('Page.enable');
	await send('Runtime.enable');

	/** Click a mode pill by its label and wait for the page under it. */
	const toMode = async (label, ready) => {
		const clicked = await evaluate(
			`(() => { const b = [...document.querySelectorAll('.studio__switch button')]` +
				`.find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`,
		);
		if (!clicked) throw new Error(`no mode pill labelled ${label}`);
		await waitFor(ready, `${label} to mount`);
	};

	const moveTo = (x, y, kind) =>
		send('Input.dispatchMouseEvent', {
			type: 'mouseMoved', x, y, button: kind ?? 'none', buttons: kind ? 1 : 0, pointerType: 'mouse',
		});

	const drag = async (from, to, steps = 6) => {
		await moveTo(from.x, from.y);
		await send('Input.dispatchMouseEvent', {
			type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse',
		});
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			await moveTo(Math.round(from.x + (to.x - from.x) * t), Math.round(from.y + (to.y - from.y) * t), 'left');
			await sleep(25);
		}
		await send('Input.dispatchMouseEvent', {
			type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse',
		});
		await frame();
	};

	const box = (selector) =>
		evaluate(`(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height };
		})()`);

	// --- World: sculpt, switch away instantly, come back ------------------------------------
	await send('Page.navigate', { url: `${ORIGIN}/studio?mode=world` });
	await waitFor("!!document.querySelector('.worldmap')", 'the world map');
	await sleep(900);

	const map = await box('.worldmap');
	if (!map) throw new Error('the world map has no box');
	const centre = { x: map.x + map.w / 2, y: map.y + map.h / 2 };

	const hover = async (x, y) => {
		await moveTo(x, y);
		await frame();
		await sleep(120);
	};
	const groundAt = async () => {
		await hover(centre.x, centre.y);
		const raw = await evaluate("document.querySelector('.world')?.dataset.hoverHeight ?? null");
		return raw === null ? null : Number(raw);
	};

	const before = await groundAt();
	check('the world map reports a column', before !== null, `y ${before}`);

	// Raise is the default tool, so this is a sculpt with no setup.
	await drag({ x: centre.x - map.w * 0.12, y: centre.y }, centre);
	const raised = await groundAt();
	check('sculpting raises the ground', raised !== null && raised > before, `${before} → ${raised}`);

	// Immediately — inside the 600 ms autosave debounce, which is the whole point.
	await toMode('Build', "!!document.querySelector('.editor')");
	await toMode('World', "!!document.querySelector('.worldmap')");
	await sleep(900);

	check(
		'a mode switch inside the autosave window keeps the sculpt',
		(await groundAt()) === raised,
		`${await groundAt()} vs ${raised}`,
	);

	// --- Architecture: draw a room, switch away instantly, come back --------------------------
	await toMode('Architecture', "!!document.querySelector('.arch')");
	await sleep(700);

	const rooms = () => evaluate("document.querySelectorAll('.plan__room-fill').length");
	const startRooms = await rooms();

	// Room is the second tool on Architecture's number row.
	await evaluate(
		"(() => { const b = document.querySelector('.tool-rail button[data-tool=\"room\"]'); if (b) b.click(); return !!b; })()",
	);
	await sleep(200);

	const plan = await box('.plan');
	if (plan) {
		await drag(
			{ x: plan.x + plan.w * 0.35, y: plan.y + plan.h * 0.35 },
			{ x: plan.x + plan.w * 0.6, y: plan.y + plan.h * 0.6 },
		);
		await sleep(250);
		const drawn = await rooms();
		check('drawing adds a room', drawn > startRooms, `${startRooms} → ${drawn}`);

		await toMode('Build', "!!document.querySelector('.editor')");
		await toMode('Architecture', "!!document.querySelector('.arch')");
		await sleep(900);

		check(
			'a mode switch inside the autosave window keeps the room',
			(await rooms()) === drawn,
			`${await rooms()} vs ${drawn}`,
		);
	} else {
		console.log('  skip  Architecture plan surface not found — room check not run');
	}

	check('no uncaught errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

	const out = process.env.CM_SWITCH_SHOT ?? 'out/verify-modeswitch.png';
	const shot = await send('Page.captureScreenshot', { format: 'png' });
	fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
	fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
	console.log(`\nshot   ${out}`);
} catch (err) {
	console.error(`\n${err.stack ?? err.message}`);
	failures++;
} finally {
	ws?.close();
	child.kill();
	await sleep(300);
	try {
		fs.rmSync(profile, { recursive: true, force: true });
	} catch {
		// Windows holds the profile open a moment after the browser exits.
	}
}

console.log(failures === 0 ? '\nmode switch verified' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
