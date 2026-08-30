/**
 * Prove a saved build is really a component of a layout.
 *
 * The claim is a chain, and every link of it is easy to fake in isolation: the library shows
 * up as a shelf, picking one arms a tool, clicking the plan puts a footprint on it, the
 * compiler turns that footprint into a `prefab` component, and the expander turns *that* into
 * blocks in the model beside it. A screenshot of the shelf proves none of it. So this drives
 * the whole chain and then checks the thing at the end of it — that the building's blocks are
 * in the compiled program.
 *
 * It also turns one, twice, by two different routes. Turning is where a placement can be
 * silently wrong: the footprint and the blockstates rotate through different code, and a
 * building whose stairs face into its own wall throws nothing and looks fine in a list.
 *
 * Deliberately places a **non-square** build. A 19x19 pavilion is unchanged by a quarter turn,
 * so it cannot tell a working rotation from one that does nothing at all.
 *
 * Needs an account and a library, so it seeds one over the API first. Free — no model is
 * called, and it removes the builds it created.
 *
 *   node tools/verify-layouter-place.mjs [origin]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGIN = (process.argv[2] ?? process.env.CM_ORIGIN ?? 'http://localhost:3016').replace(/\/+$/, '');
const EMAIL = process.env.CM_PLACE_EMAIL ?? 'verify-place@example.com';
const PASSWORD = process.env.CM_PLACE_PASSWORD ?? 'verify-place-password-1';

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

// --- seed a library over the API -----------------------------------------------------------

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
if (auth.status >= 400) {
	console.error(`could not sign in: HTTP ${auth.status} ${auth.body?.message ?? ''}`);
	process.exit(1);
}

/**
 * The build this run places, and the ids to clean up.
 *
 * The cottage on purpose: it is 21x19x13, so a quarter turn visibly changes its footprint.
 */
const seeded = [];
let placeName = null;
for (const [key, program] of Object.entries(samples)) {
	const result = expand(program);
	const name = `verify-${key}`;
	const saved = await api('/api/builds', {
		name,
		library: true,
		detached: false,
		program,
		grid: {
			size: result.grid.size,
			palette: result.grid.palette,
			voxels: Array.from(result.grid.voxels),
		},
	});
	if (!saved.body?.id) continue;
	seeded.push(saved.body.id);
	if (result.grid.size.x !== result.grid.size.z && !placeName) placeName = name;
}

if (!placeName) {
	console.error('no non-square sample to place — a square footprint cannot test a turn');
	process.exit(1);
}
console.log(`seeded ${seeded.length} components; placing "${placeName}"\n`);

// --- drive the layouter ---------------------------------------------------------------------

const port = 9600 + (process.pid % 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-place-'));
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
			const details = message.params.exceptionDetails;
			pageErrors.push((details.exception?.description ?? details.text).slice(0, 200));
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

	const click = async (x, y) => {
		for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
			await send('Input.dispatchMouseEvent', {
				type, x, y,
				button: 'left',
				buttons: type === 'mouseMoved' ? 0 : 1,
				clickCount: 1,
				pointerType: 'mouse',
			});
		}
	};

	await send('Page.enable');
	await send('Runtime.enable');

	await send('Page.navigate', { url: `${ORIGIN}/studio` });
	await waitFor("!!document.querySelector('.editor, .layouter')", 'the studio');
	const signedIn = await evaluate(
		`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(
			JSON.stringify({ email: EMAIL, password: PASSWORD }),
		)}}).then(r=>r.status)`,
	);
	check('signed in', signedIn === 200, `HTTP ${signedIn}`);

	// A layout left behind by an earlier run must not be able to make this pass.
	await evaluate("Object.keys(localStorage).filter(k=>k.includes('layout')||k.includes('plan')).forEach(k=>localStorage.removeItem(k)), 1");
	await send('Page.navigate', { url: `${ORIGIN}/studio?mode=plan` });
	await waitFor("!!document.querySelector('svg.plan')", 'the plan canvas');
	await sleep(1200);

	// --- the library is the parts bin ----------------------------------------------------
	const opened = await evaluate(`(()=>{
		const head = [...document.querySelectorAll('.section__head, button')]
			.find((b) => b.textContent.trim().startsWith('Components'));
		if (!head) return false;
		if (head.getAttribute('aria-expanded') !== 'true') head.click();
		return true;
	})()`);
	check('the layouter has a Components panel', opened === true);
	await sleep(700);

	await waitFor("document.querySelectorAll('.shelf__item').length > 0", 'the shelf');
	const names = await evaluate("[...document.querySelectorAll('.shelf__name')].map(n=>n.textContent.trim())");
	check('saved builds appear as components', names.length >= 3, names.join(' / '));

	// --- arming and placing ----------------------------------------------------------------
	await evaluate(`(()=>{
		const item = [...document.querySelectorAll('.shelf__item')]
			.find((b) => b.textContent.includes(${JSON.stringify(placeName)}));
		if (item) item.click();
		return !!item;
	})()`);
	await sleep(800);
	check('picking one arms it', (await evaluate("!!document.querySelector('.shelf__item[aria-pressed=true]')")) === true);
	check(
		'and selects the Place tool',
		(await evaluate("document.querySelector('svg.plan')?.dataset.tool")) === 'place',
	);

	const plot = await evaluate(`(()=>{const s=document.querySelector('svg.plan');const r=s.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);
	await click(Math.round(plot.x + plot.w * 0.45), Math.round(plot.y + plot.h * 0.45));
	await sleep(1400);

	check('clicking the plan places it', (await evaluate("document.querySelectorAll('.plan__place').length")) === 1);
	check('the shelf counts what is placed', (await evaluate("document.querySelector('.shelf__used')?.textContent")) === '1×');

	const box = await evaluate(`(()=>{const s=document.querySelector('svg.plan');const r=s.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);

	// --- it reaches the blocks -------------------------------------------------------------
	//
	// The end of the chain, and the only assertion here that cannot be satisfied by drawing a
	// rectangle: a placement is real when the *compiled* build has the saved building's blocks
	// in it. Read from the Details panel, which reports what the expander actually produced.
	const stat = async (name) => {
		await evaluate(`(()=>{
			const head = [...document.querySelectorAll('.section__head')]
				.find((h) => h.textContent.includes('Details'));
			if (head && head.getAttribute('aria-expanded') !== 'true') head.click();
			return true;
		})()`);
		await sleep(400);
		return evaluate(`[...document.querySelectorAll('.hud__stats dt')]
			.find((d) => d.textContent.trim() === ${JSON.stringify(name)})?.nextElementSibling?.textContent?.trim()`);
	};

	const blocks = Number((await stat('Blocks'))?.replace(/[^0-9]/g, ''));
	const components = Number(await stat('Components'));
	// The cottage is 979 blocks, and a bare plan with nothing drawn on it compiles to a plot.
	// Several hundred blocks can only have come from the building that was placed.
	check('the placed building reaches the blocks', blocks > 500, `${blocks} blocks built`);

	// Place a second copy of the same build. This is the property the prefab table exists for:
	// the second one costs *one more component* and the same blocks again, rather than a second
	// copy of the voxels. Measured as a difference, because the layout around it contributes
	// components of its own and asserting an absolute count would only pin the template.
	await click(Math.round(box.x + box.w * 0.7), Math.round(box.y + box.h * 0.7));
	await sleep(1500);
	const blocksTwice = Number((await stat('Blocks'))?.replace(/[^0-9]/g, ''));
	const componentsTwice = Number(await stat('Components'));

	check('placing it twice costs one more component', componentsTwice === components + 1, `${components} → ${componentsTwice}`);
	check('and builds it twice', blocksTwice > blocks, `${blocks} → ${blocksTwice} blocks`);
	check('the shelf counts both', (await evaluate("document.querySelector('.shelf__used')?.textContent")) === '2×');

	// Back to one, so the turn checks below read an unambiguous footprint. Deleting leaves
	// nothing selected, and the Place tool is still armed — so switch to Select and click the
	// survivor, or the next click would put a third building down instead of picking one up.
	await evaluate("(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}));return 1})()");
	await sleep(900);
	await evaluate("(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'1',bubbles:true}));return 1})()");
	await sleep(400);
	await click(Math.round(plot.x + plot.w * 0.45), Math.round(plot.y + plot.h * 0.45));
	await sleep(800);
	check(
		'clicking a placement selects it',
		(await evaluate("!!document.querySelector('.plan__item.is-selected .plan__place, .plan__place')")) === true,
	);

	// --- turning ----------------------------------------------------------------------------
	const width = () => evaluate("document.querySelector('.plan__place')?.getAttribute('width')");
	const before = await width();

	await evaluate(`(()=>{
		const select = [...document.querySelectorAll('select')]
			.find((s) => [...s.options].some((o) => o.textContent.includes('Quarter')));
		if (!select) return false;
		const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
		setter.call(select, '1');
		select.dispatchEvent(new Event('change', { bubbles: true }));
		return true;
	})()`);
	await sleep(1100);
	const turned = await width();
	check('the inspector turns it', before !== turned, `${before} → ${turned}`);

	await evaluate("(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'r',bubbles:true}));return 1})()");
	await sleep(900);
	check('and R turns it again', (await width()) !== turned, `${turned} → ${await width()}`);

	// --- surviving a reload -------------------------------------------------------------------
	// A plan stores a build's *id* and fetches its blocks, so restoring one takes a different
	// path from placing one: driven by an effect rather than by a click.
	await send('Page.navigate', { url: `${ORIGIN}/studio?mode=plan` });
	await waitFor("!!document.querySelector('svg.plan')", 'the plan canvas again');
	await sleep(1600);
	check('the placement survives a reload', (await evaluate("document.querySelectorAll('.plan__place').length")) === 1);
	check(
		'and its blocks come back with it',
		(await evaluate("document.querySelector('.plan__place')?.dataset.loaded")) === 'true',
	);

	check('no uncaught errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

	const outFile = process.env.CM_PLACE_SHOT ?? 'out/verify-layouter-place.png';
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

	// Put the account back: this runs repeatedly, and a library that grows by three every time
	// turns the shelf into a scroll of duplicates.
	for (const buildId of seeded) await api(`/api/builds/${buildId}`, null, 'DELETE');
	console.log(`cleaned up ${seeded.length} seeded components`);
}

console.log(failures === 0 ? '\nplacement verified' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
