/**
 * Generate a build from the command line.
 *
 * Defaults to a DRY RUN: it counts tokens (a free endpoint) and prints what the call would
 * cost, without calling the model. Pass --go to actually generate.
 *
 *   node tools/generate.mjs "a small stone windmill"
 *   node tools/generate.mjs "a small stone windmill" --go
 *   node tools/generate.mjs --spend          # just show the ledger
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Anthropic from '@anthropic-ai/sdk';
import { writeSchematic, schematicFilename, buildGuide } from '@craftmagic/core';
import { systemPrompt } from '../apps/server/dist/generate/prompt.js';
import { generateBuild, TOOL_NAME } from '../apps/server/dist/generate/pipeline.js';
import { SpendLedger } from '../apps/server/dist/generate/spend.js';
import { PRICING, costOf, formatUsd, worstCaseCost } from '../apps/server/dist/generate/pricing.js';

process.loadEnvFile(path.join(import.meta.dirname, '../apps/server/.env'));

const MODEL = process.env.CRAFTMAGIC_MODEL ?? 'claude-sonnet-5';
const MAX_TOKENS = 16_000;
const REPO_ROOT = path.join(import.meta.dirname, '..');

const ledger = new SpendLedger(
	path.join(REPO_ROOT, process.env.ANTHROPIC_SPEND_LEDGER ?? '.spend/ledger.json'),
	Number.parseFloat(process.env.ANTHROPIC_MONTHLY_BUDGET_USD ?? '4'),
);

function showSpend() {
	const s = ledger.summary();
	console.log(
		`\nspend: ${formatUsd(s.spentThisMonthUsd)} of ${formatUsd(s.monthlyBudgetUsd)} this month ` +
			`(${s.callsThisMonth} calls) · ${formatUsd(s.remainingUsd)} left`,
	);
}

async function main() {
	const args = process.argv.slice(2);

	if (args.includes('--spend')) {
		showSpend();
		for (const e of ledger.summary().entries.slice(-15)) {
			console.log(
				`  ${e.at.slice(0, 19)}  ${e.purpose.padEnd(9)} ${String(e.outputTokens).padStart(6)} out  ` +
					`${String(e.cacheReadTokens).padStart(6)} cached  ${formatUsd(e.costUsd)}`,
			);
		}
		return;
	}

	const go = args.includes('--go');
	const prompt = args.filter((a) => !a.startsWith('--')).join(' ');
	if (!prompt) {
		console.error('usage: node tools/generate.mjs "<description>" [--go]');
		process.exitCode = 1;
		return;
	}

	const client = new Anthropic();
	const system = systemPrompt();
	const inputSchema = JSON.parse(
		fs.readFileSync(path.join(REPO_ROOT, 'packages/core/dist/ir/schema.json'), 'utf8'),
	);

	// count_tokens is free, so the dry run costs nothing and still reports real numbers.
	const counted = await client.messages.countTokens({
		model: MODEL,
		system: [{ type: 'text', text: system }],
		tools: [
			{
				name: TOOL_NAME,
				description: 'Emit the complete build program for the requested structure.',
				input_schema: inputSchema,
			},
		],
		messages: [{ role: 'user', content: prompt }],
	});

	const rates = PRICING[MODEL];
	console.log(`model         ${MODEL}  ($${rates.input}/$${rates.output} per Mtok)`);
	console.log(`prompt        "${prompt}"`);
	console.log(`input tokens  ${counted.input_tokens.toLocaleString()} (system + schema + prompt)`);
	console.log(
		`cacheable     ${counted.input_tokens >= 1024 ? 'yes — repeat calls bill this prefix at ~10%' : 'NO — under the 1024-token minimum'}`,
	);
	console.log(
		`first call    ~${formatUsd(costOf(MODEL, { input_tokens: counted.input_tokens, output_tokens: 5000 }).totalUsd)} at 5k output`,
	);
	console.log(
		`cached call   ~${formatUsd(costOf(MODEL, { input_tokens: 120, output_tokens: 5000, cache_read_input_tokens: counted.input_tokens }).totalUsd)} at 5k output`,
	);
	console.log(
		`worst case    ${formatUsd(worstCaseCost(MODEL, counted.input_tokens, MAX_TOKENS))} (all ${MAX_TOKENS.toLocaleString()} output tokens)`,
	);
	showSpend();

	if (!go) {
		console.log('\nDRY RUN — no model call made. Re-run with --go to generate.');
		return;
	}

	console.log('\ngenerating…');
	const started = Date.now();
	const result = await generateBuild(
		{ client, ledger },
		{
			prompt,
			model: MODEL,
			effort: 'medium',
			maxTokens: MAX_TOKENS,
			onProgress: (event) => {
				if (event.stage === 'emitting') process.stdout.write(`\r  components: ${event.components}   `);
				else process.stdout.write(`\r  ${event.stage}…                    `);
			},
			// Write every paid response to disk the moment it arrives. If expansion fails,
			// this file is the only record of what the model actually produced, and asking
			// again costs real money.
			onProgram: (program, attempt) => {
				fs.mkdirSync(path.join(REPO_ROOT, 'out'), { recursive: true });
				const file = path.join(REPO_ROOT, `out/last-${attempt}.program.json`);
				fs.writeFileSync(file, JSON.stringify(program, null, 2));
				process.stdout.write(`\r  saved ${path.relative(REPO_ROOT, file)}          \n`);
			},
		},
	);

	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	const { grid, blockCount, warnings, errors } = result.expansion;
	const guide = buildGuide(grid, result.program.meta.name);

	console.log(`\r  done in ${seconds}s                         `);
	console.log(`\nname          ${result.program.meta.name}`);
	console.log(`size          ${grid.size.x}x${grid.size.y}x${grid.size.z}`);
	console.log(
		`blocks        ${blockCount.toLocaleString()}  (${grid.palette.length} palette, ${guide.steps.length} guide steps)`,
	);
	console.log(`components    ${result.program.components.length}`);
	console.log(`params        ${Object.keys(result.program.params ?? {}).join(', ') || '(none)'}`);
	console.log(`status        ${result.status}${result.repaired ? ' (after one repair round)' : ''}`);
	for (const e of result.issues.slice(0, 6)) console.log(`  issue   ${e.path}: ${e.message}`);
	for (const w of warnings.slice(0, 5)) console.log(`  warn    ${w.path}: ${w.message}`);

	console.log(
		`\ntokens        ${result.usage.inputTokens} in / ${result.usage.outputTokens} out / ${result.usage.cacheReadTokens} cached`,
	);
	console.log(`cost          ${formatUsd(result.usage.costUsd)}`);
	showSpend();

	fs.mkdirSync(path.join(REPO_ROOT, 'out'), { recursive: true });
	const base = schematicFilename(result.program.meta.name).replace(/\.schem$/, '');
	fs.writeFileSync(
		path.join(REPO_ROOT, `out/${base}.schem`),
		writeSchematic(grid, { name: result.program.meta.name }),
	);
	fs.writeFileSync(
		path.join(REPO_ROOT, `out/${base}.program.json`),
		JSON.stringify(result.program, null, 2),
	);
	console.log(`\nwrote out/${base}.schem and out/${base}.program.json`);
}

try {
	await main();
} catch (err) {
	console.error(`\n${err?.name ?? 'Error'}: ${err?.message ?? err}`);
	process.exitCode = 1;
}
