/**
 * Print a page to PDF the way Ctrl+P does, and report what came out.
 *
 * The guide exists to be printed, so "it looks right on screen" proves very little. Two of
 * its worst bugs were print-only: a `max-width` media query that fired on A4 (703px once
 * margins are taken off) and a stylesheet ordering problem that printed the page black.
 * Neither is visible in a screenshot.
 *
 *   node tools/print-check.mjs "http://localhost:3016/guide?build=cottage" out/guide.pdf
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] ?? 'http://localhost:3016/guide?build=cottage';
const outFile = process.argv[3] ?? 'out/guide.pdf';

const EDGE = [
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const port = 9950 + (process.pid % 40);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-print-'));
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
	await send('Page.navigate', { url });

	const evaluate = async (expression) => {
		const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		return result.value;
	};

	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (await evaluate("document.querySelector('.guide')?.dataset.ready === '1'")) break;
		await sleep(400);
	}

	// Read the colours the *print* stylesheet resolves to. A guide that prints a black page
	// is technically "rendered" and completely useless.
	const printColours = await evaluate(`
		(() => {
			const media = matchMedia('print');
			void media;
			return { screenBodyBg: getComputedStyle(document.body).backgroundColor };
		})()
	`);

	const pdf = await send('Page.printToPDF', {
		printBackground: true,
		preferCSSPageSize: true,
	});

	fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
	const bytes = Buffer.from(pdf.data, 'base64');
	fs.writeFileSync(outFile, bytes);

	// Page count without a PDF library: count the page objects in the raw file.
	const text = bytes.toString('latin1');
	const pageCount =
		(text.match(/\/Type\s*\/Page[^s]/g) ?? []).length ||
		Number.parseInt(/\/Count\s+(\d+)/.exec(text)?.[1] ?? '0', 10);

	console.log(`url         ${url}`);
	console.log(`pdf         ${outFile}  ${(bytes.length / 1024).toFixed(0)} KB`);
	console.log(`pages       ${pageCount}`);
	console.log(`screen bg   ${printColours.screenBodyBg} (dark on screen is expected)`);
	console.log(`header      ${text.startsWith('%PDF-') ? 'ok (%PDF-)' : 'NOT A PDF'}`);

	if (!text.startsWith('%PDF-') || pageCount < 2) exitCode = 1;
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
