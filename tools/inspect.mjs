/**
 * Print ASCII cross-sections of an expanded sample.
 *
 * Unit tests prove individual blocks land where asserted; this is for the other half —
 * confirming the thing actually reads as a building.
 *
 *   node tools/inspect.mjs cottage          # every other layer, top-down
 *   node tools/inspect.mjs cottage --slice z 8   # one vertical slice
 */

import { expand } from '../packages/core/dist/expand/expander.js';
import { samples } from '../packages/core/dist/samples/index.js';
import { voxelIndex } from '../packages/core/dist/ir/types.js';
import fs from 'node:fs';

const name = process.argv[2] ?? 'cottage';
// A path loads a generated program; a bare name loads a built-in sample.
const program = name.endsWith('.json') ? JSON.parse(fs.readFileSync(name,'utf8')) : samples[name];
if (!program) {
	console.error(`unknown sample "${name}". Available: ${Object.keys(samples).join(', ')}`);
	process.exit(1);
}

const result = expand(program);
const { grid } = result;

console.log(`${program.meta.name}: ${grid.size.x}x${grid.size.y}x${grid.size.z}, ${result.blockCount} blocks`);
console.log(`palette (${grid.palette.length}):`);
grid.palette.forEach((p, i) => console.log(`  ${String(i).padStart(2)} ${p}`));
if (result.errors.length) console.log('errors:', result.errors);
if (result.warnings.length) console.log('warnings:', result.warnings);

/** One glyph per palette index, chosen so the shape is legible at a glance. */
function glyph(index) {
	if (index === 0) return '.';
	const ref = grid.palette[index];
	if (ref.includes('stairs')) {
		const facing = /facing=(\w+)/.exec(ref)?.[1];
		return { north: '^', south: 'v', east: '>', west: '<' }[facing] ?? 's';
	}
	if (ref.includes('glass')) return 'o';
	if (ref.includes('door')) return 'D';
	if (ref.includes('log')) return 'I';
	if (ref.includes('planks')) return '#';
	if (ref.includes('lantern')) return '*';
	return '@';
}

const at = (x, y, z) => grid.voxels[voxelIndex(grid.size, x, y, z)];

const sliceFlag = process.argv.indexOf('--slice');
if (sliceFlag !== -1) {
	const axis = process.argv[sliceFlag + 1];
	const value = Number.parseInt(process.argv[sliceFlag + 2], 10);
	console.log(`\n--- slice ${axis}=${value} (rows are y, descending) ---`);
	for (let y = grid.size.y - 1; y >= 0; y--) {
		let row = '';
		if (axis === 'z') for (let x = 0; x < grid.size.x; x++) row += glyph(at(x, y, value));
		else for (let z = 0; z < grid.size.z; z++) row += glyph(at(value, y, z));
		console.log(`y=${String(y).padStart(2)} ${row}`);
	}
} else {
	const step = Number.parseInt(process.argv[3] ?? '2', 10);
	for (let y = 0; y < grid.size.y; y += step) {
		console.log(`\n--- y=${y} ---`);
		for (let z = 0; z < grid.size.z; z++) {
			let row = '';
			for (let x = 0; x < grid.size.x; x++) row += glyph(at(x, y, z));
			console.log(row);
		}
	}
}
