/**
 * Run a command on the local Minecraft dev server over RCON.
 *
 * Exists because the verification drivers each pair the world to their own throwaway account,
 * and a mod left holding a socket from a previous run makes the next run fail in a way that
 * looks like a protocol bug. `node tools/rcon.mjs "imaginecraft unpair"` is the reset.
 *
 *   node tools/rcon.mjs "<command>" [more commands...]
 */

import net from 'node:net';

const HOST = process.env.IC_RCON_HOST ?? '127.0.0.1';
const PORT = Number(process.env.IC_RCON_PORT ?? 25575);
const PASSWORD = process.env.IC_RCON_PASSWORD ?? 'imaginecraft';

const commands = process.argv.slice(2);
if (commands.length === 0) {
  console.error('usage: node tools/rcon.mjs "<command>" [more...]');
  process.exit(1);
}

class Rcon {
  #socket; #id = 0; #pending = new Map(); #buffer = Buffer.alloc(0);

  async connect() {
    this.#socket = net.createConnection({ host: HOST, port: PORT });
    this.#socket.on('data', (c) => this.#onData(c));
    await new Promise((resolve, reject) => {
      this.#socket.once('connect', resolve);
      this.#socket.once('error', reject);
    });
    await this.#send(3, PASSWORD);
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const size = this.#buffer.readInt32LE(0);
      if (this.#buffer.length < size + 4) break;
      const id = this.#buffer.readInt32LE(4);
      const body = this.#buffer.subarray(12, size + 2).toString('utf8');
      this.#buffer = this.#buffer.subarray(size + 4);
      const waiter = this.#pending.get(id) ?? this.#pending.get(-1);
      if (waiter) {
        this.#pending.delete(waiter.id);
        waiter.resolve(body);
      }
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
      const timer = setTimeout(() => reject(new Error(`RCON timeout: ${body}`)), 20000);
      this.#pending.set(id, { id, resolve: (v) => { clearTimeout(timer); resolve(v); } });
    });
  }

  cmd(text) { return this.#send(2, text); }
  close() { this.#socket?.end(); }
}

const rcon = new Rcon();
try {
  await rcon.connect();
  for (const command of commands) {
    const reply = await rcon.cmd(command);
    console.log(`> ${command}`);
    if (reply.trim()) console.log(`  ${reply.trim().replace(/\n/g, '\n  ')}`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  rcon.close();
}
