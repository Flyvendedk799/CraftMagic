/**
 * End-to-end check of the editing tools, driven as a user hits them.
 *
 * Nothing here calls into the app's own code. The clicks are real CDP mouse events on the
 * canvas, so the whole chain is exercised — pointer listener, DDA pick, tool, `EditOp`,
 * `VoxelWorld.applyEdit`, chunk re-mesh, HUD. Unit tests cover the ops; this covers the
 * wiring, which is the part that has never once been broken in a way a unit test noticed.
 *
 * The click target is *probed* rather than assumed. The camera framing depends on the build
 * size, so a hard-coded centre pixel is a coin flip; instead the driver moves the pointer
 * over a few candidate points and reads the hover readout until it reports a real block.
 *
 *   node tools/verify-edit.mjs [build] [out/edit.png]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const buildId = process.argv[2] ?? 'cottage';
const outFile = process.argv[3] ?? 'out/verify-edit.png';
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-edit-'));
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
		if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluate failed');
		return result.value;
	};

	const waitFor = async (expression, label, timeoutMs = 30_000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await evaluate(expression)) return true;
			await sleep(120);
		}
		throw new Error(`timed out waiting for ${label}`);
	};

	const meshed = () => waitFor("document.querySelector('.editor')?.dataset.remaining === '0'", 'meshing');
	const stats = () =>
		evaluate(`
			(() => {
				const el = document.querySelector('.editor');
				const dd = [...document.querySelectorAll('.hud__stats dd')].map((n) => n.textContent);
				return {
					blocks: Number(dd[2].replace(/[^0-9]/g, '')),
					palette: Number(dd[3]),
					edits: Number(el.dataset.edits),
					detached: el.dataset.detached,
					tools: !!document.querySelector('.tools'),
					toolLabels: [...document.querySelectorAll('.tools__tool')].map((b) => b.textContent.trim()),
					undoDisabled: document.querySelector('.tools__row--history button').disabled,
					notice: document.querySelector('.tools__notice')?.textContent ?? null,
				};
			})()
		`);

	const move = (x, y) =>
		send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'mouse' });
	const click = async (x, y) => {
		await move(x, y);
		await send('Input.dispatchMouseEvent', {
			type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse',
		});
		await send('Input.dispatchMouseEvent', {
			type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse',
		});
	};
	const key = async (text, modifiers) => {
		const base = { key: text, code: `Key${text.toUpperCase()}`, windowsVirtualKeyCode: text.toUpperCase().charCodeAt(0), modifiers };
		await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
		await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
	};

	await send('Page.navigate', { url: `${ORIGIN}/?build=${buildId}` });
	await waitFor("!!document.querySelector('.editor')", 'editor', 30_000);
	await meshed();
	// Details holds the block and palette counts this driver reads, and starts collapsed.
	await evaluate(openSection('Details'));
	await sleep(500);

	const before = await stats();
	console.log(`\nbuild "${buildId}": ${before.blocks} blocks, palette ${before.palette}\n`);
	check('tool palette renders', before.tools, before.toolLabels.join(' / '));
	check('undo starts disabled', before.undoDisabled === true);
	check('starts unmodified', before.edits === 0 && before.detached === 'false');

	// Probe for a pixel that actually sits on the build. The hover readout names the block
	// under the cursor, so "Air" or the idle text means the ray missed.
	const OFFSETS = [
		[0, 0], [0, 60], [60, 0], [-60, 40], [0, -60], [90, 90], [-90, -40],
		[40, 120], [-120, 100], [140, -30], [-40, 150], [110, 40],
	];
	const probe = async (want, avoid) => {
		let fallback = null;
		for (const [dx, dy] of OFFSETS) {
			const x = Math.round(WIDTH / 2 + dx);
			const y = Math.round(HEIGHT / 2 + dy);
			// Later probes must not land back on a block this run placed itself: a lone new
			// block is a one-cell region, which would make a flood fill look broken.
			if (avoid && Math.abs(x - avoid.x) < 40 && Math.abs(y - avoid.y) < 40) continue;
			await move(x, y);
			await sleep(80);
			const block = await evaluate("document.querySelector('.hover-readout strong')?.textContent ?? null");
			if (!block || block === 'Air') continue;
			if (!want || want.includes(block)) return { x, y, block };
			fallback ??= { x, y, block };
		}
		return fallback;
	};

	const target = await probe(null);
	if (!target) throw new Error('could not find a pixel over the build to click');
	console.log(`\nclicking ${target.x},${target.y} — over ${target.block}\n`);

	// --- place --------------------------------------------------------------
	const placedAt = Date.now();
	await click(target.x, target.y);
	await waitFor("document.querySelector('.editor').dataset.edits === '1'", 'the edit to register', 10_000);
	await meshed();
	const placeMs = Date.now() - placedAt;
	const afterPlace = await stats();

	check('block count went up by one', afterPlace.blocks === before.blocks + 1, `${before.blocks} → ${afterPlace.blocks}`);
	check('edit counted', afterPlace.edits === 1);
	check('build marked modified', afterPlace.detached === 'true');
	// The default block is oak planks, which the cottage already uses: the palette must reuse
	// that slot rather than append a duplicate. Growth is checked below, on a block the
	// program never touched.
	check('palette reused the existing slot', afterPlace.palette === before.palette, `${before.palette} → ${afterPlace.palette}`);
	check('undo became available', afterPlace.undoDisabled === false);
	console.log(`        place → re-meshed in ${placeMs} ms`);

	// --- undo, by keyboard ---------------------------------------------------
	const undoAt = Date.now();
	await key('z', 2); // 2 = Ctrl
	await waitFor("document.querySelector('.editor').dataset.edits === '0'", 'the undo', 10_000);
	await meshed();
	const undoMs = Date.now() - undoAt;
	const afterUndo = await stats();

	check('Ctrl+Z restored the block count', afterUndo.blocks === before.blocks, `${afterPlace.blocks} → ${afterUndo.blocks}`);
	check('edit count back to zero', afterUndo.edits === 0);
	console.log(`        Ctrl+Z → re-meshed in ${undoMs} ms`);

	// --- redo, by button -----------------------------------------------------
	await evaluate(`
		(() => {
			const button = [...document.querySelectorAll('.tools__row--history button')]
				.find((b) => b.textContent.includes('Redo'));
			if (!button || button.disabled) throw new Error('Redo button not available');
			button.click();
			return true;
		})()
	`);
	await waitFor("document.querySelector('.editor').dataset.edits === '1'", 'the redo', 10_000);
	await meshed();
	const afterRedo = await stats();
	check('Redo button re-applied the edit', afterRedo.blocks === before.blocks + 1, `${afterUndo.blocks} → ${afterRedo.blocks}`);

	// --- fill ----------------------------------------------------------------
	// Selected by `data-tool` rather than by the button's text: the buttons now carry their
	// keyboard shortcut inside them, so matching on textContent broke on "Place1".
	const TOOL_IDS = { Place: 'place', Erase: 'erase', Fill: 'fill', Box: 'select', Swap: 'swap' };
	const useTool = (label) =>
		evaluate(`
			(() => {
				const button = document.querySelector('.tools__tool[data-tool=' + JSON.stringify(${JSON.stringify(TOOL_IDS)}[${JSON.stringify(label)}]) + ']');
				if (!button) throw new Error('no such tool: ' + ${JSON.stringify(label)});
				button.click();
				return true;
			})()
		`);

	/** Open the picker, type a term, take the first match. Returns its display name. */
	const pickBlock = async (term) => {
		await evaluate("(() => { document.querySelector('.picker__current').click(); return true; })()");
		await evaluate(`
			(() => {
				const input = document.querySelector('.picker__search');
				const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				setter.call(input, ${JSON.stringify(term)});
				input.dispatchEvent(new Event('input', { bubbles: true }));
				return true;
			})()
		`);
		await sleep(150);
		return evaluate(`
			(() => {
				const item = document.querySelector('.picker__item');
				if (!item) return null;
				const name = item.textContent.trim();
				item.click();
				return name;
			})()
		`);
	};

	await useTool('Fill');
	// A block the build does not already use, so the fill is visible and the palette grows.
	const picked = await pickBlock('crimson_planks');
	check('block picker filters and selects', picked === 'Crimson Planks', String(picked));

	// Aim the fill at a large flat surface rather than wherever the first probe landed —
	// a stair block is its own palette entry per facing, so filling one proves nothing.
	const fillTarget = (await probe(['Oak Planks', 'Stone Bricks', 'Dark Oak Planks'], target)) ?? target;
	const fillAt = Date.now();
	await click(fillTarget.x, fillTarget.y);
	await waitFor("document.querySelector('.editor').dataset.edits === '2'", 'the fill', 15_000);
	await meshed();
	const fillMs = Date.now() - fillAt;
	const afterFill = await stats();
	const filled = Number((afterFill.notice ?? '').replace(/[^0-9]/g, ''));
	check('fill spread across the surface', filled > 1, `${afterFill.notice ?? '(no notice)'} (on ${fillTarget.block})`);
	check('palette grew for a block the program never used', afterFill.palette === before.palette + 1, `${before.palette} → ${afterFill.palette}`);
	console.log(`        fill → re-meshed in ${fillMs} ms`);

	// --- box select, two corners ---------------------------------------------
	await useTool('Box');
	await evaluate(`
		(() => {
			const button = [...document.querySelectorAll('.tools__mode')].find((b) => b.textContent.trim() === 'Clear');
			button.click();
			return true;
		})()
	`);

	const cornerA = await probe(null, target);
	await click(cornerA.x, cornerA.y);
	await sleep(250);
	const anchored = await evaluate("document.querySelector('.tools')?.textContent ?? ''");
	check('first corner is held, not applied', /Corner at \d+, \d+, \d+/.test(anchored) && (await stats()).edits === 2);

	const cornerB = (await probe(null, cornerA)) ?? cornerA;
	const beforeBox = await stats();
	await click(cornerB.x, cornerB.y);
	await waitFor("document.querySelector('.editor').dataset.edits === '3'", 'the box edit', 15_000);
	await meshed();
	const afterBox = await stats();
	check('box clear removed blocks', afterBox.blocks < beforeBox.blocks, `${beforeBox.blocks} → ${afterBox.blocks}`);
	check('box reported its extent', /box — [\d,]+ blocks changed/.test(afterBox.notice ?? ''), afterBox.notice ?? '');

	// --- palette swap ---------------------------------------------------------
	await useTool('Swap');
	const swapTo = await pickBlock('quartz_block');
	check('picker reaches a second block', swapTo === 'Quartz Block', String(swapTo));

	const swapTarget = (await probe(['Crimson Planks'], null)) ?? (await probe(null, null));
	const beforeSwap = await stats();
	await click(swapTarget.x, swapTarget.y);
	await waitFor("document.querySelector('.editor').dataset.edits === '4'", 'the swap', 15_000);
	await meshed();
	const afterSwap = await stats();
	const swapped = Number((afterSwap.notice ?? '').replace(/[^0-9]/g, ''));
	check('swap rewrote a whole palette slot', swapped > 1, `${afterSwap.notice ?? ''} (was ${swapTarget.block})`);
	check('swap kept the block count', afterSwap.blocks === beforeSwap.blocks, `${beforeSwap.blocks} → ${afterSwap.blocks}`);

	// --- the re-expansion guard ----------------------------------------------
	const guard = await evaluate(`
		(() => {
			// Not just any slider: Scale now renders first and steps in fives, so nudging it by
			// one snaps back to the same value and React never fires a change at all. This
			// check is about a *shape* param, which lives in the panel that is not .scale.
			const slider = document.querySelector('.params:not(.scale) .param__slider');
			if (!slider) return 'no shape params on this build';
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
			const step = Number(slider.step) || 1;
			const next = Number(slider.value) + step <= Number(slider.max)
				? Number(slider.value) + step
				: Number(slider.value) - step;
			setter.call(slider, String(next));
			slider.dispatchEvent(new Event('input', { bubbles: true }));
			return null;
		})()
	`);
	if (guard) {
		console.log(`  skip  re-expansion guard — ${guard}`);
	} else {
		await sleep(300);
		const warned = await evaluate(`
			(() => {
				const el = document.querySelector('.detach');
				return { shown: !!el, text: el?.textContent ?? null, edits: document.querySelector('.editor').dataset.edits };
			})()
		`);
		check('moving a param slider asks before discarding edits', warned.shown, warned.text ?? '');
		check('edits survive until the answer', warned.edits === '4', `${warned.edits} edits`);
		await evaluate("document.querySelectorAll('.detach__actions button')[1].click()");
	}

	// --- the shortcut must not fight the prompt box ---------------------------
	await evaluate("(() => { document.querySelector('.prompt__input').focus(); return true; })()");
	await key('z', 2);
	await sleep(300);
	const withFocus = await stats();
	check('Ctrl+Z inside the prompt textarea does not undo', withFocus.edits === 4, `${withFocus.edits} edits`);
	await evaluate("(() => { document.querySelector('.prompt__input').blur(); return true; })()");

	await sleep(400);
	const shot = await send('Page.captureScreenshot', { format: 'png' });
	fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
	fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));

	const end = await stats();
	console.log(`\nfinal: ${end.blocks} blocks, ${end.edits} edits, palette ${end.palette}`);
	console.log(`shot   ${outFile}  ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB\n`);

	// --- revert, after the screenshot ----------------------------------------
	// The only path that reloads the whole world from a restored grid, so nothing else
	// proves the pre-edit voxels were really kept rather than merely promised.
	await evaluate(`
		(() => {
			const button = [...document.querySelectorAll('.tools__inline')].find((b) => b.textContent.trim() === 'revert');
			if (!button) throw new Error('revert not offered');
			button.click();
			return true;
		})()
	`);
	await waitFor("document.querySelector('.editor').dataset.edits === '0'", 'the revert', 15_000);
	await meshed();
	const reverted = await stats();
	check('revert restored the expanded build exactly', reverted.blocks === before.blocks && reverted.palette === before.palette, `${end.blocks} → ${reverted.blocks} blocks, palette ${end.palette} → ${reverted.palette}`);
	check('revert cleared the modified flag', reverted.detached === 'false' && reverted.undoDisabled === true);
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
