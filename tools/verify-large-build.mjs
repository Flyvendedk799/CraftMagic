/**
 * Prove a build the engine will actually produce can be saved and read back.
 *
 * It could not. `POST /api/builds` sent voxels as a JSON array of integers with no `bodyLimit`
 * override, so Fastify's 1 MiB default capped saving at roughly 80 cubed — while the expander
 * happily produces 256x160x256. A build at the engine's own documented size cap was 20x too
 * large to save, and so was the "Stress test" sample shipped in the editor's own build picker.
 * Both answered 413, and the library, the component shelf and "send to game" all sit behind
 * that one call.
 *
 * So this checks the sizes that matter rather than a convenient small one, and it checks the
 * round trip — a save that succeeds and reads back as different blocks is worse than a 413.
 *
 * Free: no model is called, and it deletes what it created.
 *
 *   node tools/verify-large-build.mjs [origin]
 */

import { encodeVoxels, toBase64, decodeVoxels, fromBase64 } from '@craftmagic/core';

const ORIGIN = (process.argv[2] ?? process.env.CM_ORIGIN ?? 'http://localhost:3016').replace(/\/+$/, '');
const EMAIL = process.env.CM_LARGE_EMAIL ?? 'verify-large@example.com';
const PASSWORD = process.env.CM_LARGE_PASSWORD ?? 'verify-large-password-1';

let failures = 0;
const check = (label, ok, detail = '') => {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
	if (!ok) failures++;
};

let cookie = '';
async function api(path, body, method = 'POST') {
	const res = await fetch(ORIGIN + path, {
		method,
		headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const set = res.headers.get('set-cookie');
	if (set) cookie = set.split(';')[0];
	const text = await res.text();
	let parsed = null;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {
		parsed = { raw: text.slice(0, 120) };
	}
	return { status: res.status, body: parsed };
}

/** A grid with structure in it, so the round trip is checking real data and not a run of zeros. */
function build(size, density) {
	const n = size.x * size.y * size.z;
	const voxels = new Uint16Array(n);
	let seed = 8675309;
	let blocks = 0;
	for (let i = 0; i < n; i++) {
		seed = (seed * 1103515245 + 12345) >>> 0;
		if ((seed >>> 16) / 65536 < density) {
			voxels[i] = 1 + (seed % 8);
			blocks++;
		}
	}
	const palette = ['minecraft:air', ...Array.from({ length: 8 }, (_, k) => `minecraft:stone_${k}`)];
	return { grid: { size, palette, voxels }, blocks };
}

const created = [];

try {
	let auth = await api('/api/auth/register', { email: EMAIL, password: PASSWORD });
	if (auth.status >= 400) auth = await api('/api/auth/login', { email: EMAIL, password: PASSWORD });
	if (auth.status >= 400) {
		console.error(`could not sign in: HTTP ${auth.status}`);
		process.exit(1);
	}

	const cases = [
		['a cottage', { x: 21, y: 19, z: 13 }, 0.35],
		['the "Stress test" sample the editor ships', { x: 150, y: 60, z: 150 }, 0.12],
		['the engine’s own size cap', { x: 256, y: 160, z: 256 }, 0.04],
	];

	for (const [label, size, density] of cases) {
		const { grid, blocks } = build(size, density);
		const encoded = toBase64(encodeVoxels(grid));
		const cells = size.x * size.y * size.z;

		const saved = await api('/api/builds', {
			name: `verify-large ${label}`,
			library: true,
			detached: true,
			grid: { size, palette: grid.palette, data: encoded },
		});

		const wouldHaveBeen = (cells * 2) / 1048576;
		check(
			`saves ${label}`,
			saved.status === 201,
			`${cells.toLocaleString()} cells · ${(encoded.length / 1048576).toFixed(2)}MB sent ` +
				`(a JSON array would have been ~${wouldHaveBeen.toFixed(1)}MB)` +
				(saved.status !== 201 ? ` · HTTP ${saved.status}` : ''),
		);
		if (saved.status !== 201) continue;
		created.push(saved.body.id);

		check(
			`counts its blocks server-side`,
			saved.body.blockCount === blocks,
			`${saved.body.blockCount?.toLocaleString()} vs ${blocks.toLocaleString()}`,
		);

		const read = await api(`/api/builds/${saved.body.id}`, null, 'GET');
		check(`reads ${label} back`, read.status === 200, read.status === 200 ? '' : `HTTP ${read.status}`);
		if (read.status !== 200) continue;

		check('sends the compact form, not an integer array', typeof read.body.grid?.data === 'string');

		const back = decodeVoxels(fromBase64(read.body.grid.data));
		check(
			'the size survives the round trip',
			back.size.x === size.x && back.size.y === size.y && back.size.z === size.z,
			`${back.size.x}x${back.size.y}x${back.size.z}`,
		);

		// Every cell, not a sample: a codec that drops a run would pass a spot check.
		let mismatched = 0;
		for (let i = 0; i < grid.voxels.length; i++) {
			if (back.palette[back.voxels[i]] !== grid.palette[grid.voxels[i]]) mismatched++;
		}
		check('every block survives the round trip', mismatched === 0, `${mismatched.toLocaleString()} wrong`);
	}

	// The old shape has to keep working through a deploy, or a tab open on the previous
	// version starts failing the moment this ships.
	const legacy = build({ x: 20, y: 20, z: 20 }, 0.3);
	const old = await api('/api/builds', {
		name: 'verify-large legacy shape',
		library: true,
		detached: true,
		grid: { size: legacy.grid.size, palette: legacy.grid.palette, voxels: Array.from(legacy.grid.voxels) },
	});
	check('still accepts the old integer-array shape', old.status === 201, `HTTP ${old.status}`);
	if (old.status === 201) created.push(old.body.id);

	// And a blob whose header disagrees with the size beside it is a lie worth refusing.
	const honest = build({ x: 8, y: 8, z: 8 }, 0.5);
	const mismatch = await api('/api/builds', {
		name: 'verify-large mismatch',
		library: true,
		detached: true,
		grid: { size: { x: 9, y: 8, z: 8 }, palette: honest.grid.palette, data: toBase64(encodeVoxels(honest.grid)) },
	});
	check('refuses a blob that disagrees with its stated size', mismatch.status === 400, `HTTP ${mismatch.status}`);
	if (mismatch.status === 201) created.push(mismatch.body.id);
} catch (err) {
	console.error(err.message);
	failures++;
} finally {
	for (const id of created) await api(`/api/builds/${id}`, null, 'DELETE');
	console.log(`\ncleaned up ${created.length} build(s)`);
}

console.log(failures === 0 ? '\nlarge builds verified' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
