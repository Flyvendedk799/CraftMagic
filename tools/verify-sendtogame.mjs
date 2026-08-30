/**
 * Drive "Send to game" from the browser, into a real Minecraft server.
 *
 * The protocol test covers the wire and the in-game test covers the bot; this covers the
 * part a person actually touches — clicking Pair, reading the code, and watching progress.
 * It reads the pairing code off the rendered page rather than the API, so a broken display
 * fails here rather than confusing a user later.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { seedBrowserSession, signIn, throwawayCredentials } from './session.mjs';

const ORIGIN = process.env.CM_ORIGIN ?? 'http://localhost:3016';
const RCON_HOST = '127.0.0.1';
const RCON_PORT = 25575;
const RCON_PASSWORD = 'craftmagic';
const AT = { x: 100, y: -59, z: 100 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, ok, detail = '') {
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
}

class Rcon {
	#socket; #id = 0; #pending = new Map(); #buffer = Buffer.alloc(0);
	async connect() {
		this.#socket = net.createConnection({ host: RCON_HOST, port: RCON_PORT });
		this.#socket.on('data', (c) => this.#onData(c));
		await new Promise((res, rej) => { this.#socket.once('connect', res); this.#socket.once('error', rej); });
		await this.#send(3, RCON_PASSWORD);
	}
	#onData(chunk) {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		while (this.#buffer.length >= 4) {
			const size = this.#buffer.readInt32LE(0);
			if (this.#buffer.length < size + 4) break;
			const id = this.#buffer.readInt32LE(4);
			const body = this.#buffer.subarray(12, size + 2).toString('utf8');
			this.#buffer = this.#buffer.subarray(size + 4);
			const w = this.#pending.get(id) ?? this.#pending.get(-1);
			if (w) { this.#pending.delete(w.id); w.resolve(body); }
		}
	}
	#send(type, body) {
		const id = ++this.#id;
		const payload = Buffer.from(body, 'utf8');
		const packet = Buffer.alloc(14 + payload.length);
		packet.writeInt32LE(10 + payload.length, 0);
		packet.writeInt32LE(id, 4);
		packet.writeInt32LE(type, 8);
		payload.copy(packet, 12);
		this.#socket.write(packet);
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error(`RCON timeout: ${body}`)), 20000);
			this.#pending.set(id, { id, resolve: (v) => { clearTimeout(t); resolve(v); } });
		});
	}
	cmd(text) { return this.#send(2, text); }
	close() { this.#socket?.end(); }
}

const EDGE = [
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const port = 9600 + (process.pid % 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-stg-'));
const browser = spawn(EDGE, [
	'--headless=new', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
	'--hide-scrollbars', '--window-size=1400,950',
	`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

function cdp(socket) {
	let nextId = 1;
	const pending = new Map();
	socket.addEventListener('message', (event) => {
		const msg = JSON.parse(event.data);
		const w = pending.get(msg.id);
		if (!w) return;
		pending.delete(msg.id);
		msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
	});
	return (method, params = {}) => new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		socket.send(JSON.stringify({ id, method, params }));
	});
}

const rcon = new Rcon();
let exitCode = 0;
try {
	await rcon.connect();
	check('connected to Minecraft over RCON', true);

	await rcon.cmd(`forceload add ${AT.x} ${AT.z} ${AT.x + 32} ${AT.z + 32}`);
	await rcon.cmd(`fill ${AT.x} ${AT.y} ${AT.z} ${AT.x + 24} ${AT.y + 20} ${AT.z + 16} air`);

	// Pairing belongs to an account, so the browser needs a session before it can click Pair.
	// Obtained over HTTP and seeded into the browser rather than typed into the sign-in form:
	// verify-library.mjs already drives that form, and repeating it here would only give an
	// unrelated test a second way to fail.
	const session = await signIn(ORIGIN, throwawayCredentials('sendtogame-verify'));
	const authed = (url, options = {}) =>
		fetch(`${ORIGIN}${url}`, {
			...options,
			headers: { 'Content-Type': 'application/json', Cookie: session.cookie, ...(options.headers ?? {}) },
		});

	// Start unpaired so the UI has to do the pairing.
	for (const agent of (await (await authed('/api/agent/agents')).json()).agents ?? []) {
		await authed(`/api/agent/agents/${agent.id}`, { method: 'DELETE' });
	}
	await rcon.cmd('craftmagic unpair');
	check('started from an unpaired world', true);

	let wsUrl;
	for (let i = 0; i < 60 && !wsUrl; i++) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			wsUrl = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
		} catch { /* starting */ }
		if (!wsUrl) await sleep(250);
	}
	const socket = new WebSocket(wsUrl);
	await new Promise((res, rej) => {
		socket.addEventListener('open', res, { once: true });
		socket.addEventListener('error', () => rej(new Error('devtools socket failed')), { once: true });
	});

	const send = cdp(socket);
	await send('Page.enable');
	await send('Runtime.enable');
	// Before the first navigation: a cookie set afterwards would not be on the request that
	// fetched the page, and the panel would render its signed-out state.
	await seedBrowserSession(send, ORIGIN, session.cookie);
	await send('Page.navigate', { url: `${ORIGIN}/?build=cottage` });

	const evaluate = async (expression) => {
		const { result, exceptionDetails } = await send('Runtime.evaluate', {
			expression, returnByValue: true, awaitPromise: true,
		});
		if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluate failed');
		return result.value;
	};
	const waitFor = async (expr, label, ms = 60000) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (await evaluate(expr)) return true;
			await sleep(400);
		}
		throw new Error(`timed out waiting for ${label}`);
	};
	const clickText = async (selector, text) => evaluate(`
		(() => {
			const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
				.find((n) => n.textContent.trim().includes(${JSON.stringify(text)}));
			if (!el) return false;
			el.click();
			return true;
		})()
	`);

	await waitFor("document.querySelector('.editor')?.dataset.remaining === '0'", 'the editor');
	check('editor loaded', true);

	check('Send to game panel is present', await evaluate("!!document.querySelector('.agent')"));
	check(
		'the browser is signed in',
		(await evaluate("document.querySelector('.account')?.dataset.state")) === 'signed-in',
		session.email,
	);

	check('clicked "Pair a world…"', await clickText('.agent__pair', 'Pair a world'));
	await waitFor("!!document.querySelector('.agent__code')", 'the pairing code');

	// Read the code off the page, exactly as a person would.
	const shown = await evaluate("document.querySelector('.agent__code').textContent.trim()");
	const code = /pair\s+([A-Z0-9]{6})/i.exec(shown)?.[1];
	check('the UI shows a pairing command', Boolean(code), shown);

	await rcon.cmd(`craftmagic server ${ORIGIN}`);
	await rcon.cmd(`craftmagic pair ${code}`);
	check('typed that command in game', true, `/craftmagic pair ${code}`);

	// The panel polls while a code is displayed, so the world should appear without a reload.
	await waitFor("!!document.querySelector('.agent__dot--on')", 'the world to come online');
	const worldName = await evaluate("document.querySelector('.agent__row .agent__name')?.textContent?.trim() ?? ''");
	check('the world appears online in the UI', true, worldName.slice(0, 40));

	check('clicked "Build here"', await clickText('.agent__send', 'Build here'));

	await waitFor("(document.querySelector('.agent__status')?.textContent ?? '').includes('/craftmagic build')", 'the ready prompt');
	check('UI tells the player to place it', true);

	await rcon.cmd('craftmagic speed 0');
	await rcon.cmd(`craftmagic place ${AT.x} ${AT.y} ${AT.z}`);

	await waitFor("(document.querySelector('.agent__status--ok')?.textContent ?? '').includes('Built')", 'the build to finish');
	const doneText = await evaluate("document.querySelector('.agent__status--ok').textContent.trim()");
	check('UI reports the finished build', true, doneText.slice(0, 60));

	const foundation = await rcon.cmd(`execute if block ${AT.x} ${AT.y} ${AT.z} minecraft:stone_bricks`);
	check('blocks exist in the world', /Test passed/i.test(foundation));

	const shot = await send('Page.captureScreenshot', { format: 'png' });
	fs.mkdirSync('out', { recursive: true });
	fs.writeFileSync('out/send-to-game.png', Buffer.from(shot.data, 'base64'));
	console.log('\nshot: out/send-to-game.png');

	await rcon.cmd(`forceload remove ${AT.x} ${AT.z} ${AT.x + 32} ${AT.z + 32}`);
	socket.close();
} catch (err) {
	console.error(`\n${err.message}`);
	exitCode = 1;
} finally {
	rcon.close();
	browser.kill();
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

console.log(failures === 0 && exitCode === 0 ? '\nsend-to-game verified from the browser' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? exitCode : 1;
