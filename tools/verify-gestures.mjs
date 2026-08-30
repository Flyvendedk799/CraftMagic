/**
 * Prove the pointer does what the panel says it does.
 *
 * The whole point of this change is that a plain drag paints, so the check has to be a real
 * drag through CDP's own mouse events rather than a synthetic DOM event: what is being tested
 * is the negotiation between the tool and the camera, and that lives in pointer capture and in
 * OrbitControls' button mapping, neither of which a dispatched `PointerEvent` exercises.
 *
 * Four claims, and the last two are the ones that make the first two safe:
 *
 *   1. A left-drag across the build paints, and lands as ONE undo rather than as forty.
 *   2. A left-press that does not move still places exactly one block.
 *   3. A left-drag on the SKY still orbits — pressing empty space has always meant the camera.
 *   4. A RIGHT-drag orbits even over the build, which is the way out when a large build leaves
 *      no empty space to press.
 *
 * The trap, as everywhere in this directory: headless Chrome stops compositing on a static
 * page, and the editor reports its meshing from a rAF callback, so every wait forces a frame
 * with a throwaway `captureScreenshot`. `requestAnimationFrame` from the driver hangs outright.
 *
 *   node tools/verify-gestures.mjs [origin]
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
const port = 9300 + (process.pid % 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-gest-'));
const child = spawn(
	EDGE,
	[
		'--headless=new', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
		'--hide-scrollbars', '--window-size=1280,900',
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

	const meshed = () => waitFor("document.querySelector('.editor')?.dataset.remaining === '0'", 'meshing', 60_000);
	const edits = () => evaluate("Number(document.querySelector('.editor').dataset.edits)");
	const blocks = () =>
		evaluate("Number([...document.querySelectorAll('.hud__stats dd')][2]?.textContent.replace(/[^0-9]/g, '') ?? 0)");

	/**
	 * A hash of what the viewport is actually showing.
	 *
	 * Asking the camera would mean exposing it on the page for the benefit of a test; asking the
	 * pixels asks the real question — did the view move — and needs nothing from the product.
	 * The pointer is parked over the panel first, because the hover highlight follows it and
	 * would otherwise make every capture differ for a reason that has nothing to do with orbit.
	 */
	const viewHash = async () => {
		await moveTo(160, 400);
		await frame();
		await sleep(250);
		const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 40 });
		const data = shot.result?.data ?? '';
		let hash = 0;
		for (let i = 0; i < data.length; i++) hash = (hash * 31 + data.charCodeAt(i)) | 0;
		return hash;
	};

	const button = (kind) => ({ left: 'left', right: 'right', middle: 'middle' })[kind];

	const press = (x, y, kind = 'left') =>
		send('Input.dispatchMouseEvent', {
			type: 'mousePressed', x, y, button: button(kind), buttons: kind === 'right' ? 2 : 1,
			clickCount: 1, pointerType: 'mouse',
		});
	const release = (x, y, kind = 'left') =>
		send('Input.dispatchMouseEvent', {
			type: 'mouseReleased', x, y, button: button(kind), buttons: 0, clickCount: 1, pointerType: 'mouse',
		});
	const moveTo = (x, y, kind) =>
		send('Input.dispatchMouseEvent', {
			type: 'mouseMoved', x, y,
			button: kind ? button(kind) : 'none',
			buttons: kind === 'right' ? 2 : kind ? 1 : 0,
			pointerType: 'mouse',
		});

	const drag = async (from, to, kind = 'left', steps = 10) => {
		await moveTo(from.x, from.y);
		await frame();
		await sleep(100);
		await press(from.x, from.y, kind);
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			await moveTo(Math.round(from.x + (to.x - from.x) * t), Math.round(from.y + (to.y - from.y) * t), kind);
			await sleep(30);
		}
		await release(to.x, to.y, kind);
		await frame();
		await sleep(300);
	};

	const useTool = async (toolId) => {
		const ok = await evaluate(
			`(() => { const b = document.querySelector('.tools__tool[data-tool=${JSON.stringify(toolId)}]');` +
				` if (b) b.click(); return !!b; })()`,
		);
		await sleep(150);
		return ok;
	};

	const openSection = (title) =>
		evaluate(`(() => {
			const head = [...document.querySelectorAll('.section__head')].find((h) => h.textContent.includes(${JSON.stringify(title)}));
			if (!head) return false;
			if (head.getAttribute('aria-expanded') !== 'true') head.click();
			return true;
		})()`);

	// --- open a build ------------------------------------------------------------------------
	await send('Page.navigate', { url: `${ORIGIN}/studio?build=cottage` });
	await waitFor("!!document.querySelector('.editor')", 'the editor');
	await meshed();
	await evaluate(openSection('Details'));
	await sleep(600);

	check('the tools are grouped, not a flat row', (await evaluate("document.querySelectorAll('.tools__group').length")) === 3);
	check('all nine are still offered', (await evaluate("document.querySelectorAll('.tools__tool').length")) === 9);
	check(
		'the build menu names what is open',
		(await evaluate("document.querySelector('.buildmenu__name')?.textContent")) === 'Cottage',
	);

	// A point on the build, and a point that is definitely sky.
	const findOnBuild = async () => {
		for (const [dx, dy] of [[0, 40], [0, 0], [-60, 20], [60, 20], [0, 80], [-40, -20], [40, -20]]) {
			const x = Math.round(640 + dx);
			const y = Math.round(450 + dy);
			await moveTo(x, y);
			await frame();
			await sleep(120);
			const block = await evaluate("document.querySelector('.hover-readout strong')?.textContent ?? null");
			if (block && block !== 'Air') return { x, y, block };
		}
		return null;
	};

	const onBuild = await findOnBuild();
	if (!onBuild) throw new Error('could not find a point over the build');
	const sky = { x: 1120, y: 180 };

	// --- 1. a plain drag paints, as one undo -------------------------------------------------
	check('Place is selectable', await useTool('place'));
	const beforeBlocks = await blocks();
	const beforeEdits = await edits();
	await drag(onBuild, { x: onBuild.x + 70, y: onBuild.y });
	await meshed();
	const afterBlocks = await blocks();
	const afterEdits = await edits();

	check(
		'a plain left-drag paints without Shift',
		afterBlocks > beforeBlocks + 1,
		`${beforeBlocks} → ${afterBlocks} blocks`,
	);
	check(
		'and every cell it crossed is in the edit overlay',
		afterEdits - beforeEdits > 1,
		`${beforeEdits} → ${afterEdits} cells`,
	);

	// One Ctrl+Z, not forty: the drag is a single history entry.
	for (const type of ['keyDown', 'keyUp']) {
		await send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
	}
	await sleep(300);
	await meshed();
	check(
		'and one undo takes the whole stroke back',
		(await blocks()) === beforeBlocks,
		`${afterBlocks} → ${await blocks()}, expected ${beforeBlocks}`,
	);

	// --- 2. a press that does not move is still one block ------------------------------------
	const beforeClick = await blocks();
	await moveTo(onBuild.x, onBuild.y);
	await frame();
	await sleep(150);
	await press(onBuild.x, onBuild.y);
	await release(onBuild.x, onBuild.y);
	await frame();
	await sleep(400);
	await meshed();
	check(
		'a click that does not move still places exactly one',
		(await blocks()) === beforeClick + 1,
		`${beforeClick} → ${await blocks()}`,
	);

	// --- 3. the sky still belongs to the camera ----------------------------------------------
	const beforeSky = await blocks();
	const camBeforeSky = await viewHash();
	await drag(sky, { x: sky.x - 120, y: sky.y + 40 });
	await sleep(400);
	check('dragging the sky adds no blocks', (await blocks()) === beforeSky, `${beforeSky} → ${await blocks()}`);
	check('and it orbits the camera', (await viewHash()) !== camBeforeSky);

	// --- 4. right-drag orbits even over the build --------------------------------------------
	const beforeRight = await blocks();
	const camBeforeRight = await viewHash();
	await drag(onBuild, { x: onBuild.x - 90, y: onBuild.y + 30 }, 'right');
	await sleep(400);
	check(
		'a right-drag over the build edits nothing',
		(await blocks()) === beforeRight,
		`${beforeRight} → ${await blocks()}`,
	);
	check('and orbits instead — the way out when the build fills the screen', (await viewHash()) !== camBeforeRight);

	check('no uncaught errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

	const out = process.env.CM_GESTURE_SHOT ?? 'out/verify-gestures.png';
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
		// Windows holds the profile open a moment after the browser exits; a leftover temp
		// directory is not a test result.
	}
}

console.log(failures === 0 ? '\ngestures verified' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
