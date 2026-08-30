import { describe, expect, it } from 'vitest';
import { samples } from '../samples/index.js';
import { expand } from '../expand/expander.js';
import { partialProgram } from './partialProgram.js';

const full = JSON.stringify(samples.cottage!);

describe('partialProgram', () => {
	it('returns null for a prefix that has not reached the palette', () => {
		const beforePalette = full.indexOf('"palette"');
		expect(partialProgram(full.slice(0, beforePalette))).toBeNull();
	});

	it('yields a zero-component preview once the palette has closed', () => {
		const componentsAt = full.indexOf('"components"');
		const result = partialProgram(full.slice(0, componentsAt));
		expect(result).not.toBeNull();
		expect(result!.components).toBe(0);
		expect(result!.program.size).toEqual(samples.cottage!.size);
		expect(Object.keys(result!.program.palette).length).toBeGreaterThan(0);
	});

	it('keeps only fully-closed components at every prefix length', () => {
		// The exhaustive version of the whole contract: whatever point the stream is cut at,
		// the result either is null or parses into a program whose components are complete —
		// and the count never decreases as the prefix grows.
		let last = -1;
		for (let end = 0; end <= full.length; end += 7) {
			const result = partialProgram(full.slice(0, end));
			if (!result) continue;
			expect(result.components).toBeGreaterThanOrEqual(last);
			last = result.components;
			// Every preview must expand without throwing (expand never throws by contract,
			// but a malformed cut would produce component-shaped junk and errors).
			expect(() => expand(result.program)).not.toThrow();
		}
		// The stride can skip the exact closing brace of the last component, so the full
		// string is checked explicitly rather than trusted to the loop.
		expect(partialProgram(full)!.components).toBe(samples.cottage!.components.length);
		expect(last).toBeGreaterThanOrEqual(samples.cottage!.components.length - 1);
	});

	it('parses the complete program as itself', () => {
		const result = partialProgram(full);
		expect(result).not.toBeNull();
		expect(result!.components).toBe(samples.cottage!.components.length);
		expect(result!.program).toEqual(samples.cottage!);
	});

	it('survives braces and brackets inside strings', () => {
		const tricky = JSON.stringify({
			version: 1,
			meta: { name: 'brace } in [ name' },
			size: { x: 4, y: 4, z: 4 },
			palette: { wall_primary: 'minecraft:stone' },
			components: [
				{ type: 'box', pos: [0, 0, 0], size: [2, 2, 2], fill: { type: 'solid', role: 'wall_primary' } },
			],
		});
		for (let end = 0; end <= tricky.length; end += 3) {
			const result = partialProgram(tricky.slice(0, end));
			if (result) expect(result.components === 0 || result.components === 1).toBe(true);
		}
		expect(partialProgram(tricky)!.components).toBe(1);
	});

	it('keeps a group with nested children intact only once the group closes', () => {
		const program = {
			version: 1,
			meta: { name: 'nested' },
			size: { x: 8, y: 8, z: 8 },
			palette: { wall_primary: 'minecraft:stone' },
			components: [
				{
					type: 'group',
					children: [
						{ type: 'box', pos: [0, 0, 0], size: [2, 2, 2], fill: { type: 'solid', role: 'wall_primary' } },
						{ type: 'box', pos: [4, 0, 0], size: [2, 2, 2], fill: { type: 'solid', role: 'wall_primary' } },
					],
				},
			],
		};
		const json = JSON.stringify(program);
		// Cut inside the group's second child: the group is not closed, so no component may
		// appear — a half-group would expand half a structure and flicker on completion.
		const midChild = json.lastIndexOf('"pos":[4');
		const result = partialProgram(json.slice(0, midChild));
		expect(result).not.toBeNull();
		expect(result!.components).toBe(0);
	});

	it('returns null for junk', () => {
		expect(partialProgram('')).toBeNull();
		expect(partialProgram('not json')).toBeNull();
		expect(partialProgram('{"palette": 3')).toBeNull();
	});
});
