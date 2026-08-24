/**
 * Check a deployed CraftMagic instance over the public internet.
 *
 * Everything here is free — no Anthropic call is made, because the point is to prove the
 * deployment is wired up, not to spend the month's budget confirming it. The generation
 * route is checked only for *reachability and refusal*, never by generating anything.
 *
 *   node tools/verify-deployed.mjs [origin]
 */

const ORIGIN = (process.argv[2] ?? process.env.CM_ORIGIN ?? 'http://85.190.100.23:3016').replace(/\/+$/, '');

let failures = 0;
let warnings = 0;

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
function note(label, detail) {
  console.log(`  ....  ${label}${detail ? ` — ${detail}` : ''}`);
  warnings++;
}

async function get(pathname, init) {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    signal: AbortSignal.timeout(20000),
    redirect: 'manual',
    ...init,
  });
  const text = await response.text();
  return { response, text };
}

console.log(`verifying ${ORIGIN}\n`);

// --- the service is up -------------------------------------------------------------------
try {
  const { response, text } = await get('/api/health');
  const body = JSON.parse(text);
  check('health responds', response.ok && body.ok === true, `${response.status} ${body.service ?? ''}`);

  // Reported by the health route only once it knows; older builds omit it entirely.
  if (typeof body.database === 'string') {
    check('database connected', body.database === 'connected', body.database);
  } else {
    note('health does not report database state', 'cannot tell whether pairing works');
  }
} catch (err) {
  check('health responds', false, err.message);
}

// --- the web app is served ---------------------------------------------------------------
try {
  const { response, text } = await get('/');
  const isHtml = /<div id="root"|<title>/i.test(text);
  check('web app is served', response.ok && isHtml, `${response.status}, ${text.length} bytes`);

  // A served index.html that points at a missing bundle is the classic "deployed the wrong
  // dist" failure, and it looks completely fine until the browser runs.
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(text)?.[1];
  if (asset) {
    const bundle = await get(asset);
    check('js bundle loads', bundle.response.ok, `${asset} → ${bundle.response.status}`);
  } else {
    note('no hashed js bundle referenced in index.html');
  }
} catch (err) {
  check('web app is served', false, err.message);
}

// --- deep links resolve to the SPA -------------------------------------------------------
// The editor and guide are client-side routes; the server has to fall through to index.html
// for them or a shared link 404s.
for (const route of ['/editor', '/guide']) {
  try {
    const { response, text } = await get(route);
    check(`${route} falls through to the app`, response.ok && /<div id="root"|<title>/i.test(text), String(response.status));
  } catch (err) {
    check(`${route} falls through to the app`, false, err.message);
  }
}

// --- the mod is downloadable ---------------------------------------------------------------
// Without this the pairing instructions are unusable: they tell a player to run a command that
// only exists once they have the jar.
try {
  const { response, text } = await get('/mod/manifest.json');
  const manifest = response.ok ? JSON.parse(text) : null;
  check('mod manifest served', Boolean(manifest), manifest ? `v${manifest.version} for MC ${manifest.minecraft}` : String(response.status));

  if (manifest) {
    const jar = await fetch(`${ORIGIN}${manifest.file}`, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
    const size = Number(jar.headers.get('content-length') ?? 0);
    check('mod jar downloadable', jar.ok && size > 100_000, `${jar.status}, ${(size / 1024).toFixed(0)} KB`);
  }
} catch (err) {
  check('mod manifest served', false, err.message);
}

// --- the websocket the mod depends on ----------------------------------------------------
// Plan risk #2: if the upgrade does not survive the network path, the whole agent feature is
// dead and nothing else here would reveal it.
await (async () => {
  const wsUrl = `${ORIGIN.replace(/^http/, 'ws')}/agent/ws-echo`;
  try {
    const socket = new WebSocket(wsUrl);
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timed out'), 15000);
      socket.addEventListener('open', () => socket.send('ping'), { once: true });
      socket.addEventListener('message', (event) => {
        clearTimeout(timer);
        resolve(typeof event.data === 'string' ? event.data : '(binary)');
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        resolve('connection error');
      }, { once: true });
    });
    socket.close();
    check('websocket upgrade works', /ping/i.test(result), `${wsUrl} → ${result}`);
  } catch (err) {
    check('websocket upgrade works', false, err.message);
  }
})();

// --- money cannot be spent by a stranger --------------------------------------------------
// The deployment ships without ANTHROPIC_API_KEY on purpose while the app is unauthenticated.
// This asserts that choice actually took effect rather than trusting that it did.
try {
  const { response, text } = await get('/api/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ prompt: 'verification probe — must not generate' }),
  });
  const refused = response.status === 503 || response.status === 401 || response.status === 403;
  check(
    'anonymous generation is refused',
    refused,
    `${response.status} ${text.slice(0, 90).replace(/\s+/g, ' ')}`,
  );
  if (response.ok) {
    console.log('\n  !! an anonymous request started a paid generation — remove the API key or require login');
  }
} catch (err) {
  check('anonymous generation is refused', false, err.message);
}

// --- the spend guard is live ---------------------------------------------------------------
try {
  const { response, text } = await get('/api/spend');
  if (response.ok) {
    const body = JSON.parse(text);
    check(
      'spend ledger readable',
      typeof body.spentThisMonthUsd === 'number' && typeof body.monthlyBudgetUsd === 'number',
      `$${body.spentThisMonthUsd} of $${body.monthlyBudgetUsd} used, ${body.callsThisMonth} call(s)`,
    );
  } else {
    note('/api/spend not public', String(response.status));
  }
} catch (err) {
  note('/api/spend unreachable', err.message);
}

console.log(
  failures === 0
    ? `\ndeployment verified${warnings ? ` (${warnings} note${warnings === 1 ? '' : 's'})` : ''}`
    : `\n${failures} check(s) failed`,
);
process.exitCode = failures === 0 ? 0 : 1;
