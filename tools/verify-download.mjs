/**
 * Click the download button in a real browser and keep the file.
 *
 * The unit tests check the bytes `writeSchematic` produces; this checks the part they
 * cannot — that the browser actually receives a complete file through the Blob/anchor path.
 * The saved file is then worth running `gradlew verifySchematic` against, which closes the
 * loop from button click to Minecraft parsing it.
 *
 *   node tools/verify-download.mjs cottage out/from-browser
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const buildId = process.argv[2] ?? 'cottage';
const outDir = path.resolve(process.argv[3] ?? 'out/from-browser');
const ORIGIN = process.env.CM_ORIGIN ?? 'http://localhost:3016';

const EDGE = [
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const port = 9800 + (process.pid % 150);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-dl-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Open a collapsed HUD section.
 *
 * The editor's panels collapse now, and several of them start closed, so a driver has to open
 * what it needs exactly as a person would rather than assuming everything is on screen.
 */
/**
 * Expression that opens a collapsed HUD section.
 *
 * The editor's panels collapse now and several start closed, so a driver has to open what it
 * needs exactly as a person would rather than assuming everything is on screen.
 */
const openSection = (title) => `(() => {
	const head = [...document.querySelectorAll('.section__head')]
		.find((h) => h.textContent.includes(${JSON.stringify(title)}));
	if (!head) return false;
	if (head.getAttribute('aria-expanded') !== 'true') head.click();
	return true;
})()`;


fs.mkdirSync(outDir, { recursive: true });
for (const file of fs.readdirSync(outDir)) fs.rmSync(path.join(outDir, file), { force: true });

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
	// Headless browsers block downloads unless told where to put them.
	await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: outDir });
	await send('Page.navigate', { url: `${ORIGIN}/?build=${encodeURIComponent(buildId)}` });

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

	await waitFor("document.querySelector('.editor')?.dataset.remaining === '0'", 'the build to load', 60_000);
	// Export starts collapsed, so open it before looking for its buttons.
	await evaluate(openSection('Export'));
	await waitFor(
		"[...document.querySelectorAll('button')].some(b => b.textContent.includes('Download schematic'))",
		'the download button',
		20_000,
	);

	await evaluate(`
		(() => {
			const button = [...document.querySelectorAll('button')]
				.find((b) => b.textContent.includes('Download schematic'));
			button.click();
			return true;
		})()
	`);

	// Wait for a settled file: Chromium writes a .crdownload placeholder first.
	let saved = null;
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline && !saved) {
		const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.schem'));
		if (files.length > 0) {
			const candidate = path.join(outDir, files[0]);
			const size = fs.statSync(candidate).size;
			await sleep(400);
			if (fs.statSync(candidate).size === size && size > 0) saved = { file: candidate, size };
		}
		if (!saved) await sleep(300);
	}
	if (!saved) throw new Error('no .schem file appeared');

	const note = await evaluate("document.querySelector('.export__note')?.textContent ?? null");
	const bytes = fs.readFileSync(saved.file);

	console.log(`build      ${buildId}`);
	console.log(`file       ${path.relative(process.cwd(), saved.file)}`);
	console.log(`size       ${saved.size} bytes`);
	console.log(`gzip magic ${bytes[0] === 0x1f && bytes[1] === 0x8b ? 'ok (1f 8b)' : 'WRONG'}`);
	console.log(`ui said    ${note ?? '(nothing)'}`);

	if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) exitCode = 1;
	socket.close();
} catch (err) {
	console.error(err.message);
	exitCode = 1;
} finally {
	child.kill();
	await sleep(300);
	fs.rmSync(profile, { recursive: true, force: true });
}

process.exitCode = exitCode;
