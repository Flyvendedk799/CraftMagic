/**
 * Building from a picture.
 *
 * The rule these pin down: a picture is a brief, not a texture. Asked to reproduce a
 * photograph a model reaches for a flat wall of coloured blocks — which is both a poor
 * structure and something the app already does exactly, for free, in the browser. What the
 * model is for is the thing a builder would make *of* the subject.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildProgram } from '@craftmagic/core';
import { generateBuild } from './pipeline.js';
import { pictureBrief } from './prompt.js';
import { imageTokens, readImage, MAX_IMAGE_BASE64 } from './image.js';
import { SpendLedger } from './spend.js';
import type { Provider, ProviderImage, ProviderReply, SessionOptions } from './providers.js';

const temps: string[] = [];

afterEach(() => {
	while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

function ledger(): SpendLedger {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-picture-'));
	temps.push(dir);
	return new SpendLedger(path.join(dir, 'ledger.json'), 100);
}

const hut: BuildProgram = {
	version: 1,
	meta: { name: 'Hut' },
	size: { x: 8, y: 8, z: 8 },
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

/** Records exactly what reached the provider, picture included. */
function fakeProvider(): { provider: Provider; seen: { text: string; image?: ProviderImage }[] } {
	const seen: { text: string; image?: ProviderImage }[] = [];
	const reply = (): Promise<ProviderReply> =>
		Promise.resolve({ input: hut, usage: { input_tokens: 100, output_tokens: 100 } });

	return {
		seen,
		provider: {
			id: 'anthropic',
			session: (_options: SessionOptions) => ({
				emit: (text: string, image?: ProviderImage) => {
					seen.push({ text, ...(image ? { image } : {}) });
					return reply();
				},
				repair: () => reply(),
			}),
		},
	};
}

const picture: ProviderImage = { data: 'aGVsbG8=', mediaType: 'image/png' };

describe('pictureBrief', () => {
	it('asks for the subject to be built, not for the picture to be copied', () => {
		const brief = pictureBrief();
		expect(brief).toContain('Build the **subject**');
		expect(brief).toContain('Never a flat wall of coloured blocks');
	});

	it('explains what the white area is, so the mask is not built as a wall', () => {
		expect(pictureBrief()).toContain('masked out deliberately');
	});
});

describe('generateBuild — from a picture', () => {
	it('hands the picture to the model along with the words', async () => {
		const { provider, seen } = fakeProvider();
		await generateBuild({ provider, ledger: ledger() }, {
			prompt: 'build it as a stone statue',
			image: picture,
		});

		expect(seen[0]!.image).toEqual(picture);
		expect(seen[0]!.text).toContain('build it as a stone statue');
		expect(seen[0]!.text).toContain('Build the **subject**');
	});

	it('keeps the size choice working alongside a picture', async () => {
		const { provider, seen } = fakeProvider();
		const result = await generateBuild({ provider, ledger: ledger() }, {
			prompt: 'this ship',
			image: picture,
			size: 'tiny',
		});

		expect(seen[0]!.text).toContain('20–150 blocks');
		// The hut is a solid 8-cube — 512 blocks, which is above what "tiny" asks for, so the
		// picture build gets fitted exactly like a written one.
		expect(result.program.scale).toBeDefined();
		expect(result.expansion.blockCount).toBeLessThanOrEqual(150);
	});

	it('says nothing about pictures when there is no picture', async () => {
		const { provider, seen } = fakeProvider();
		await generateBuild({ provider, ledger: ledger() }, { prompt: 'a windmill' });

		expect(seen[0]!.image).toBeUndefined();
		expect(seen[0]!.text).not.toContain('Build the **subject**');
	});

	it('carries a reference picture into a refine, brief and all', async () => {
		// "Make it look like this" with a picture is exactly what a refine is for. The picture
		// used to be attached with no brief — shown to the model with no word about what it
		// was — which was the worst of both: paying for the image tokens and leaving the model
		// to guess. Now the brief rides whenever the picture does.
		const { provider, seen } = fakeProvider();
		await generateBuild({ provider, ledger: ledger() }, {
			prompt: 'make the roof steeper',
			refineOf: hut,
			image: picture,
		});

		expect(seen[0]!.image).toEqual(picture);
		expect(seen[0]!.text).toContain('Build the **subject**');
		expect(seen[0]!.text).toContain('make the roof steeper');
		// Still a refine: the program being changed is in the same turn.
		expect(seen[0]!.text).toContain('existing build program');
	});
});

describe('readImage', () => {
	it('accepts a well-formed picture', () => {
		expect(readImage({ image: picture })).toEqual(picture);
	});

	it('reads no picture as no picture', () => {
		expect(readImage({})).toBeNull();
		expect(readImage({ image: null })).toBeNull();
		expect(readImage(null)).toBeNull();
	});

	it('refuses a malformed one rather than silently dropping it', () => {
		// Dropping it would build something unrelated to what the user outlined, and charge
		// them a generation for it.
		expect(readImage({ image: 'a-string' })).toBe('invalid');
		expect(readImage({ image: { data: '', mediaType: 'image/png' } })).toBe('invalid');
		expect(readImage({ image: { data: 'aGk=', mediaType: 'image/tiff' } })).toBe('invalid');
		expect(readImage({ image: { data: 'aGk=' } })).toBe('invalid');
		expect(readImage({ image: { mediaType: 'image/png' } })).toBe('invalid');
	});

	it('refuses a data URL, which is the mistake a hand-rolled client makes', () => {
		expect(readImage({ image: { data: 'data:image/png;base64,aGk=', mediaType: 'image/png' } })).toBe(
			'invalid',
		);
	});

	it('refuses one too big to send, before it reaches a provider', () => {
		const huge = 'a'.repeat(MAX_IMAGE_BASE64 + 1);
		expect(readImage({ image: { data: huge, mediaType: 'image/png' } })).toBe('invalid');
	});
});

describe('imageTokens', () => {
	it('is zero without a picture', () => {
		expect(imageTokens(null)).toBe(0);
	});

	it('grows with the picture, and errs high', () => {
		// A 768x768 PNG is around 400KB of base64; the real charge is about 780 tokens.
		const tokens = imageTokens({ data: 'a'.repeat(400_000), mediaType: 'image/png' });
		expect(tokens).toBeGreaterThan(300);
		expect(tokens).toBeLessThan(1000);
	});
});
