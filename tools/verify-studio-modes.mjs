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
		throw new Error(`timed out waiting for ${label}; URL=${await evaluate('location.href')}; ready=${await evaluate('document.readyState')}; body=${String(await evaluate('document.body?.innerText?.slice(0, 200)'))}; pressed=${await pressed()}; errors=${pageErrors.join(' | ')}`);
	};

	await send('Page.enable');
	await send('Runtime.enable');

	const PRESSED =
		"[...document.querySelectorAll('.studio__switch button')]" +
		".find((b) => b.getAttribute('aria-pressed') === 'true')?.querySelector('strong')?.textContent?.trim() ?? null";
	const pressed = () => evaluate(PRESSED);

	const go = async (url, ready, label) => {
		await send('Page.navigate', { url });
		await waitFor(ready, label);
		await sleep(700);
	};

	const clickPill = (label) =>
		evaluate(
			`(() => { const b = [...document.querySelectorAll('.studio__switch button')]` +
				`.find((x) => x.querySelector('strong')?.textContent.trim() === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`,
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
		(await evaluate("document.querySelector('.arch .ui-dock__title')?.textContent")) === 'Architecture',
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
	check(
		'returning from World reopens the build that was being edited',
		String(await evaluate('location.search')).includes('build=tower'),
		String(await evaluate('location.search')),
	);
	await clickPill('World');
	await waitFor("!!document.querySelector('.world')", 'World before refresh');
	await send('Page.reload');
	await waitFor("!!document.querySelector('.world')", 'World after refresh');
	await clickPill('Build');
	await waitFor("!!document.querySelector('.editor')", 'Build after refresh');
	check('a refresh keeps the open build in Studio', String(await evaluate('location.search')).includes('build=tower'));

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

	// A named browser plan can be made, saved, found from another workspace, and reopened.
	await go(`${ORIGIN}/studio?mode=arch`, "!!document.querySelector('.arch__templates')", 'Architecture files');
	await evaluate("[...document.querySelectorAll('.arch__templates button')].find((b) => b.textContent.trim() === 'Studio')?.click()");
	await waitFor("!document.querySelector('.arch__plan-empty')", 'the template plan');
	await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))");
	await waitFor("!!localStorage.getItem('craftmagic.architecture.plans')", 'Ctrl+S saved a named floorplan');
	await clickPill('Build');
	await waitFor("!!document.querySelector('.editor')", 'Build after plan save');
	await evaluate("localStorage.removeItem('craftmagic.architecture.autosave')");
	await evaluate("[...document.querySelectorAll('.studio__file-action')].find((b) => b.textContent.trim() === 'Open')?.click()");
	await waitFor("!!document.querySelector('.studio-files__panel')", 'the file manager');
	await waitFor("[...document.querySelectorAll('.studio-files__group')].some((g) => g.querySelector('h3')?.textContent?.includes('Browser floorplans') && g.querySelector('.studio-files__row'))", 'the saved floorplan in Open');
	fs.writeFileSync('out/verify-studio-files.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
	check('Open shows browser floorplans from another workspace', (await evaluate("[...document.querySelectorAll('.studio-files__group')].some((g) => g.querySelector('h3')?.textContent?.includes('Browser floorplans') && g.querySelector('.studio-files__row'))")) === true);
	await evaluate("window.prompt = () => 'Studio file workflow'; [...document.querySelectorAll('.studio-files__group')].find((g) => g.querySelector('h3')?.textContent?.includes('Browser floorplans'))?.querySelector('.studio-files__manage button:first-child')?.click()");
	await waitFor("[...document.querySelectorAll('.studio-files__group')].find((g) => g.querySelector('h3')?.textContent?.includes('Browser floorplans'))?.textContent?.includes('Studio file workflow')", 'renamed floorplan in Files');
	check('Files renames browser floorplans', (await evaluate("[...document.querySelectorAll('.studio-files__group')].find((g) => g.querySelector('h3')?.textContent?.includes('Browser floorplans'))?.textContent?.includes('Studio file workflow')")) === true);
	await evaluate("[...document.querySelectorAll('.studio-files__group')].find((g) => g.querySelector('h3')?.textContent?.includes('Browser floorplans'))?.querySelector('.studio-files__row')?.click()");
	await waitFor("location.search.includes('plan=local:') && !!document.querySelector('.arch')", 'the saved browser floorplan');
	await waitFor("!document.querySelector('.arch__plan-empty')", 'the reopened floorplan drawing');
	check('Open restores the plan drawing', (await evaluate("!document.querySelector('.arch__plan-empty')")) === true);
	await waitFor("document.querySelector('.studio__document-state')?.textContent?.includes('Ready to work')", 'the saved plan state');
	check('opening a saved floorplan is clean', (await evaluate("document.querySelector('.studio__document-state')?.textContent?.includes('Ready to work')")) === true);
	await evaluate("window.confirm = () => true; [...document.querySelectorAll('.studio__file-action')].find((b) => b.textContent.trim() === 'Open')?.click()");
	await waitFor("!!document.querySelector('.studio-files__panel')", 'Files before floorplan delete');
	await evaluate("[...document.querySelectorAll('.studio-files__group')].find((g) => g.querySelector('h3')?.textContent?.includes('Browser floorplans'))?.querySelector('.studio-files__manage button:last-child')?.click()");
	await waitFor("!location.search.includes('plan=local:')", 'blank floorplan after delete');
	check('deleting the open floorplan returns to a new plan', (await evaluate("!location.search.includes('plan=local:') && !!document.querySelector('.arch')")) === true);
	await evaluate("document.querySelector('.studio-files__close')?.click()");
	await clickPill('Build');
	await waitFor("!!document.querySelector('.editor')", 'Build before New');
	const newBuild = () => evaluate("[...document.querySelectorAll('.studio__file-action')].find((b) => b.textContent.trim() === 'New')?.click()");
	await newBuild();
	await waitFor("new URLSearchParams(location.search).get('build')?.startsWith('gen:')", 'a new build document');
	const firstDraft = await evaluate("new URLSearchParams(location.search).get('build')");
	await newBuild();
	await waitFor(`new URLSearchParams(location.search).get('build') !== ${JSON.stringify(firstDraft)}`, 'a second new build document');
	check('New creates separate build documents', firstDraft !== await evaluate("new URLSearchParams(location.search).get('build')"));
	await evaluate("[...document.querySelectorAll('.studio__file-action')].find((b) => b.textContent.trim() === 'Open')?.click()");
	await waitFor("!!document.querySelector('.studio-files__panel')", 'Files for browser builds');
	await evaluate("window.prompt = () => 'My working build'; [...document.querySelectorAll('.studio-files__group')].find((g) => g.querySelector('h3')?.textContent?.includes('Browser builds'))?.querySelector('.studio-files__row-wrap:last-child .studio-files__manage button:first-child')?.click()");
	await waitFor("document.querySelector('.studio__document')?.textContent?.includes('My working build')", 'renamed open build');
	check('renaming an open build refreshes its editor', (await evaluate("document.querySelector('.studio__document')?.textContent?.includes('My working build')")) === true);
	await evaluate("[...document.querySelectorAll('.studio-files__group')].find((g) => g.querySelector('h3')?.textContent?.includes('Browser builds'))?.querySelector('.studio-files__row-wrap:last-child .studio-files__manage button:last-child')?.click()");
	await waitFor("!new URLSearchParams(location.search).has('build')", 'blank Build after deleting open build');
	check('deleting an open build returns to Build', (await evaluate("!!document.querySelector('.editor') && !new URLSearchParams(location.search).has('build')")) === true);
	await evaluate("document.querySelector('.studio-files__close')?.click()");

	// On a phone the canvas gets the viewport; every mode has a direct route back to its tools
	// and its project/output panel without scrolling through the whole editor.
	await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
	const mobileCheck = async (modeUrl, selector, panes) => {
		await go(`${ORIGIN}${modeUrl}`, `!!document.querySelector('${selector}')`, modeUrl);
		for (const [label, visible, hidden] of panes) {
			await evaluate(`(() => { [...document.querySelectorAll('.studio__pane-switch button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click(); return true; })()`);
			const state = await evaluate(`(() => {
				const shown = document.querySelector(${JSON.stringify(visible)});
				const gone = document.querySelector(${JSON.stringify(hidden)});
				return !!shown && !!gone && getComputedStyle(shown).display !== 'none' && getComputedStyle(gone).display === 'none';
			})()`);
			check(`${modeUrl} phone ${label} view`, state);
		}
	};
	await mobileCheck('/studio', '.editor', [
		['Tools', '.hud--top', '.editor__canvas'],
		['Create & export', '.hud-right', '.editor__canvas'],
		['Canvas', '.editor__canvas', '.hud--top'],
	]);
	await evaluate("[...document.querySelectorAll('.studio__file-action')].find((b) => b.textContent.trim() === 'Export')?.click()");
	await waitFor("document.querySelector('.studio')?.dataset.pane === 'project' && document.querySelector('#studio-section-export')?.classList.contains('section--open')", 'Build output from the common Export action');
	check('common Export opens Build output on a phone', (await evaluate("document.querySelector('.studio')?.dataset.pane === 'project'")) === true);
	await mobileCheck('/studio?mode=arch', '.arch', [
		['Tools', '.arch__panel', '.arch__plan'],
		['3D preview', '.arch__model', '.arch__plan'],
		['Plan', '.arch__plan', '.arch__panel'],
	]);
	await evaluate("[...document.querySelectorAll('.studio__file-action')].find((b) => b.textContent.trim() === 'Export')?.click()");
	await waitFor("document.querySelector('.studio')?.dataset.pane === 'tools' && document.querySelector('#studio-section-export')?.classList.contains('section--open')", 'Architecture output from the common Export action');
	check('common Export opens Architecture output on a phone', (await evaluate("document.querySelector('.studio')?.dataset.pane === 'tools'")) === true);
	await mobileCheck('/studio?mode=world', '.world', [
		['Tools', '.world__dock--left', '.world__stage'],
		['Contents', '.world__dock--right', '.world__stage'],
		['Canvas', '.world__stage', '.world__dock--left'],
	]);
	check('phone header fits the viewport', (await evaluate('document.documentElement.scrollWidth <= innerWidth + 1')) === true);

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
