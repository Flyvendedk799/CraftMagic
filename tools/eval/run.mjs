/**
 * Generation eval harness.
 *
 * The rule this exists to enforce: **nothing about the generation prompt changes without
 * numbers.** A prompt tweak that reads better can quietly cost interiors, or role coverage,
 * or double the palette — and nobody notices until users do. This runs a golden prompt set
 * through the real pipeline and scores every result with deterministic metrics from core.
 *
 * Two modes:
 *
 *   node tools/eval/run.mjs --offline [files...]
 *       No network, no spend. Scores the built-in sample programs (and any *.program.json
 *       files given) so the metrics themselves can be developed and sanity-checked anywhere.
 *
 *   node tools/eval/run.mjs --live [--model claude-sonnet-5] [--only id,id] [--json out.json]
 *       Runs every golden prompt through a real generation. THIS SPENDS REAL MONEY — a full
 *       12-prompt sweep at sonnet prices is roughly a dollar — which is why it never runs in
 *       CI or tests, needs ANTHROPIC_API_KEY (apps/server/.env), and shares the server's
 *       spend ledger so a sweep cannot blow through the monthly budget.
 *
 * Scoring is comparative, not absolute: the score of one run means little, the delta between
 * two runs of the same set on two prompts is the entire point. Keep the JSON outputs.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { expand, samples, voxelIndex } from '@craftmagic/core';

const REPO_ROOT = path.join(import.meta.dirname, '../..');

// --- Metrics --------------------------------------------------------------------------------

/** The palette roles the prompt recommends; coverage of these is a proxy for material richness. */
const RECOMMENDED_ROLES = [
	'wall_primary', 'wall_secondary', 'wall_accent', 'foundation', 'floor', 'frame',
	'roof_primary', 'roof_trim', 'window', 'door', 'trim', 'path', 'foliage', 'light', 'decoration',
];

/**
 * Enclosed interior air: the fraction of the build's bounding box that is air you cannot
 * reach from outside. Zero for a solid statue or an open pavilion, meaningfully positive for
 * anything with rooms — which makes it the one number that catches the classic failure of
 * buildings generated as solid masses (or as shells with no floors, which score near 1 and
 * look just as wrong from the other side).
 */
function interiorAirRatio(grid) {
	const { size, voxels } = grid;

	// Bounding box of the non-air content.
	let min = null;
	let max = null;
	for (let y = 0; y < size.y; y++) {
		for (let z = 0; z < size.z; z++) {
			for (let x = 0; x < size.x; x++) {
				if (voxels[voxelIndex(size, x, y, z)] === 0) continue;
				if (!min) {
					min = [x, y, z];
					max = [x, y, z];
				} else {
					min = [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)];
					max = [Math.max(max[0], x), Math.max(max[1], y), Math.max(max[2], z)];
				}
			}
		}
	}
	if (!min) return { ratio: 0, enclosed: 0 };

	// Flood the reachable air from the box's own boundary, 6-connected, inside the box only.
	const dims = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
	const volume = dims[0] * dims[1] * dims[2];
	const seen = new Uint8Array(volume);
	const local = (x, y, z) => x - min[0] + (z - min[2]) * dims[0] + (y - min[1]) * dims[0] * dims[2];
	const isAir = (x, y, z) => voxels[voxelIndex(size, x, y, z)] === 0;

	const queue = [];
	for (let y = min[1]; y <= max[1]; y++) {
		for (let z = min[2]; z <= max[2]; z++) {
			for (let x = min[0]; x <= max[0]; x++) {
				const onBoundary =
					x === min[0] || x === max[0] || y === min[1] || y === max[1] || z === min[2] || z === max[2];
				if (onBoundary && isAir(x, y, z) && !seen[local(x, y, z)]) {
					seen[local(x, y, z)] = 1;
					queue.push([x, y, z]);
				}
			}
		}
	}

	let head = 0;
	let reachable = queue.length;
	const STEPS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
	while (head < queue.length) {
		const [x, y, z] = queue[head++];
		for (const [dx, dy, dz] of STEPS) {
			const nx = x + dx, ny = y + dy, nz = z + dz;
			if (nx < min[0] || nx > max[0] || ny < min[1] || ny > max[1] || nz < min[2] || nz > max[2]) continue;
			if (!isAir(nx, ny, nz) || seen[local(nx, ny, nz)]) continue;
			seen[local(nx, ny, nz)] = 1;
			reachable += 1;
			queue.push([nx, ny, nz]);
		}
	}

	let air = 0;
	for (let y = min[1]; y <= max[1]; y++) {
		for (let z = min[2]; z <= max[2]; z++) {
			for (let x = min[0]; x <= max[0]; x++) {
				if (isAir(x, y, z)) air += 1;
			}
		}
	}

	const enclosed = air - reachable;
	return { ratio: volume === 0 ? 0 : enclosed / volume, enclosed };
}

/**
 * Sheltered air: cells with something solid below them and something solid above them in the
 * same column. Looser than enclosure — an open doorway or gable end does not zero it — which
 * makes it the right test for "is there usable inside space at all". A solid statue and a
 * flat wall both score ~0; a building with rooms scores in the hundreds.
 */
function shelteredAir(grid) {
	const { size, voxels } = grid;
	let sheltered = 0;
	for (let z = 0; z < size.z; z++) {
		for (let x = 0; x < size.x; x++) {
			let solidBelow = false;
			// Walk up the column, counting air runs that end under something solid.
			let pendingAir = 0;
			for (let y = 0; y < size.y; y++) {
				const solid = voxels[voxelIndex(size, x, y, z)] !== 0;
				if (solid) {
					if (solidBelow) sheltered += pendingAir;
					pendingAir = 0;
					solidBelow = true;
				} else if (solidBelow) {
					pendingAir += 1;
				}
			}
		}
	}
	return sheltered;
}

/** Deterministic quality metrics for one program. Pure — same program, same numbers, forever. */
export function scoreProgram(program, expectation = {}) {
	const expansion = expand(program);
	const { grid, blockCount, errors, warnings } = expansion;
	const interior = interiorAirRatio(grid);
	const sheltered = shelteredAir(grid);

	const roles = Object.keys(program.palette ?? {});
	const recommended = roles.filter((role) => RECOMMENDED_ROLES.includes(role));
	const metrics = {
		blockCount,
		components: (program.components ?? []).length,
		errors: errors.length,
		warnings: warnings.length,
		paletteRoles: roles.length,
		recommendedRoles: recommended.length,
		gridPalette: grid.palette.length,
		params: Object.keys(program.params ?? {}).length,
		interiorRatio: Number(interior.ratio.toFixed(4)),
		interiorBlocks: interior.enclosed,
		shelteredAir: sheltered,
	};

	// The composite. Weights are editorial, and that is fine — the score only ever competes
	// with itself across runs. Failed expectations subtract visibly rather than failing hard.
	let score = 100;
	const notes = [];
	const dock = (points, why) => {
		score -= points;
		notes.push(`-${points} ${why}`);
	};

	if (blockCount === 0) dock(60, 'empty build');
	if (metrics.errors > 0) dock(Math.min(30, metrics.errors * 10), `${metrics.errors} expansion errors`);
	if (metrics.warnings > 3) dock(5, `${metrics.warnings} warnings`);
	if (metrics.recommendedRoles < 4 && blockCount > 0) dock(10, 'thin palette (<4 recommended roles)');
	if (metrics.gridPalette < 4 && blockCount > 200) dock(10, 'few distinct blocks for the size');
	if (metrics.params === 0) dock(5, 'no params (nothing for the sliders)');

	if (expectation.minBlocks && blockCount < expectation.minBlocks) {
		dock(10, `expected >=${expectation.minBlocks} blocks, got ${blockCount}`);
	}
	for (const role of expectation.roles ?? []) {
		if (!roles.includes(role)) dock(5, `expected palette role "${role}"`);
	}
	if (expectation.interior && sheltered < 40) {
		dock(15, `expected an interior, found ${sheltered} sheltered cells (solid mass?)`);
	}
	if (expectation.params && metrics.params < expectation.params) {
		dock(5, `expected >=${expectation.params} params`);
	}

	return { score: Math.max(0, score), metrics, notes };
}

// --- Reporting ------------------------------------------------------------------------------

function printRow(id, result, extra = '') {
	const { score, metrics, notes } = result;
	console.log(
		`${id.padEnd(14)} ${String(score).padStart(3)}  ` +
			`${String(metrics.blockCount).padStart(7)} blk  ${String(metrics.components).padStart(3)} cmp  ` +
			`${String(metrics.errors).padStart(2)} err  ${String(metrics.recommendedRoles).padStart(2)} roles  ` +
			`int ${metrics.interiorRatio.toFixed(2)}  shl ${String(metrics.shelteredAir).padStart(5)}${extra}`,
	);
	for (const note of notes) console.log(`               ${note}`);
}

function summarize(rows) {
	if (rows.length === 0) return;
	const mean = rows.reduce((sum, row) => sum + row.score, 0) / rows.length;
	console.log(`\n${rows.length} programs scored · mean score ${mean.toFixed(1)}`);
}

// --- Modes ----------------------------------------------------------------------------------

function runOffline(files) {
	console.log('offline scoring — no model calls, no spend\n');
	const rows = [];

	for (const [name, program] of Object.entries(samples)) {
		const result = scoreProgram(program);
		rows.push(result);
		printRow(`sample:${name}`, result);
	}

	for (const file of files) {
		const program = JSON.parse(fs.readFileSync(file, 'utf8'));
		const result = scoreProgram(program);
		rows.push(result);
		printRow(path.basename(file, '.program.json'), result);
	}

	summarize(rows);
}

async function runLive(args) {
	// Imported lazily: the offline mode must work on a checkout with no server build and no
	// credentials at all.
	const { generateBuild } = await import('../../apps/server/dist/generate/pipeline.js');
	const { anthropicProvider } = await import('../../apps/server/dist/generate/providers.js');
	const { SpendLedger } = await import('../../apps/server/dist/generate/spend.js');

	process.loadEnvFile(path.join(REPO_ROOT, 'apps/server/.env'));
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		console.error('ANTHROPIC_API_KEY is not set (apps/server/.env). Live eval needs a real key.');
		process.exitCode = 1;
		return;
	}

	const model = valueOf(args, '--model') ?? 'claude-sonnet-5';
	const only = (valueOf(args, '--only') ?? '').split(',').filter(Boolean);
	const outFile = valueOf(args, '--json');

	const golden = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'prompts.json'), 'utf8'));
	const chosen = golden.prompts.filter((entry) => only.length === 0 || only.includes(entry.id));

	const ledger = new SpendLedger(
		path.join(REPO_ROOT, process.env.ANTHROPIC_SPEND_LEDGER ?? '.spend/ledger.json'),
		Number.parseFloat(process.env.ANTHROPIC_MONTHLY_BUDGET_USD ?? '4'),
	);
	const provider = anthropicProvider(apiKey);

	console.log(`live eval · ${chosen.length} prompts · model ${model}\n`);
	const rows = [];
	const report = [];

	for (const entry of chosen) {
		process.stdout.write(`${entry.id.padEnd(14)} generating…\r`);
		try {
			const generated = await generateBuild(
				{ provider, ledger },
				{ prompt: entry.prompt, model, size: entry.size, effort: 'medium' },
			);
			const result = scoreProgram(generated.program, entry.expect ?? {});
			rows.push(result);
			printRow(entry.id, result, `  $${generated.usage.costUsd.toFixed(3)}`);
			report.push({ id: entry.id, ...result, costUsd: generated.usage.costUsd, status: generated.status });
		} catch (err) {
			console.log(`${entry.id.padEnd(14)} FAILED: ${err?.message ?? err}`);
			rows.push({ score: 0, metrics: {}, notes: [] });
			report.push({ id: entry.id, score: 0, error: String(err?.message ?? err) });
		}
	}

	summarize(rows);
	if (outFile) {
		fs.writeFileSync(outFile, JSON.stringify({ model, at: new Date().toISOString(), results: report }, null, 2));
		console.log(`wrote ${outFile}`);
	}
}

function valueOf(args, flag) {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
if (args.includes('--offline')) {
	runOffline(args.filter((arg) => arg.endsWith('.json') && !arg.includes('prompts')));
} else if (args.includes('--live')) {
	await runLive(args);
} else {
	console.log('usage:');
	console.log('  node tools/eval/run.mjs --offline [program.json...]   score samples, no spend');
	console.log('  node tools/eval/run.mjs --live [--model m] [--only id,id] [--json out.json]');
	console.log('                                                        run golden prompts — SPENDS MONEY');
}
