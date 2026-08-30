/**
 * End-to-end UI test: type a prompt, click Generate, wait for the build to load.
 *
 * This is the only way to exercise the whole M2 path — prompt box, POST, SSE progress,
 * program returned, browser-side expansion, meshing — as a user actually hits it. It costs
 * one real generation, so it prints the spend before and after.
 *
 *   node tools/drive-generate.mjs "a small stone windmill" out/shot.png
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const prompt = process.argv[2] ?? 'a small stone windmill with a wooden roof';
const outFile = process.argv[3] ?? 'generated.png';
const ORIGIN = process.env.CM_ORIGIN ?? 'http://localhost:3016';

const EDGE = [
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) {
	console.error('Edge not found');
	process.exitCode = 1;
}

const port = 9400 + (process.pid % 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-drive-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(
	EDGE,
	[
		'--headless=new',
		'--disable-gpu',
		'--use-gl=swiftshader',
		'--enable-unsafe-swiftshader',
		'--hide-scrollbars',
		'--window-size=1280,900',
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
	await send('Page.navigate', { url: `${ORIGIN}/?build=cottage` });

	const evaluate = async (expression) => {
		const { result, exceptionDetails } = await send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluate failed');
		return result.value;
	};

	const waitFor = async (expression, label, timeoutMs) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await evaluate(expression)) return true;
			await sleep(400);
		}
		throw new Error(`timed out waiting for ${label}`);
	};

	await waitFor("!!document.querySelector('.prompt__input')", 'prompt box', 30_000);
	console.log(`spend before: ${await evaluate("fetch('/api/spend').then(r=>r.json()).then(s=>`$${s.remainingUsd.toFixed(2)} left`)")}`);

	// React owns the textarea's value, so setting `.value` directly is ignored on the next
	// render. Going through the prototype setter and dispatching a bubbling input event is
	// what makes React's onChange actually fire.
	await evaluate(`
		(() => {
			const el = document.querySelector('.prompt__input');
			const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
			setter.call(el, ${JSON.stringify(prompt)});
			el.dispatchEvent(new Event('input', { bubbles: true }));
			return el.value;
		})()
	`);

	await evaluate(`
		(() => {
			const button = [...document.querySelectorAll('.prompt__actions button')]
				.find((b) => b.textContent.trim() === 'Generate');
			if (!button) throw new Error('Generate button not found');
			button.click();
			return true;
		})()
	`);
	console.log('clicked Generate; waiting for the build…');

	// The generated build becomes the selected one, which shows up in `data-build`.
	await waitFor(
		"document.querySelector('.editor')?.dataset.build?.startsWith('gen:') || !!document.querySelector('.prompt__status--error')",
		'generation to finish',
		180_000,
	);

	const failure = await evaluate(
		"document.querySelector('.prompt__status--error')?.textContent ?? null",
	);
	if (failure) throw new Error(`UI reported: ${failure}`);

	await waitFor("document.querySelector('.editor')?.dataset.remaining === '0'", 'meshing', 60_000);
	await sleep(800);

	const summary = await evaluate(`
		(() => {
			const dd = [...document.querySelectorAll('.hud__stats dd')].map((n) => n.textContent);
			return {
				build: document.querySelector('.editor').dataset.build,
				name: dd[0], size: dd[1], blocks: dd[2],
				cost: document.querySelector('.hud__generated')?.textContent?.trim() ?? null,
				budget: document.querySelector('.prompt__budget')?.textContent?.trim() ?? null,
				params: [...document.querySelectorAll('.param')].map((p) => p.textContent.trim()),
			};
		})()
	`);

	const shot = await send('Page.captureScreenshot', { format: 'png' });
	fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
	fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));

	console.log('\n--- generated in the browser ---');
	console.log(`build   ${summary.build}`);
	console.log(`name    ${summary.name}`);
	console.log(`size    ${summary.size}`);
	console.log(`blocks  ${summary.blocks}`);
	console.log(`params  ${summary.params.join(' | ') || '(none)'}`);
	console.log(`cost    ${summary.cost ?? '(not shown)'}`);
	console.log(`budget  ${summary.budget ?? '(not shown)'}`);
	console.log(`shot    ${outFile}`);

	socket.close();
} catch (err) {
	console.error(`\n${err.message}`);
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
