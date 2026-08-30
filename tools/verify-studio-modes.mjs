/**
 * Prove the studio has three modes and that no link anyone already shared broke.
 *
 * The mode lives in the query string, so every link ever sent from this product carries one —
 * and the value in all of them is `?mode=plan`, from when Architecture was called the layouter.
 * A rename that dropped that alias would not error: the visitor would simply land in Build mode
 * looking at the wrong tool, and nobody would report it.
 *
 * The same goes for the redirects. `/editor?build=gen:3` and `/layouter?plan=lib:…` carry their
 * payload in the query, and a redirect that keeps the path but loses the search lands every old
 * link on the default cottage.
 *
 *   node tools/verify-studio-modes.mjs [origin]
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
const port = 9200 + (process.pid % 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-modes-'));
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
	const waitFor = async (expression, label, ms = 30_000) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (await evaluate(expression)) return true;
			// Headless Chrome stops compositing on a static page; a throwaway frame is what
			// keeps a wait from timing out against a page that finished long ago.
			await send('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
			await sleep(200);
		}
		throw new Error(`timed out waiting for ${label}`);
	};

	await send('Page.enable');
	await send('Runtime.enable');

	const PRESSED =
		"[...document.querySelectorAll('.studio__switch button')]" +
		".find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent?.trim() ?? null";
	const pressed = () => evaluate(PRESSED);

	const go = async (url, ready, label) => {
		await send('Page.navigate', { url });
		await waitFor(ready, label);
		await sleep(700);
	};

	const clickPill = (label) =>
		evaluate(
			`(() => { const b = [...document.querySelectorAll('.studio__switch button')]` +
				`.find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`,
		);

	// --- the three modes mount ----------------------------------------------------------
	await go(`${ORIGIN}/studio`, "!!document.querySelector('.editor')", 'Build');
	check('the studio opens in Build', (await pressed()) === 'Build');
	check(
		'three modes on the switch',
		(await evaluate("document.querySelectorAll('.studio__switch button[aria-pressed]').length")) === 3,
	);

	await go(`${ORIGIN}/studio?mode=arch`, "!!document.querySelector('.arch')", 'Architecture');
	check('?mode=arch mounts Architecture', (await pressed()) === 'Architecture');
	check(
		'and it is titled Architecture, not Layouter',
		(await evaluate("document.querySelector('.arch .hud__title')?.textContent")) === 'Architecture',
	);

	await go(`${ORIGIN}/studio?mode=world`, "!!document.querySelector('.world')", 'World');
	check('?mode=world mounts World', (await pressed()) === 'World');

	// --- the links people already have ---------------------------------------------------
	await go(`${ORIGIN}/studio?mode=plan`, "!!document.querySelector('.arch')", 'the legacy alias');
	check('?mode=plan still lands in Architecture', (await pressed()) === 'Architecture');

	await go(`${ORIGIN}/layouter?build=cottage`, "!!document.querySelector('.arch')", 'the /layouter redirect');
	check('/layouter still redirects into Architecture', (await pressed()) === 'Architecture');
	check(
		'and keeps its query — an old link must not land on the default build',
		String(await evaluate('location.search')).includes('build=cottage'),
		String(await evaluate('location.search')),
	);

	await go(`${ORIGIN}/editor?build=tower`, "!!document.querySelector('.editor')", 'the /editor redirect');
	check('/editor still redirects into Build', (await pressed()) === 'Build');
	check('with its query intact', String(await evaluate('location.search')).includes('build=tower'));

	// --- switching -------------------------------------------------------------------------
	await clickPill('World');
	await waitFor("!!document.querySelector('.world')", 'World after a click');
	check('clicking a pill switches mode', (await pressed()) === 'World');
	check('and writes it to the URL', String(await evaluate('location.search')).includes('mode=world'));

	await clickPill('Build');
	await waitFor("!!document.querySelector('.editor')", 'Build after a click');
	check(
		'Build leaves no mode in the URL, so a shared link stays clean',
		!String(await evaluate('location.search')).includes('mode='),
		String(await evaluate('location.search')),
	);

	// --- the palette -------------------------------------------------------------------------
	await evaluate(
		"(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); return 1; })()",
	);
	await sleep(600);
	const offered = await evaluate(
		"[...document.querySelectorAll('*')].map((n) => n.textContent)" +
			".filter((t) => t && /^Switch to \\w+ mode$/.test(t.trim()))" +
			".map((t) => t.trim()).filter((t, i, a) => a.indexOf(t) === i)",
	);
	check(
		'the palette offers both other modes, not just one',
		Array.isArray(offered) && offered.length === 2,
		Array.isArray(offered) ? offered.join(' / ') : String(offered),
	);

	check('no uncaught errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

	const out = process.env.CM_MODES_SHOT ?? 'out/verify-studio-modes.png';
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

console.log(failures === 0 ? '\nstudio modes verified' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
