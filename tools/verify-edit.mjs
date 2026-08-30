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

/**
 * Any Chromium will do — the driver speaks CDP, not Edge.
 *
 * Listing the Linux paths as well as the Windows ones is what lets this run in CI and in a
 * container, where the only browser on disk is the one Playwright unpacked. `CM_BROWSER`
 * wins over both, for a checkout that keeps its browser somewhere else entirely.
 */
const BROWSER = [
	process.env.CM_BROWSER,
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
	'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
	'/opt/pw-browsers/chromium',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/usr/bin/google-chrome',
].find((p) => p && fs.existsSync(p));
if (!BROWSER) {
	console.error('no Chromium-based browser found — set CM_BROWSER to one');
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
	BROWSER,
	[
		'--headless=new',
		'--disable-gpu',
		'--use-gl=swiftshader',
		'--enable-unsafe-swiftshader',
		'--hide-scrollbars',
		// Extra flags for the machine this runs on. A container running as root needs
		// `--no-sandbox`, which is not something to hardcode for everyone else.
		...(process.env.CM_BROWSER_FLAGS ?? '').split(' ').filter(Boolean),
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

	/**
	 * Poll for a condition, forcing a frame each time round.
	 *
	 * Headless Chrome stops compositing once the page is visually static, and this editor
	 * reports both its meshing progress and its edit count from state that only advances when
	 * frames are being produced. So a wait on a page that has genuinely finished can time out
	 * having never been told. Capturing a throwaway frame is what forces a BeginFrame;
	 * `requestAnimationFrame` does not, because with compositing stopped the callback never
	 * runs and awaiting it hangs the driver outright.
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
	const TOOL_IDS = {
		Place: 'place', Erase: 'erase', Fill: 'fill', Box: 'select', Swap: 'swap',
		Line: 'line', Stamp: 'stamp', Pick: 'pick',
	};
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

	// --- brush, line, clipboard, pick, isolate --------------------------------
	// The tools added after the first five, driven the same way: real key events and real
	// clicks. Most of these read their result off the notice line, which is the same sentence
	// the user is shown — a check that passes while the user is told nothing is not a check
	// worth having.

	/** Keys that are not a letter need their real `code`, or the app sees `key: undefined`. */
	const CODES = {
		'=': ['Equal', 187], '-': ['Minus', 189], '[': ['BracketLeft', 219], ']': ['BracketRight', 221],
		'\\': ['Backslash', 220], '?': ['Slash', 191], Escape: ['Escape', 27],
	};
	const press = async (k, modifiers = 0) => {
		const [code, vk] = CODES[k] ?? [`Key${k.toUpperCase()}`, k.toUpperCase().charCodeAt(0)];
		const base = { key: k, code, windowsVirtualKeyCode: vk, modifiers };
		await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
		await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
		await sleep(120);
	};
	const altClick = async (x, y) => {
		await move(x, y);
		for (const type of ['mousePressed', 'mouseReleased']) {
			await send('Input.dispatchMouseEvent', {
				type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0,
				clickCount: 1, pointerType: 'mouse', modifiers: 1, // 1 = Alt
			});
		}
	};
	const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? null`);
	const editCount = () => evaluate("Number(document.querySelector('.editor').dataset.edits)");

	// Brush: two presses of "+" is a 5x5 brush, and one click has to remove more than one
	// block or the radius never reached the tool.
	await useTool('Erase');
	await press('=');
	await press('=');
	check('the brush grows on the keyboard', (await text('.tools__brush-size')) === '5×5', String(await text('.tools__brush-size')));

	const brushTarget = (await probe(null)) ?? target;
	const beforeBrush = await stats();
	await click(brushTarget.x, brushTarget.y);
	await meshed();
	const afterBrush = await stats();
	check('a wide brush erases more than one block', afterBrush.blocks < beforeBrush.blocks - 1, `${beforeBrush.blocks} → ${afterBrush.blocks}`);
	check('the brush says what it did', /Erased [\d,]+ blocks/.test(afterBrush.notice ?? ''), afterBrush.notice ?? '');
	await press('-');
	await press('-');

	// Shift-drag: one gesture across the build, landing as one edit rather than nine.
	await useTool('Place');
	const strokeFrom = (await probe(null)) ?? target;
	const beforeStroke = await stats();
	const editsBeforeStroke = await editCount();
	const SHIFT = 8;
	await move(strokeFrom.x, strokeFrom.y);
	await send('Input.dispatchMouseEvent', {
		type: 'mousePressed', x: strokeFrom.x, y: strokeFrom.y, button: 'left', buttons: 1,
		clickCount: 1, pointerType: 'mouse', modifiers: SHIFT,
	});
	for (let step = 1; step <= 8; step++) {
		await send('Input.dispatchMouseEvent', {
			type: 'mouseMoved', x: strokeFrom.x + step * 6, y: strokeFrom.y, button: 'left', buttons: 1,
			pointerType: 'mouse', modifiers: SHIFT,
		});
		await sleep(40);
	}
	await send('Input.dispatchMouseEvent', {
		type: 'mouseReleased', x: strokeFrom.x + 48, y: strokeFrom.y, button: 'left', buttons: 0,
		clickCount: 1, pointerType: 'mouse', modifiers: SHIFT,
	});
	await sleep(400);
	await meshed();
	const afterStroke = await stats();
	check('a shift-drag places along the whole drag', afterStroke.blocks > beforeStroke.blocks + 1, `${beforeStroke.blocks} → ${afterStroke.blocks}`);
	check('...as a single undo step', (await editCount()) === editsBeforeStroke + 1, `${editsBeforeStroke} → ${await editCount()} edits`);
	check('...and says so', /in one stroke/.test(afterStroke.notice ?? ''), afterStroke.notice ?? '');

	// Line: two clicks, one op, and a run of blocks between them.
	await useTool('Line');
	const lineA = (await probe(null)) ?? target;
	await click(lineA.x, lineA.y);
	await sleep(200);
	const lineB = (await probe(null, lineA)) ?? lineA;
	const beforeLine = await editCount();
	await click(lineB.x, lineB.y);
	await waitFor(`document.querySelector('.editor').dataset.edits === '${beforeLine + 1}'`, 'the line', 15_000);
	await meshed();
	const afterLine = await stats();
	check('a line is one edit, however long it is', /Drew a line of [\d,]+ blocks/.test(afterLine.notice ?? ''), afterLine.notice ?? '');

	// Alt-click samples the block under the pointer without editing anything.
	const pickTarget = (await probe(null)) ?? target;
	const editsBeforePick = await editCount();
	await altClick(pickTarget.x, pickTarget.y);
	await sleep(250);
	const sampled = await text('.picker__current .picker__name');
	check('Alt+click picks the block under the pointer', sampled === pickTarget.block, `${sampled} vs ${pickTarget.block}`);
	check('Alt+click changes nothing', (await editCount()) === editsBeforePick);

	// Copy a region with the box tool, then stamp it somewhere else.
	await useTool('Box');
	await evaluate(`
		(() => {
			const button = [...document.querySelectorAll('.tools__mode')].find((b) => b.textContent.trim() === 'Copy');
			if (!button) throw new Error('no Copy mode on the box tool');
			button.click();
			return true;
		})()
	`);
	const copyA = (await probe(null)) ?? target;
	await click(copyA.x, copyA.y);
	await sleep(200);
	const copyB = (await probe(null, copyA)) ?? copyA;
	await click(copyB.x, copyB.y);
	await sleep(300);
	const copied = await stats();
	check('copying takes the region without editing it', /Copied \d+×\d+×\d+/.test(copied.notice ?? ''), copied.notice ?? '');
	check('copying hands over to the stamp tool', (await evaluate("document.querySelector('.editor').dataset.tool")) === 'stamp');

	await press('r');
	check('R rotates the clipboard', /rotated/i.test((await text('.tools__notice')) ?? ''), (await text('.tools__notice')) ?? '');

	const stampTarget = (await probe(null, copyA)) ?? copyA;
	const beforeStamp = await editCount();
	await click(stampTarget.x, stampTarget.y);
	await waitFor(`document.querySelector('.editor').dataset.edits === '${beforeStamp + 1}'`, 'the stamp', 15_000);
	await meshed();
	check('stamping writes the clipboard into the build', /Stamped [\d,]+ blocks/.test((await stats()).notice ?? ''), (await stats()).notice ?? '');

	// Layer keys and the isolate slice.
	await press('[');
	// Against the URL, not the readout: with no cut at all the readout already says
	// "y 0–<top>", so a check that only read it would pass while nothing had happened.
	const cut = await evaluate("new URLSearchParams(location.search).get('layer')");
	check('[ cuts the build at a layer', cut !== null && Number(cut) >= 0, `layer=${cut}`);
	await press('i');
	// Waited for rather than read once: a re-render on the 202k-block build takes longer than
	// the pause after a keypress, and a single read here was checking the previous frame.
	let isolated = null;
	for (let i = 0; i < 40; i++) {
		isolated = await text('.layers__value');
		if (/^y \d+$/.test(isolated ?? '')) break;
		await sleep(150);
	}
	check('I isolates that layer alone', /^y \d+$/.test(isolated ?? ''), isolated ?? '');
	await press('\\');
	await waitFor("!new URLSearchParams(location.search).has('layer')", 'the layer cut to clear', 10_000);
	check('\\ shows every layer again', true);

	// The shortcut sheet, which is the only place several of these keys are written down.
	await press('?');
	check('? opens the shortcut sheet', (await evaluate("!!document.querySelector('.sheet')")) === true);
	await press('Escape');
	check('Escape closes it', (await evaluate("!!document.querySelector('.sheet')")) === false);

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
