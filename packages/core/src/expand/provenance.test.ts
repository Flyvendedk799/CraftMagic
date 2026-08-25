/**
 * Provenance: which component each voxel came from.
 *
 * The properties worth pinning are the ones a build guide would silently get wrong —
 * repeated children collapsing to one part, overpainting transferring ownership, and carving
 * handing a cell back rather than keeping it.
 */

import { describe, expect, it } from 'vitest';
import { expand } from './expander.js';
import { cottage, samples } from '../samples/index.js';
import type { BuildProgram } from '../ir/types.js';
import { voxelIndex } from '../ir/types.js';

function program(components: BuildProgram['components'], extra: Partial<BuildProgram> = {}): BuildProgram {
	return {
		version: 1,
		meta: { name: 'Test' },
		size: { x: 12, y: 8, z: 12 },
		palette: {
			wall_primary: 'minecraft:oak_planks',
			foundation: 'minecraft:stone',
			roof_primary: 'minecraft:bricks',
		},
		components,
		...extra,
	};
}

describe('expand — provenance is opt-in', () => {
	it('costs nothing when not asked for', () => {
		const result = expand(cottage);
		expect(result.origin).toBeNull();
		expect(result.parts).toEqual([]);
	});

	it('does not change the voxels it records', () => {
		const plain = expand(cottage);
		const traced = expand(cottage, { provenance: true });
		expect(Array.from(traced.grid.voxels)).toEqual(Array.from(plain.grid.voxels));
		expect(traced.grid.palette).toEqual(plain.grid.palette);
		expect(traced.blockCount).toBe(plain.blockCount);
	});
});

describe('expand — provenance covers the build', () => {
	it('attributes every placed block to a part', () => {
		for (const [name, sample] of Object.entries(samples)) {
			const { origin, blockCount, parts } = expand(sample, { provenance: true });
			let owned = 0;
			for (const id of origin!) if (id !== 0) owned++;
			expect(owned, name).toBe(blockCount);

			// The parts' own tallies must add up to the same total, or a bill of parts would
			// quietly disagree with the bill of materials on the facing page.
			expect(parts.reduce((sum, part) => sum + part.blocks, 0), name).toBe(blockCount);
		}
	});

	it('gives every part id a part to look up', () => {
		const { origin, parts } = expand(cottage, { provenance: true });
		const known = new Set(parts.map((part) => part.id));
		for (const id of origin!) {
			if (id !== 0) expect(known.has(id)).toBe(true);
		}
	});

	it('records the role and the declared face', () => {
		const { parts } = expand(cottage, { provenance: true });
		const windows = parts.filter((part) => part.type === 'window_grid');
		expect(windows.length).toBeGreaterThan(0);
		for (const part of windows) {
			expect(part.role).toBe('window');
			expect(part.face).toBeDefined();
		}
	});

	it('leaves the role off a component that draws in more than one', () => {
		const { parts } = expand(
			program([
				{
					type: 'box',
					pos: [0, 0, 0],
					size: [6, 1, 6],
					fill: { type: 'checker', a: 'foundation', b: 'wall_primary', plane: 'xz' },
				},
			]),
			{ provenance: true },
		);
		expect(parts).toHaveLength(1);
		expect(parts[0]!.role).toBeUndefined();
	});
});

describe('expand — provenance and painter order', () => {
	it('transfers ownership when a later component paints over an earlier one', () => {
		const { origin, parts, grid } = expand(
			program([
				{ type: 'box', pos: [0, 0, 0], size: [6, 1, 6], fill: { type: 'solid', role: 'foundation' } },
				{ type: 'box', pos: [0, 0, 0], size: [3, 1, 6], fill: { type: 'solid', role: 'wall_primary' } },
			]),
			{ provenance: true },
		);

		const first = parts.find((part) => part.path === 'components[0]')!;
		const second = parts.find((part) => part.path === 'components[1]')!;
		expect(first.blocks).toBe(18);
		expect(second.blocks).toBe(18);
		expect(origin![voxelIndex(grid.size, 0, 0, 0)]).toBe(second.id);
		expect(origin![voxelIndex(grid.size, 5, 0, 0)]).toBe(first.id);
	});

	it('drops a component painted over completely', () => {
		const { parts } = expand(
			program([
				{ type: 'box', pos: [0, 0, 0], size: [4, 1, 4], fill: { type: 'solid', role: 'foundation' } },
				{ type: 'box', pos: [0, 0, 0], size: [4, 1, 4], fill: { type: 'solid', role: 'wall_primary' } },
			]),
			{ provenance: true },
		);
		// An invisible part earns no line in any document.
		expect(parts.map((part) => part.path)).toEqual(['components[1]']);
	});

	it('hands a carved cell back rather than crediting the wall it was cut from', () => {
		const { origin, grid, parts } = expand(
			program(
				[{ type: 'box', pos: [0, 0, 0], size: [4, 1, 4], fill: { type: 'solid', role: 'foundation' } }],
				{ details: [{ op: 'clear', from: [0, 0, 0], to: [1, 0, 1] }] },
			),
			{ provenance: true },
		);

		expect(origin![voxelIndex(grid.size, 0, 0, 0)]).toBe(0);
		expect(parts.find((part) => part.path === 'components[0]')!.blocks).toBe(12);
	});

	it('gathers every detail op into one part rather than one part per op', () => {
		const { parts } = expand(
			program([{ type: 'box', pos: [0, 0, 0], size: [4, 1, 4], fill: { type: 'solid', role: 'foundation' } }], {
				details: [
					{ op: 'set', at: [0, 1, 0], block: 'minecraft:torch' },
					{ op: 'set', at: [3, 1, 3], block: 'minecraft:torch' },
				],
			}),
			{ provenance: true },
		);

		const details = parts.filter((part) => part.type === 'details');
		expect(details).toHaveLength(1);
		expect(details[0]!.blocks).toBe(2);
	});
});

describe('expand — provenance and repeats', () => {
	it('keeps every copy of a repeated child in one part', () => {
		const { parts } = expand(
			program([
				{
					type: 'group',
					transform: [{ op: 'repeat', count: 4, step: [3, 0, 0] }],
					children: [
						{ type: 'box', pos: [0, 0, 0], size: [1, 4, 1], fill: { type: 'solid', role: 'wall_primary' } },
					],
				},
			]),
			{ provenance: true },
		);

		// Four pillars, one part — otherwise a courtyard of a hundred towers would produce a
		// hundred indistinguishable entries in the bill of parts.
		expect(parts).toHaveLength(1);
		expect(parts[0]!.path).toBe('components[0].children[0]');
		expect(parts[0]!.blocks).toBe(16);
	});

	it('still separates distinct children of the same group', () => {
		const { parts } = expand(
			program([
				{
					type: 'group',
					children: [
						{ type: 'box', pos: [0, 0, 0], size: [1, 4, 1], fill: { type: 'solid', role: 'wall_primary' } },
						{ type: 'box', pos: [6, 0, 0], size: [1, 4, 1], fill: { type: 'solid', role: 'foundation' } },
					],
				},
			]),
			{ provenance: true },
		);
		expect(parts.map((part) => part.path)).toEqual([
			'components[0].children[0]',
			'components[0].children[1]',
		]);
	});

	it('bounds a part by what it kept, not by where it drew', () => {
		const { parts } = expand(
			program([
				{
					type: 'group',
					transform: [{ op: 'repeat', count: 3, step: [4, 0, 0] }],
					children: [
						{ type: 'box', pos: [0, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'wall_primary' } },
					],
				},
			]),
			{ provenance: true },
		);
		expect(parts[0]!.min).toEqual([0, 0, 0]);
		expect(parts[0]!.max).toEqual([8, 0, 0]);
	});
});
