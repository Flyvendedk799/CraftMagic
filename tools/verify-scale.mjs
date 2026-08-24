/**
 * Prove the scale control actually resizes a build, live.
 *
 * The reported bug was that scaling did nothing — and it did not, because no scale control
 * existed: the only slider was whatever `params` a program happened to declare, which for the
 * cottage was a two-position "floors". So this checks the thing that was missing rather than
 * that a slider moves: does dragging change the *dimensions*, in both linked and per-axis
 * mode, and does the URL carry it.
 *
 * Free — no model is called.
 *
 *   node tools/verify-scale.mjs [origin]
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

const port = 9600 + (process.pid % 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-scale-'));
const browser = spawn(
  EDGE,
  [
    '--headless=new', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    '--hide-scrollbars', '--window-size=1400,950',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let wsUrl;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch { /* starting */ }
    if (!wsUrl) await sleep(250);
  }

  const socket = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    socket.addEventListener('open', res, { once: true });
    socket.addEventListener('error', () => rej(new Error('devtools socket failed')), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      waiter(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluate failed');
    return result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `${ORIGIN}/?build=cottage` });

  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate("document.querySelector('.editor')?.dataset.remaining === '0'")) return;
      await sleep(200);
    }
    throw new Error('the editor never finished meshing');
  };
  await settle();

  // Details is collapsed by default, so open it the way a person would before reading it.
  const openSection = (title) =>
    evaluate(`(() => {
      const head = [...document.querySelectorAll('.section__head')]
        .find((h) => h.textContent.includes(${JSON.stringify(title)}));
      if (!head || head.getAttribute('aria-expanded') === 'true') return false;
      head.click();
      return true;
    })()`);
  await openSection('Details');
  await sleep(300);

  /** The stat readouts, which is what a person actually watches while dragging. */
  const stats = () =>
    evaluate(`(() => {
      const at = (name) => [...document.querySelectorAll('.hud dt')]
        .find((d) => d.textContent.trim() === name)?.nextElementSibling?.textContent?.trim();
      return { size: at('Size'), blocks: at('Blocks'), url: location.search };
    })()`);

  /** Move a range input the way a user does, so React sees it. */
  const drag = (selector, value) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(${value}));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);

  /** "6,740" → 6740, so block counts can be compared rather than only differenced. */
  const blocks = (s) => Number(String(s.blocks).replace(/[^0-9]/g, ''));

  const before = await stats();
  check('the scale panel exists', await evaluate("!!document.querySelector('.scale')"));
  check('it starts linked', await evaluate("!!document.querySelector('.scale__mode--on')"));
  check('one slider while linked', (await evaluate("document.querySelectorAll('.scale .param__slider').length")) === 1);

  // --- linked -------------------------------------------------------------------------------
  await drag('.scale .param__slider', 200);
  await settle();
  const doubled = await stats();
  check('doubling changes the size', doubled.size !== before.size, `${before.size} → ${doubled.size}`);
  check('and the block count', doubled.blocks !== before.blocks, `${before.blocks} → ${doubled.blocks}`);
  check('the URL carries the scale', /s\.x=200/.test(doubled.url), doubled.url);

  const [bx, by, bz] = before.size.split('×').map(Number);
  const [dx, dy, dz] = doubled.size.split('×').map(Number);
  check('every axis grew', dx > bx && dy > by && dz > bz, `${bx},${by},${bz} → ${dx},${dy},${dz}`);

  // The one that matters, and the one the earlier checks missed: a bigger *volume* is not a
  // bigger *build*. Doubling every axis has to multiply the blocks several times over — a
  // hollow structure grows with its surface area, so 4x is the conservative floor. When
  // scaling only moved anchored coordinates, the cottage managed 3.7x and the tower 1.0x.
  check(
    'the building itself got bigger, not just its plot',
    blocks(doubled) > blocks(before) * 4,
    `${blocks(before)} → ${blocks(doubled)} blocks (${(blocks(doubled) / blocks(before)).toFixed(1)}x)`,
  );

  // --- per axis ------------------------------------------------------------------------------
  await evaluate(`[...document.querySelectorAll('.scale__mode')].find(b => b.textContent.includes('Per axis')).click()`);
  await settle();
  check('unlinking shows three sliders',
    (await evaluate("document.querySelectorAll('.scale .param__slider').length")) === 3);

  // Height only. Width and depth must not move — that is the whole point of per-axis.
  await drag('.scale .param:nth-of-type(2) .param__slider', 400);
  await settle();
  const tall = await stats();
  const [tx, ty, tz] = tall.size.split('×').map(Number);
  check('height alone changed', ty > dy, `${dy} → ${ty}`);
  check('width and depth held', tx === dx && tz === dz, `${tx}×${tz} vs ${dx}×${dz}`);

  // --- reset ----------------------------------------------------------------------------------
  await evaluate(`document.querySelector('.scale__reset')?.click()`);
  await settle();
  const reset = await stats();
  check('reset restores the original size', reset.size === before.size, `${reset.size}`);
  check('and clears the URL', !/s\./.test(reset.url), reset.url || '(clean)');

  // --- the cap --------------------------------------------------------------------------------
  await evaluate(`[...document.querySelectorAll('.scale__mode')].find(b => b.textContent.includes('Linked')).click()`);
  await settle();
  await drag('.scale .param__slider', 400);
  await settle();
  const maxed = await stats();
  const [mx, my, mz] = maxed.size.split('×').map(Number);
  check('the engine cap is respected', mx <= 256 && my <= 160 && mz <= 256, maxed.size);

  // --- a build with nothing anchored ------------------------------------------------------
  // The tower is a cylinder of literal radius on a `$height` param: not one coordinate in it
  // refers to the build volume, so it is the build a volume-only resize cannot touch at all.
  await send('Page.navigate', { url: `${ORIGIN}/?build=tower` });
  await settle();
  await openSection('Details');
  await sleep(300);
  const towerBefore = await stats();

  await send('Page.navigate', { url: `${ORIGIN}/?build=tower&s.x=200&s.y=200&s.z=200` });
  await settle();
  await openSection('Details');
  await sleep(300);
  const towerBig = await stats();
  check(
    'a build with no anchored coordinates resizes too',
    blocks(towerBig) > blocks(towerBefore) * 3,
    `${blocks(towerBefore)} → ${blocks(towerBig)} blocks (${(blocks(towerBig) / blocks(towerBefore)).toFixed(1)}x)`,
  );

  fs.mkdirSync('out', { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('out/scale.png', Buffer.from(shot.data, 'base64'));
  console.log('\nshot: out/scale.png');

  socket.close();
} catch (err) {
  console.error(`\n${err.message}`);
  failures++;
} finally {
  browser.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nscale verified' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
