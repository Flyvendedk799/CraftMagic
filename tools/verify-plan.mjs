/**
 * Prove the planner actually composes saved builds into one buildable structure.
 *
 * The claim the feature makes is narrow and easy to fake: a saved build is a *component*, and
 * several of them arranged on a plot are *one build* that can be exported and sent to a world.
 * Rendering a sidebar full of names proves none of that. What this checks is the chain —
 * library rows become components, placing one puts blocks in the composed grid, the same
 * component can be placed twice, moving one changes the composition, and the result is a
 * schematic the export path will write.
 *
 * It drags with real pointer events rather than calling a handler, because the drag is the
 * part with somewhere to hide: pointer capture, suppressing the camera, and the ground-plane
 * projection are all invisible to a unit test and all of them can be individually broken while
 * the placement list still shows the right numbers.
 *
 * Needs an account and a library, so it seeds one over the API first. Free — no model is
 * called, and it cleans up the builds it created.
 *
 *   node tools/verify-plan.mjs [origin]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGIN = (process.argv[2] ?? process.env.CM_ORIGIN ?? 'http://localhost:3016').replace(/\/+$/, '');
const EMAIL = process.env.CM_PLAN_EMAIL ?? 'verify-plan@example.com';
const PASSWORD = process.env.CM_PLAN_PASSWORD ?? 'verify-plan-password-1';

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

// --- seed a library over the API ---------------------------------------------------------

const { expand, samples } = await import('@craftmagic/core');

let cookie = '';
async function api(path, body, method = 'POST') {
	const res = await fetch(ORIGIN + path, {
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
if (auth.status >= 400) {
	console.error(`could not sign in: HTTP ${auth.status} ${auth.body?.message ?? ''}`);
	process.exit(1);
}

/** Ids this run created, so it can put the account back the way it found it. */
const seeded = [];
for (const [key, program] of Object.entries(samples)) {
	const result = expand(program);
	const saved = await api('/api/builds', {
		name: `verify-${key}`,
		library: true,
		detached: false,
		program,
		grid: {
			size: result.grid.size,
			palette: result.grid.palette,
			voxels: Array.from(result.grid.voxels),
		},
	});
	if (saved.body?.id) seeded.push(saved.body.id);
}
console.log(`seeded ${seeded.length} components\n`);

// --- drive the planner --------------------------------------------------------------------

const port = 9500 + (process.pid % 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-plan-'));
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
	});

	const send = (method, params = {}) =>
		new Promise((resolve) => {
			const next = ++id;
			waiters.set(next, resolve);
			ws.send(JSON.stringify({ id: next, method, params }));
		});

	const evaluate = async (expression) => {
		const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
		if (res.result?.exceptionDetails) {
			throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
		}
		return res.result?.result?.value;
	};

	const waitFor = async (expression, label, ms = 30_000) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (await evaluate(expression)) return true;
			await sleep(250);
		}
		throw new Error(`timed out waiting for ${label}`);
	};

	/**
	 * Wait for the mesh pipeline to drain.
	 *
	 * Progress is reported from a `requestAnimationFrame` callback, and headless Chrome stops
	 * compositing once the page is visually static — so after the pointer stops moving, the
	 * last "remaining → 0" tick can simply never be delivered. Capturing a throwaway frame is
	 * what forces a BeginFrame. `requestAnimationFrame` does *not* work here: with compositing
	 * stopped the callback never runs, and awaiting it hangs the driver outright.
	 */
	const meshed = async (label, ms = 60_000) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (await evaluate("document.querySelector('.plan')?.dataset.remaining === '0'")) return true;
			await send('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
			await sleep(150);
		}
		throw new Error(`timed out waiting for ${label}`);
	};

	const mouse = (type, x, y, down = false) =>
		send('Input.dispatchMouseEvent', {
			type, x, y,
			button: 'left',
			buttons: type === 'mouseMoved' && !down ? 0 : 1,
			clickCount: 1,
			pointerType: 'mouse',
		});

	await send('Page.enable');
	await send('Runtime.enable');

	await send('Page.navigate', { url: `${ORIGIN}/` });
	await waitFor("!!document.querySelector('.editor')", 'the studio');
	const signedIn = await evaluate(
		`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(
			JSON.stringify({ email: EMAIL, password: PASSWORD }),
		)}}).then(r=>r.status)`,
	);
	check('signed in', signedIn === 200, `HTTP ${signedIn}`);

	// A fresh plot every run: a plan left in localStorage by an earlier run must not be able
	// to make this pass.
	await evaluate("localStorage.removeItem('craftmagic.plan'), 1");
	await send('Page.navigate', { url: `${ORIGIN}/plan` });
	await waitFor("!!document.querySelector('.plan')", 'the planner');

	// --- the library is the parts bin ---------------------------------------------------
	await waitFor("document.querySelectorAll('.shelf__item').length >= 3", 'the component shelf');
	const shelf = await evaluate("[...document.querySelectorAll('.shelf__name')].map(n=>n.textContent.trim())");
	check('saved builds appear as components', shelf.length >= 3, shelf.join(' / '));

	check('an empty plot says so', await evaluate("!!document.querySelector('.viewport__empty')"));

	// --- placing -------------------------------------------------------------------------
	for (const index of [0, 1, 2, 0]) {
		await evaluate(`(()=>{document.querySelectorAll('.shelf__item')[${index}].click();return 1})()`);
		await sleep(900);
	}
	await waitFor("document.querySelector('.plan')?.dataset.placements === '4'", 'four placements');
	await meshed('the first composition');

	await evaluate(`(()=>{
		const head=[...document.querySelectorAll('.section__head')].find(h=>h.textContent.includes('Details'));
		if(head && head.getAttribute('aria-expanded')!=='true') head.click();
		return 1;
	})()`);
	await sleep(400);

	const stat = (name) => evaluate(`[...document.querySelectorAll('.hud dt')]
		.find(d=>d.textContent.trim()===${JSON.stringify(name)})?.nextElementSibling?.textContent?.trim()`);

	const size = await stat('Size');
	const blocks = await stat('Blocks');
	check('four placements are listed', (await evaluate("document.querySelectorAll('.placement').length")) === 4);
	check('from three distinct components', (await stat('Components')) === '3');
	check('composed into one grid', !!size && size !== '1×1×1', `${size}, ${blocks} blocks`);
	check(
		'the same component placed twice',
		(await evaluate("[...document.querySelectorAll('.shelf__used')].some(n=>n.textContent==='2×')")) === true,
	);

	// --- surviving a reload -----------------------------------------------------------------
	// The plan stores component *ids* and fetches the grids, so a reload exercises a different
	// path from placing: the fetch is driven by an effect rather than by a click. The first
	// version deadlocked there — marking an id as loading re-ran the effect, the re-run
	// cancelled the fetch it had just started, and the next pass skipped the id because it was
	// already marked loading. Placements came back, components never did, and the plan composed
	// to an empty grid.
	await send('Page.navigate', { url: `${ORIGIN}/plan` });
	await waitFor("document.querySelector('.plan')?.dataset.placements === '4'", 'the restored plan');
	await meshed('the restored composition');
	await evaluate(`(()=>{
		const head=[...document.querySelectorAll('.section__head')].find(h=>h.textContent.includes('Details'));
		if(head && head.getAttribute('aria-expanded')!=='true') head.click();
		return 1;
	})()`);
	await sleep(400);
	const reloadedSize = await stat('Size');
	check('a plan survives a reload', reloadedSize === size, `${size} → ${reloadedSize}`);
	check(
		'and its components come back with it',
		(await evaluate("[...document.querySelectorAll('.placement__name')].every(n=>n.textContent.trim()!=='Missing component')")) === true,
	);

	// --- the keyboard --------------------------------------------------------------------
	// Selection does not survive a reload, so pick one before using the keys on it.
	await evaluate("(()=>{document.querySelectorAll('.placement__head')[3].click();return 1})()");
	await sleep(300);
	const at = () => evaluate("document.querySelector('.placement[data-selected=true] .placement__at')?.textContent");
	const before = await at();
	await evaluate("(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return 1})()");
	await sleep(400);
	check('an arrow key nudges the selection', before !== (await at()), `${before} → ${await at()}`);

	await evaluate("(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'r',bubbles:true}));return 1})()");
	await sleep(700);
	const facing = await evaluate("document.querySelector('.placement[data-selected=true] .placement__body strong')?.textContent");
	check('R turns the selection', facing === 'East', facing ?? '(none)');
	await meshed('the turn');

	// --- the drag -------------------------------------------------------------------------
	// Probe for a pixel over a building: the readout names the *component* under the cursor,
	// so anything but "Ground" means the ray landed on one.
	const OFFSETS = [[0, 0], [0, 60], [60, 0], [-60, 40], [0, -60], [80, 80], [-80, -40], [40, 110], [-110, 90], [120, -30]];
	let spot = null;
	for (const [dx, dy] of OFFSETS) {
		const x = Math.round(640 + dx);
		const y = Math.round(450 + dy);
		await mouse('mouseMoved', x, y);
		await sleep(120);
		const name = await evaluate("document.querySelector('.hover-readout strong')?.textContent ?? null");
		if (name && name !== 'Ground') {
			spot = { x, y, name };
			break;
		}
	}
	check('the readout names the building, not the block', !!spot, spot ? `${spot.name}` : 'never found one');
	if (!spot) throw new Error('could not find a building on screen');

	const placedBefore = await evaluate("[...document.querySelectorAll('.placement__at')].map(n=>n.textContent).join('|')");

	await mouse('mousePressed', spot.x, spot.y);
	await sleep(200);
	check('pressing a building selects it', (await evaluate("document.querySelectorAll('.placement[data-selected=true]').length")) === 1);

	for (let step = 1; step <= 6; step++) {
		await mouse('mouseMoved', spot.x + step * 18, spot.y + step * 8, true);
		await sleep(60);
	}
	check('a live readout follows the drag', !!(await evaluate("document.querySelector('.plan__drag')?.textContent ?? null")));

	await mouse('mouseReleased', spot.x + 108, spot.y + 48);
	await sleep(500);
	await meshed('the drag');

	const placedAfter = await evaluate("[...document.querySelectorAll('.placement__at')].map(n=>n.textContent).join('|')");
	check('the drag moved a placement', placedBefore !== placedAfter, `${placedBefore} → ${placedAfter}`);
	check('and released the readout', (await evaluate("!document.querySelector('.plan__drag')")) === true);
	check('without adding or losing one', (await evaluate("document.querySelector('.plan').dataset.placements")) === '4');

	// The camera has to come back: a drag on empty ground must orbit, not move a building.
	const settled = await evaluate("[...document.querySelectorAll('.placement__at')].map(n=>n.textContent).join('|')");
	await mouse('mousePressed', 200, 700);
	await mouse('mouseMoved', 260, 720, true);
	await mouse('mouseReleased', 260, 720);
	await sleep(400);
	check(
		'dragging empty ground orbits instead of moving anything',
		(await evaluate("[...document.querySelectorAll('.placement__at')].map(n=>n.textContent).join('|')")) === settled,
	);

	// --- the way out ----------------------------------------------------------------------
	await evaluate(`(()=>{
		const head=[...document.querySelectorAll('.section__head')].find(h=>h.textContent.includes('Export'));
		if(head && head.getAttribute('aria-expanded')!=='true') head.click();
		return 1;
	})()`);
	await sleep(300);
	check(
		'a composed plan can be exported as one schematic',
		(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Download schematic'))?.disabled")) === false,
	);
	check(
		'and there is no program to offer for it',
		(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Program JSON'))?.disabled")) === true,
	);

	// --- removing --------------------------------------------------------------------------
	await evaluate("(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}));return 1})()");
	await sleep(500);
	check('Delete takes one off the plot', (await evaluate("document.querySelector('.plan').dataset.placements")) === '3');

	const outFile = process.env.CM_PLAN_SHOT ?? 'out/verify-plan.png';
	const shot = await send('Page.captureScreenshot', { format: 'png' });
	fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
	fs.writeFileSync(outFile, Buffer.from(shot.result.data, 'base64'));
	console.log(`\nshot   ${outFile}`);
} catch (err) {
	console.error(err.message);
	failures++;
} finally {
	ws?.close();
	child.kill();
	await sleep(300);
	fs.rmSync(profile, { recursive: true, force: true });

	// Put the account back: this script is run repeatedly, and a library that grows by three
	// every time turns the shelf into a scroll of duplicates.
	for (const buildId of seeded) await api(`/api/builds/${buildId}`, null, 'DELETE');
	console.log(`cleaned up ${seeded.length} seeded components`);
}

console.log(failures === 0 ? '\nplanner verified' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
