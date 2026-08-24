import { describe, expect, it } from 'vitest';
import { unwrapProgram } from './pipeline.js';

/**
 * Shape captured from a real generation: the whole program arrived nested under a `params`
 * key rather than as the tool input itself. It happened on the first attempt of every run,
 * and the repair round existed only to reformat it — so this doubled the cost of every
 * generation until it was handled.
 */
const wrapped = {
	params: {
		version: 1,
		meta: { name: 'Stone Windmill' },
		size: { x: 11, y: 24, z: 11 },
		palette: { wall_primary: 'minecraft:stone_bricks' },
		components: [
			{ type: 'box', pos: [0, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'wall_primary' } },
		],
	},
};

const plain = wrapped.params;

describe('unwrapProgram', () => {
	it('passes a correctly shaped program through untouched', () => {
		expect(unwrapProgram(plain)).toBe(plain);
	});

	it('unwraps a program nested under a wrapper key', () => {
		expect(unwrapProgram(wrapped)).toBe(wrapped.params);
	});

	it('unwraps regardless of what the wrapper key is called', () => {
		const other = { build_program: plain };
		expect(unwrapProgram(other)).toBe(plain);
	});

	it('parses a program handed back as a JSON string', () => {
		// Seen in a real response: {"program": "{…}"} — wrapped *and* serialized.
		const stringified = { program: JSON.stringify(plain) };
		expect(unwrapProgram(stringified)).toMatchObject({ meta: { name: 'Stone Windmill' } });
	});

	it('parses a bare JSON string input', () => {
		expect(unwrapProgram(JSON.stringify(plain))).toMatchObject({ size: { x: 11 } });
	});

	it('ignores a string that is not JSON', () => {
		expect(unwrapProgram('{ not json at all')).toBe('{ not json at all');
	});

	it('leaves genuinely malformed input alone so validation can report it', () => {
		const junk = { nothing: 'useful' };
		expect(unwrapProgram(junk)).toBe(junk);
		expect(unwrapProgram(null)).toBeNull();
		expect(unwrapProgram('a string')).toBe('a string');
	});

	it('does not mistake a program-shaped fragment for the whole program', () => {
		// `components` must be an array — an object with those keys but a non-array
		// components field is not a program.
		const decoy = { size: {}, components: 'not an array' };
		expect(unwrapProgram(decoy)).toBe(decoy);
	});
});
