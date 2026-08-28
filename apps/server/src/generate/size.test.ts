/**
 * Choosing how big a build comes out.
 *
 * The rule these pin down is the whole feature: a size choice decides the size of the
 * *finished* build and nothing else. The model is asked for the structure at whatever size it
 * needs to look right, and the scale that brings it down to the chosen size is attached
 * afterwards — so the detail is still in the program, and the editor's size control can put it
 * back at 100%. Asking the model for a small program instead is what produced flat little
 * boxes with no corner posts and no trim.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildProgram } from '@craftmagic/core';
import { generateBuild } from './pipeline.js';
import { refinePrompt, sizeBrief } from './prompt.js';
import { SpendLedger } from './spend.js';
import type { Provider, ProviderReply, SessionOptions } from './providers.js';

const temps: string[] = [];

afterEach(() => {
	while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

function ledger(): SpendLedger {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-size-'));
	temps.push(dir);
	return new SpendLedger(path.join(dir, 'ledger.json'), 100);
}

/** A tower 60 blocks tall: bigger than every size choice but the largest. */
const tall: BuildProgram = {
	version: 1,
	meta: { name: 'Tall tower' },
	size: { x: 20, y: 60, z: 20 },
	palette: { wall_primary: 'minecraft:stone_bricks' },
	components: [
		{
			type: 'box',
			pos: ['min', 'min', 'min'],
			size: ['max', 'max', 'max'],
			fill: { type: 'solid', role: 'wall_primary' },
		},
	],
};

/** Records what the model was asked, and answers with a program of our choosing. */
function fakeProvider(program: BuildProgram): { provider: Provider; asked: string[] } {
	const asked: string[] = [];
	const reply = (): Promise<ProviderReply> =>
		Promise.resolve({
			input: program,
			usage: { input_tokens: 100, output_tokens: 100 },
		});

	return {
		asked,
		provider: {
			id: 'anthropic',
			session: (_options: SessionOptions) => ({
				emit: (userContent: string) => {
					asked.push(userContent);
					return reply();
				},
				repair: () => reply(),
			}),
		},
	};
}

describe('sizeBrief', () => {
	it('says nothing at all when the size is left to the design', () => {
		expect(sizeBrief('natural')).toBeNull();
		expect(sizeBrief(undefined)).toBeNull();
	});

	it('asks for a target, and asks for the detail not to be traded away for it', () => {
		const brief = sizeBrief('small')!;
		expect(brief).toContain('about 20 blocks');
		expect(brief).toContain('Do not simplify the design');
		// The escape hatch is explicit: a bigger program is fine and will be scaled.
		expect(brief).toContain('scaled down');
	});
});

describe('generateBuild — the size choice', () => {
	it('brings a big design down to the size that was asked for', async () => {
		const { provider, asked } = fakeProvider(tall);
		const result = await generateBuild({ provider, ledger: ledger() }, {
			prompt: 'a watchtower',
			size: 'medium',
		});

		// 60 blocks against a 32-block target.
		expect(result.program.scale).toEqual({ x: 50, y: 50, z: 50 });
		expect(result.expansion.grid.size).toEqual({ x: 10, y: 30, z: 10 });
		// And the model was told what it was aiming at.
		expect(asked[0]).toContain('about 32 blocks');
	});

	it('leaves the program alone when the size is natural', async () => {
		const { provider, asked } = fakeProvider(tall);
		const result = await generateBuild({ provider, ledger: ledger() }, {
			prompt: 'a watchtower',
			size: 'natural',
		});

		expect(result.program.scale).toBeUndefined();
		expect(result.expansion.grid.size).toEqual({ x: 20, y: 60, z: 20 });
		expect(asked[0]).toBe('a watchtower');
	});

	it('leaves a design that already fits alone', async () => {
		const { provider } = fakeProvider(tall);
		const result = await generateBuild({ provider, ledger: ledger() }, {
			prompt: 'a watchtower',
			size: 'huge',
		});

		expect(result.program.scale).toBeUndefined();
	});

	it('reports the block count of the build the user will actually see', async () => {
		const { provider } = fakeProvider(tall);
		const natural = await generateBuild({ provider, ledger: ledger() }, { prompt: 'a tower' });
		const small = await generateBuild({ provider, ledger: ledger() }, {
			prompt: 'a tower',
			size: 'small',
		});

		expect(small.expansion.blockCount).toBeLessThan(natural.expansion.blockCount);
	});

	it('keeps the size a refined build was already at', async () => {
		// "Add a balcony" must not also resize the build, and the model never sees the scale —
		// so the pipeline is the only thing that can carry it across.
		const refineOf: BuildProgram = { ...tall, scale: { x: 45, y: 45, z: 45 } };
		const { provider } = fakeProvider(tall);
		const result = await generateBuild({ provider, ledger: ledger() }, {
			prompt: 'add a balcony',
			refineOf,
			size: 'tiny',
		});

		expect(result.program.scale).toEqual({ x: 45, y: 45, z: 45 });
	});
});

describe('refinePrompt', () => {
	it('does not show the model the size control', () => {
		const prompt = refinePrompt({ ...tall, scale: { x: 45, y: 45, z: 45 } }, 'make it taller');
		expect(prompt).not.toContain('scale');
		expect(prompt).toContain('Tall tower');
	});
});
