/** Ad-hoc RCON probe: print a vertical slice of the world so a failed assertion can be seen. */

import net from 'node:net';

const HOST = '127.0.0.1';
const PORT = 25575;
const PASSWORD = 'imaginecraft';

class Rcon {
	#socket; #id = 0; #pending = new Map(); #buffer = Buffer.alloc(0);
	async connect() {
		this.#socket = net.createConnection({ host: HOST, port: PORT });
		this.#socket.on('data', (c) => this.#onData(c));
		await new Promise((res, rej) => { this.#socket.once('connect', res); this.#socket.once('error', rej); });
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
			const t = setTimeout(() => reject(new Error('timeout')), 15000);
			this.#pending.set(id, { id, resolve: (v) => { clearTimeout(t); resolve(v); } });
		});
	}
	cmd(text) { return this.#send(2, text); }
	close() { this.#socket?.end(); }
}

const AT = { x: 40, y: -59, z: 40 };
const rcon = new Rcon();
await rcon.connect();

// Without this every query returns "Test failed" — not because the block is solid, but
// because an unloaded chunk cannot be inspected at all. That reads as "everything is a
// block", which is the most misleading possible answer.
await rcon.cmd(`forceload add ${AT.x} ${AT.z} ${AT.x + 32} ${AT.z + 32}`);

const isAir = async (x, y, z) => {
	const reply = await rcon.cmd(`execute if block ${x} ${y} ${z} minecraft:air`);
	if (!/Test (passed|failed)/i.test(reply)) throw new Error(`unexpected: ${reply.slice(0, 80)}`);
	return /Test passed/i.test(reply);
};

console.log(`column at build x=10, z=6 (world ${AT.x + 10}, *, ${AT.z + 6}):`);
for (let dy = 0; dy <= 18; dy++) {
	const air = await isAir(AT.x + 10, AT.y + dy, AT.z + 6);
	console.log(`  build y=${String(dy).padStart(2)}  world y=${AT.y + dy}  ${air ? '.' : '#'}`);
}

console.log('\ntop-down at build y=12 (the ridge layer), z=0..12:');
for (let dz = 0; dz <= 12; dz++) {
	let row = '';
	for (let dx = 0; dx <= 20; dx++) row += (await isAir(AT.x + dx, AT.y + 12, AT.z + dz)) ? '.' : '#';
	console.log(`  z=${String(dz).padStart(2)} ${row}`);
}

rcon.close();
