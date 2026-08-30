/**
 * Prove World mode is an editor and not a diagram.
 *
 * Every check here is a gesture followed by a measurement, because the failure mode this
 * guards against is a terrain tool that draws a brush ring and changes nothing — a map that
 * looks alive and is inert. So the driver raises actual ground and reads the height back, paints
 * a material and reads the material back, carves and watches the region's block count fall.
 *
 * Two traps are already paid for here, both learned the hard way in this repo:
 *
 *   * Headless Chrome stops compositing once a page is visually static, and anything that
 *     reports from a `requestAnimationFrame` callback then never reports at all. Every wait
 *     forces a frame with a throwaway `captureScreenshot`. `requestAnimationFrame` from the
 *     driver side hangs outright.
 *   * The terrain is mutated in place and React is told by a revision counter, so nothing can
 *     be asserted by identity. The page publishes what a test needs as `data-` attributes on
 *     `.world`, exactly as the editor publishes `data-remaining`.
 *
 * Pointer input goes through CDP's own mouse events rather than synthetic DOM events, so what
 * is exercised is the real pointer path — capture, interpolation and all.
 *
 *   node tools/verify-world.mjs [origin]
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

// --- seed a component, so the parts bin has something in it ------------------------------
//
// Signed out, the shelf correctly says there is nothing to place, and a driver that only
// ever ran signed out would leave the headline feature — putting a saved build on sculpted
// ground — with no coverage at all.

const EMAIL = `world-${Date.now()}@craftmagic.test`;
const PASSWORD = 'verify-world-password';

const { expand, samples } = await import('@craftmagic/core');

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
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

let auth = await api('/api/auth/register', { email: EMAIL, password: PASSWORD });
if (auth.status >= 400) auth = await api('/api/auth/login', { email: EMAIL, password: PASSWORD });
const signedIn = auth.status < 400;

let componentName = null;
if (signedIn) {
	const program = samples.cottage ?? Object.values(samples)[0];
	const result = expand(program);
	componentName = `verify-world-${Date.now()}`;
	const saved = await api('/api/builds', {
		name: componentName,
		library: true,
		detached: false,
		kind: 'structure',
		program,
		grid: {
			size: result.grid.size,
			palette: result.grid.palette,
			voxels: Array.from(result.grid.voxels),
		},
	});
	if (!saved.body?.id) componentName = null;
}

const port = 9600 + (process.pid % 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-world-'));
const child = spawn(
	EDGE,
	[
		'--headless=new', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
		'--hide-scrollbars', '--window-size=1600,1000',
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
	const waitFor = async (expression, label, ms = 30_000) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (await evaluate(expression)) return true;
			await send('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
			await sleep(150);
		}
		throw new Error(`timed out waiting for ${label}`);
	};

	await send('Page.enable');
	await send('Runtime.enable');

	/** A `data-` fact from the page root, as a number. */
	const fact = async (name) => {
		const raw = await evaluate(`document.querySelector('.world')?.dataset[${JSON.stringify(name)}] ?? null`);
		return raw === null || raw === '' ? null : Number(raw);
	};

	/** Where the map is on screen, so a gesture can be aimed at a column rather than a pixel. */
	const mapBox = () =>
		evaluate(`(() => {
			const el = document.querySelector('.worldmap');
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: r.x, y: r.y, w: r.width, h: r.height };
		})()`);

	const mouse = (type, x, y, extra = {}) =>
		send('Input.dispatchMouseEvent', {
			type, x, y, button: 'left', buttons: type === 'mouseMoved' && extra.down ? 1 : type === 'mouseReleased' ? 0 : 1,
			clickCount: 1, pointerType: 'mouse',
		});

	/** Move the pointer without pressing — the hover path that fills the readout. */
	const hover = async (x, y) => {
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });
		await send('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
		await sleep(120);
	};

	/** A press, a few moves and a release — one stroke, the way a person drags. */
	const drag = async (from, to, steps = 6) => {
		await mouse('mousePressed', from.x, from.y);
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			await send('Input.dispatchMouseEvent', {
				type: 'mouseMoved',
				x: from.x + (to.x - from.x) * t,
				y: from.y + (to.y - from.y) * t,
				buttons: 1, button: 'left', pointerType: 'mouse',
			});
			await sleep(25);
		}
		await mouse('mouseReleased', to.x, to.y);
		await send('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
		await sleep(200);
	};

	const clickTool = async (label) => {
		const ok = await evaluate(
			`(() => { const b = [...document.querySelectorAll('.world__tool')]` +
				`.find((x) => x.textContent.includes(${JSON.stringify(label)})); if (b) b.click(); return !!b; })()`,
		);
		await sleep(150);
		return ok;
	};

	// --- the page is an editor -------------------------------------------------------------
	await send('Page.navigate', { url: `${ORIGIN}/studio?mode=world` });
	await waitFor("!!document.querySelector('.worldmap')", 'the world map');
	await sleep(900);

	check('World mode mounts a map', (await evaluate("!!document.querySelector('.worldmap')")) === true);
	check(
		'both docks are there — tools on one side, parts on the other',
		(await evaluate("document.querySelectorAll('.world__dock').length")) === 2,
	);
	check(
		'every terrain tool is offered',
		(await evaluate("document.querySelectorAll('.world__tool').length")) === 9,
		String(await evaluate("document.querySelectorAll('.world__tool').length")),
	);
	check(
		'the plot has columns',
		(await fact('columns')) > 0,
		`${await fact('columns')} columns`,
	);

	const box = await mapBox();
	if (!box) throw new Error('the map has no box');
	const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
	const left = { x: centre.x - box.w * 0.15, y: centre.y };

	// --- the Leveler actually moves ground ---------------------------------------------------
	await hover(centre.x, centre.y);
	const groundBefore = await fact('hoverHeight');
	check('hovering the map reports a column', groundBefore !== null, `y ${groundBefore}`);

	check('Raise is selectable', await clickTool('Raise'));
	await drag(left, centre);
	await hover(centre.x, centre.y);
	const groundRaised = await fact('hoverHeight');
	check(
		'dragging with Raise lifts the ground',
		groundRaised !== null && groundBefore !== null && groundRaised > groundBefore,
		`${groundBefore} → ${groundRaised}`,
	);
	check('the stroke is one undo, not forty', (await fact('history')) === 1, `${await fact('history')} entries`);

	// --- undo puts it back exactly -------------------------------------------------------------
	await evaluate("document.querySelector('.world__stage-bar button').click()");
	await sleep(300);
	await hover(centre.x, centre.y);
	check(
		'undo restores the ground it was raised from',
		(await fact('hoverHeight')) === groundBefore,
		`${await fact('hoverHeight')} vs ${groundBefore}`,
	);

	// Put the hill back — the rest of the checks want terrain that is not flat.
	await evaluate("document.querySelectorAll('.world__stage-bar button')[1].click()");
	await sleep(300);
	await hover(centre.x, centre.y);
	check('redo brings the hill back', (await fact('hoverHeight')) === groundRaised);

	// --- Lower is not just Raise with a different label -----------------------------------------
	check('Lower is selectable', await clickTool('Lower'));
	await drag(left, centre);
	await hover(centre.x, centre.y);
	const lowered = await fact('hoverHeight');
	check(
		'dragging with Lower pushes the ground down',
		lowered !== null && groundRaised !== null && lowered < groundRaised,
		`${groundRaised} → ${lowered}`,
	);

	// --- the Terrainer paints material ------------------------------------------------------
	check('Terrainer is selectable', await clickTool('Terrainer'));
	const stratumBefore = await fact('hoverStratum');
	const picked = await evaluate(
		"(() => { const b = document.querySelectorAll('.world__stratum')[2]; if (b) b.click(); return !!b; })()",
	);
	check('the ground palette offers materials to pick', picked === true);
	await drag(left, centre);
	await hover(centre.x, centre.y);
	check(
		'painting changes the ground material under the brush',
		(await fact('hoverStratum')) !== stratumBefore,
		`${stratumBefore} → ${await fact('hoverStratum')}`,
	);

	// --- the 3D check is a real region ---------------------------------------------------------
	await waitFor("!!document.querySelector('.world__preview[data-blocks]')", 'the 3D preview');
	const previewBlocks = Number(
		await evaluate("document.querySelector('.world__preview')?.dataset.blocks ?? '0'"),
	);
	check('the 3D view materialises a region with blocks in it', previewBlocks > 0, `${previewBlocks} blocks`);

	// --- Carve hollows it out --------------------------------------------------------------------
	check('Carve is selectable', await clickTool('Carve'));
	await drag(left, centre);
	await sleep(600);
	const carvedBlocks = Number(
		await evaluate("document.querySelector('.world__preview')?.dataset.blocks ?? '0'"),
	);
	check(
		'carving removes blocks from the materialised region',
		carvedBlocks < previewBlocks,
		`${previewBlocks} → ${carvedBlocks}`,
	);

	// --- it survives a reload ----------------------------------------------------------------------
	const before = { height: await fact('hoverHeight'), stratum: await fact('hoverStratum') };
	// The draft autosave is debounced; a reload inside the window would prove nothing.
	// Wait for the draft to be on disk rather than sleeping and hoping. The autosave is
	// debounced, so a fixed sleep is a guess — and it was wrong roughly one run in four, which
	// is the worst rate for a check to fail at.
	await waitFor(
		"(() => { const d = document.querySelector('.world').dataset; return d.draft === d.revision; })()",
		'the draft to be written',
	);
	await send('Page.navigate', { url: `${ORIGIN}/studio?mode=world` });
	await waitFor("!!document.querySelector('.worldmap')", 'the map after a reload');
	await sleep(1200);
	await hover(centre.x, centre.y);
	check(
		'the sculpted terrain survives a reload',
		(await fact('hoverHeight')) === before.height && (await fact('hoverStratum')) === before.stratum,
		`y ${await fact('hoverHeight')} / ground ${await fact('hoverStratum')} vs y ${before.height} / ground ${before.stratum}`,
	);
	check('and the history starts clean rather than restoring somebody else’s undos', (await fact('history')) === 0);

	// --- a saved build, placed on the ground -------------------------------------------------
	if (!componentName) {
		console.log('  skip  placing a component — could not seed a library on this server');
	} else {
		await evaluate(
			`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(
				JSON.stringify({ email: EMAIL, password: PASSWORD }),
			)}}).then((r) => r.ok)`,
		);
		await send('Page.navigate', { url: `${ORIGIN}/studio?mode=world` });
		await waitFor("!!document.querySelector('.worldmap')", 'the map, signed in');
		await waitFor(
			`[...document.querySelectorAll('.shelf__name')].some((n) => n.textContent.includes(${JSON.stringify(componentName)}))`,
			'the component shelf',
		);
		check('a saved build reaches the world\u2019s parts bin', true, componentName);

		const armed = await evaluate(
			`(() => { const b = [...document.querySelectorAll('.shelf__item')]` +
				`.find((x) => x.textContent.includes(${JSON.stringify(componentName)})); if (b) b.click(); return !!b; })()`,
		);
		check('picking one arms it', armed === true);
		await sleep(250);
		check(
			'and hands the pointer the Place tool',
			(await evaluate("document.querySelector('.world')?.dataset.tool")) === 'place',
			String(await evaluate("document.querySelector('.world')?.dataset.tool")),
		);

		const freshBox = await mapBox();
		const drop = { x: freshBox.x + freshBox.w * 0.4, y: freshBox.y + freshBox.h * 0.4 };
		await mouse('mousePressed', drop.x, drop.y);
		await mouse('mouseReleased', drop.x, drop.y);
		await send('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
		await sleep(600);
		check(
			'clicking the map drops it',
			(await fact('placements')) === 1,
			`${await fact('placements')} placed`,
		);

		// The point of the whole tier: a component is not a box on a plan, it is blocks that
		// land on the ground you sculpted. Asserted on the region's own placement count rather
		// than on a block delta, because the delta races the prefab fetch — on localhost the
		// blocks are often already in by the time a "before" could be read.
		await waitFor(
			"document.querySelector('.world__preview')?.dataset.placed === '1'",
			'the placed build to reach the materialised region',
		);
		check(
			'the 3D check follows the drop to its own region',
			true,
			String(await evaluate("document.querySelector('.world__preview')?.dataset.region")),
		);
		check(
			'and its blocks are stamped into it, not merely referenced',
			(await evaluate("Number(document.querySelector('.world__preview')?.dataset.unresolved ?? 1)")) === 0,
		);
	}

	check('no uncaught errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

	const out = process.env.CM_WORLD_SHOT ?? 'out/verify-world.png';
	const shot = await send('Page.captureScreenshot', { format: 'png' });
	fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
	fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
	console.log(`\nshot   ${out}`);
} catch (err) {
	console.error(err.message);
	failures++;
} finally {
	ws?.close();
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

console.log(failures === 0 ? '\nworld verified' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
