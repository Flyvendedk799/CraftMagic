/**
 * End-to-end test of accounts and the build library, driven through a real browser.
 *
 * `verify-auth.mjs` proves the API. This proves the app: a fresh account created by typing in
 * the form, a build saved from the editor, the page **reloaded** so nothing survives in
 * memory, the build listed, opened back into the 3D editor, renamed and deleted — all through
 * the same DOM a person would use.
 *
 * The reload is the point. A library that only works while the tab stays open is not a
 * library, and an in-memory cache would pass every check up to that line.
 *
 *   node tools/verify-library.mjs [out/verify-library.png]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';

const outFile = process.argv[2] ?? 'out/verify-library.png';
const ORIGIN = process.env.CM_ORIGIN ?? 'http://localhost:3016';

const EDGE = [
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) {
	console.error('Edge not found');
	process.exit(1);
}

const WIDTH = 1280;
const HEIGHT = 900;

const port = 9700 + (process.pid % 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-library-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(
	EDGE,
	[
		'--headless=new',
		'--disable-gpu',
		'--use-gl=swiftshader',
		'--enable-unsafe-swiftshader',
		'--hide-scrollbars',
		`--window-size=${WIDTH},${HEIGHT}`,
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		'about:blank',
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
const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures.push(label);
};

const stamp = Date.now();
const email = `lib-${stamp}@example.test`;
const password = 'a-perfectly-fine-password';

try {
	let wsUrl;
	for (let i = 0; i < 60 && !wsUrl; i++) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			wsUrl = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
		} catch {
			/* still starting */
		}
		if (!wsUrl) await sleep(250);
	}
	if (!wsUrl) throw new Error('devtools never came up');

	const socket = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
	});

	const send = cdp(socket);
	await send('Page.enable');
	await send('Runtime.enable');

	const evaluate = async (expression) => {
		const { result, exceptionDetails } = await send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (exceptionDetails) {
			throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluate failed');
		}
		return result.value;
	};

	/**
	 * Poll for a condition, forcing a frame each time round.
	 *
	 * Headless Chrome stops compositing once the page is visually static, and the editor
	 * reports its meshing progress from a `requestAnimationFrame` callback — so a wait on a
	 * build that finished seconds ago can run out its whole timeout having never been told.
	 * Capturing a throwaway frame forces a BeginFrame. It is timing-dependent, which is worse
	 * than a hard failure: this driver passed and failed on alternate runs before the fix.
	 */
	const waitFor = async (expression, label, timeoutMs = 30_000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await evaluate(expression)) return true;
			await send('Page.captureScreenshot', { format: 'jpeg', quality: 1 });
			await sleep(120);
		}
		throw new Error(`timed out waiting for ${label}`);
	};

	/** React ignores a plain `input.value = x`; the prototype setter is what it listens to. */
	const type = (selector, value) =>
		evaluate(`
			(() => {
				const input = document.querySelector(${JSON.stringify(selector)});
				if (!input) throw new Error('no such input: ' + ${JSON.stringify(selector)});
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				setter.call(input, ${JSON.stringify(value)});
				input.dispatchEvent(new Event('input', { bubbles: true }));
				return true;
			})()
		`);

	const clickText = (selector, text) =>
		evaluate(`
			(() => {
				const button = [...document.querySelectorAll(${JSON.stringify(selector)})]
					.find((b) => b.textContent.trim() === ${JSON.stringify(text)});
				if (!button) throw new Error('no button: ' + ${JSON.stringify(text)});
				if (button.disabled) throw new Error('button disabled: ' + ${JSON.stringify(text)});
				button.click();
				return true;
			})()
		`);

	const libraryReady = () => waitFor("document.querySelector('.library')?.dataset.ready === '1'", 'the library');
	const meshed = () => waitFor("document.querySelector('.editor')?.dataset.remaining === '0'", 'meshing', 60_000);

	const rows = () =>
		evaluate(`
			[...document.querySelectorAll('.card')].map((row) => ({
				id: row.dataset.build,
				name: row.querySelector('.card__name')?.textContent.trim() ?? null,
				meta: [...row.querySelectorAll('.card__facts span')].map((d) => d.textContent.trim()),
				kind: row.querySelector('.card__kind')?.dataset.kind ?? null,
			}))
		`);

	// --- sign up --------------------------------------------------------------
	await send('Page.navigate', { url: `${ORIGIN}/library` });
	await libraryReady();
	check('the library page loads signed out', (await evaluate("document.querySelector('.account').dataset.state")) === 'anonymous');
	check(
		'it says why an account is worth having',
		(await evaluate("document.querySelector('.library').textContent")).includes('Sign in to keep your builds'),
	);

	await clickText('.account__tab', 'Create account');
	await type('.account__input[type="email"]', email);
	await type('.account__input[type="password"]', password);
	await clickText('.account__submit', 'Create account');

	// Signed in, the library drops its account form: who you are and the way out live in the
	// app bar on every page, and a second copy of both on one of them is furniture. So the
	// signed-in assertions below read the bar rather than the form that just vanished.
	await waitFor("!!document.querySelector('.nav__email')", 'the signup', 20_000);
	await libraryReady();
	const signedInAs = await evaluate("document.querySelector('.nav__email')?.textContent");
	check('signing up signs you in', signedInAs === email, signedInAs);
	check('the quota is on screen', (await evaluate("document.querySelector('.nav__quota')?.title ?? ''")).includes('30 of 30 generations left today'));
	check('a new library is empty', (await evaluate("document.querySelector('.library').dataset.count")) === '0');

	// --- save a build ---------------------------------------------------------
	await send('Page.navigate', { url: `${ORIGIN}/?build=tower` });
	await waitFor("!!document.querySelector('.editor')", 'the editor');
	await meshed();

	// The HUD collapses into sections now, several of them closed by default. Open the two this
	// driver reads from, exactly as a person would before using them.
	const openSection = (title) =>
		evaluate(`
			(() => {
				const head = [...document.querySelectorAll('.section__head')]
					.find((h) => h.textContent.includes(${JSON.stringify(title)}));
				if (!head) return false;
				if (head.getAttribute('aria-expanded') !== 'true') head.click();
				return true;
			})()
		`);
	await openSection('Details');
	await openSection('Save');
	await sleep(200);

	const editorBlocks = await evaluate("Number([...document.querySelectorAll('.hud__stats dd')][2].textContent.replace(/[^0-9]/g, ''))");
	check('the editor kept the session across the navigation', (await evaluate("document.querySelector('.account')?.dataset.state")) === 'signed-in');
	check('the editor wears the app bar too', await evaluate("!!document.querySelector('.editor > .nav')"));

	await clickText('.save__actions button', 'Save to library');
	await waitFor("!!document.querySelector('.save__note--ok')", 'the save to confirm', 20_000);
	check('the editor confirms the save', (await evaluate("document.querySelector('.save__note--ok').textContent")).includes('Saved'));

	// --- reload, and find it again -------------------------------------------
	// A hard navigation, not a router link: nothing the editor put in memory survives this,
	// so the row can only come from the database.
	await send('Page.navigate', { url: `${ORIGIN}/library` });
	await libraryReady();
	await waitFor("document.querySelector('.library').dataset.count === '1'", 'the saved build to list', 20_000);

	const listed = await rows();
	check('the build is listed after a reload', listed.length === 1, JSON.stringify(listed[0]?.name));
	check('the row shows dimensions', /^\d+×\d+×\d+$/.test(listed[0]?.meta[0] ?? ''), listed[0]?.meta[0]);
	check('the row shows the block count', Number((listed[0]?.meta[1] ?? '').replace(/[^0-9]/g, '')) === editorBlocks, `${listed[0]?.meta[1]} vs ${editorBlocks} in the editor`);
	check('the row shows a date', (listed[0]?.meta[2] ?? '').length > 3, listed[0]?.meta[2]);
	check('a program-backed build is marked resizable', listed[0]?.kind === 'resizable', listed[0]?.kind);
	const rowId = listed[0]?.id;

	// --- open it --------------------------------------------------------------
	await clickText('.card__action', 'Open');
	await waitFor("!!document.querySelector('.editor')", 'the editor to open the build', 30_000);
	await meshed();

	const opened = await evaluate(`
		(() => {
			const el = document.querySelector('.editor');
			const dd = [...document.querySelectorAll('.hud__stats dd')].map((n) => n.textContent);
			return {
				build: el.dataset.build,
				name: dd[0],
				blocks: Number(dd[2].replace(/[^0-9]/g, '')),
				params: document.querySelectorAll('.param__slider').length,
			};
		})()
	`);
	check('the editor opened the library build', opened.build === `lib:${rowId}`, opened.build);
	check('it has the same block count as when it was saved', opened.blocks === editorBlocks, `${opened.blocks} vs ${editorBlocks}`);
	check('the program came back, so the resize sliders still work', opened.params > 0, `${opened.params} param slider(s)`);

	// A deep link is the real test of "opened": the id alone, in a fresh page load, has to be
	// enough to fetch and render the build.
	await send('Page.navigate', { url: `${ORIGIN}/?build=lib:${rowId}` });
	await waitFor("!!document.querySelector('.editor')", 'the deep link', 30_000);
	await meshed();
	const deepLinked = await evaluate("Number([...document.querySelectorAll('.hud__stats dd')][2].textContent.replace(/[^0-9]/g, ''))");
	check('a bare ?build=lib:<id> deep link renders it too', deepLinked === editorBlocks, `${deepLinked} blocks`);

	// --- rename ---------------------------------------------------------------
	await send('Page.navigate', { url: `${ORIGIN}/library` });
	await libraryReady();
	await waitFor("document.querySelector('.library').dataset.count === '1'", 'the listing');

	await clickText('.card__action', 'Rename');
	await waitFor("!!document.querySelector('.card__input')", 'the rename field');
	await type('.card__input', 'A Renamed Tower');
	await clickText('.card__rename button', 'Save');

	await waitFor(
		"document.querySelector('.card__name')?.textContent.trim() === 'A Renamed Tower'",
		'the rename',
		20_000,
	);
	check('renaming works', true, 'A Renamed Tower');

	// Reloaded, because a rename that only updated React state would pass the check above.
	await send('Page.navigate', { url: `${ORIGIN}/library` });
	await libraryReady();
	await waitFor("document.querySelector('.library').dataset.count === '1'", 'the listing');
	const afterReload = await rows();
	check('the new name survived a reload', afterReload[0]?.name === 'A Renamed Tower', afterReload[0]?.name);

	// --- screenshot, before deleting the thing it shows ------------------------
	await sleep(300);
	const shot = await send('Page.captureScreenshot', { format: 'png' });
	fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
	fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));

	const png = PNG.sync.read(fs.readFileSync(outFile));
	// A blank page is the failure mode a screenshot is meant to catch, and it is invisible in
	// a byte count. Counting distinct colours is the cheapest thing that notices it.
	const colours = new Set();
	for (let i = 0; i < png.data.length; i += 4) {
		colours.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
	}
	check('the screenshot is a real page, not a blank one', colours.size > 20, `${png.width}×${png.height}, ${colours.size} distinct colours`);

	// --- delete ---------------------------------------------------------------
	// `window.confirm` blocks a headless page forever; answering it up front is the only way
	// to drive the button that a person would actually press.
	await evaluate('window.confirm = () => true; true');
	await clickText('.card__action', 'Delete');
	await waitFor("document.querySelector('.library').dataset.count === '0'", 'the delete', 20_000);
	check('deleting removes the row', true);

	await send('Page.navigate', { url: `${ORIGIN}/library` });
	await libraryReady();
	check('it is still gone after a reload', (await evaluate("document.querySelector('.library').dataset.count")) === '0');

	// --- sign out -------------------------------------------------------------
	await clickText('.nav__signout', 'Sign out');
	await waitFor("!document.querySelector('.nav__email')", 'the sign out', 20_000);
	check('signing out returns the page to its signed-out state', true);

	await send('Page.navigate', { url: `${ORIGIN}/library` });
	await libraryReady();
	check('the sign-out survives a reload', (await evaluate("document.querySelector('.account').dataset.state")) === 'anonymous');

	console.log(`\nshot   ${outFile}  ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB`);
	console.log(failures.length === 0 ? '\nall checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`);
	if (failures.length > 0) exitCode = 1;

	socket.close();
} catch (err) {
	console.error(`\n${err.message}`);
	exitCode = 1;
} finally {
	child.kill();
	await sleep(300);
	fs.rmSync(profile, { recursive: true, force: true });
}

process.exit(exitCode);
