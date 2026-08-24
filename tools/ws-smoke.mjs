/**
 * WebSocket smoke test for the agent endpoint.
 *
 * Run against localhost during development, or against the deployed origin to prove the
 * upgrade survives the reverse proxy / tunnel:
 *   node tools/ws-smoke.mjs wss://craftmagic.example.com
 */

const origin = process.argv[2] ?? 'ws://localhost:3016';
const base = origin.replace(/^http/, 'ws').replace(/\/$/, '');

function withTimeout(label, ms, run) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    run(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function testEcho() {
  return withTimeout('echo', 8000, (done, fail) => {
    const socket = new WebSocket(`${base}/agent/ws-echo`);
    const started = performance.now();
    socket.onopen = () => socket.send('hello-craftmagic');
    socket.onmessage = (event) => {
      const ms = Math.round(performance.now() - started);
      socket.close();
      if (event.data === 'hello-craftmagic') done(`round-trip ${ms}ms`);
      else fail(new Error(`unexpected echo payload: ${event.data}`));
    };
    socket.onerror = () => fail(new Error('connection failed'));
  });
}

async function testHandshake() {
  return withTimeout('handshake', 8000, (done, fail) => {
    const socket = new WebSocket(`${base}/agent/ws`);
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          t: 'hello',
          protocolVersion: 1,
          modVersion: '0.1.0-smoke',
          mcVersion: '26.2',
          envType: 'integrated',
        }),
      );
    socket.onmessage = (event) => {
      socket.close();
      const msg = JSON.parse(event.data);
      if (msg.t === 'hello.ok') done(`agent="${msg.agentName}" maxVolume=${msg.limits.maxVolume}`);
      else fail(new Error(`expected hello.ok, got ${JSON.stringify(msg)}`));
    };
    socket.onerror = () => fail(new Error('connection failed'));
  });
}

async function testProtocolRejection() {
  return withTimeout('protocol-rejection', 8000, (done, fail) => {
    const socket = new WebSocket(`${base}/agent/ws`);
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          t: 'hello',
          protocolVersion: 999,
          modVersion: '0.1.0-smoke',
          mcVersion: '26.2',
          envType: 'integrated',
        }),
      );
    socket.onmessage = (event) => {
      socket.close();
      const msg = JSON.parse(event.data);
      if (msg.t === 'hello.error' && msg.reason === 'unsupported_protocol') done('rejected as expected');
      else fail(new Error(`expected hello.error, got ${JSON.stringify(msg)}`));
    };
    socket.onerror = () => fail(new Error('connection failed'));
  });
}

const tests = [
  ['echo round-trip', testEcho],
  ['agent handshake', testHandshake],
  ['protocol version guard', testProtocolRejection],
];

console.log(`target: ${base}\n`);
let failed = 0;
for (const [name, run] of tests) {
  try {
    const detail = await run();
    console.log(`  PASS  ${name} — ${detail}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}
console.log(failed === 0 ? '\nall websocket checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
