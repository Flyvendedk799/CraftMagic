import { describe, expect, it } from 'vitest';
import { expand } from '../expand/expander.js';
import { cottage } from '../samples/index.js';
import type { BuildPart, VoxelGrid } from '../ir/types.js';
import {
	DEFAULT_DESIGN_SYSTEM,
	bearing,
	difficultyFor,
	labelParts,
	type BuildGuideDesignSystem,
} from './design-system.js';

const SIZE: VoxelGrid['size'] = { x: 21, y: 19, z: 13 };

function part(over: Partial<BuildPart> & Pick<BuildPart, 'type'>): BuildPart {
	return {
		id: 1,
		path: 'components[0]',
		blocks: 10,
		min: [0, 0, 0],
		max: [SIZE.x - 1, 0, SIZE.z - 1],
		...over,
	};
}

describe('design system — naming a part', () => {
	it('prefers the role over the component type', () => {
		// A cylinder is a tower in general, but a cylinder drawing `foundation` is the pad the
		// tower stands on — the sample tower opens with exactly this component.
		const [labelled] = labelParts([part({ type: 'cylinder', role: 'foundation' })], SIZE);
		expect(labelled!.label).toBe('Foundation');
	});

	it('falls back to the component type when the role is unknown', () => {
		const [labelled] = labelParts([part({ type: 'cylinder', role: 'my_custom_role' })], SIZE);
		expect(labelled!.label).toBe('Tower');
	});

	it('falls back to the type when there is no single role at all', () => {
		const [labelled] = labelParts([part({ type: 'hip_roof' })], SIZE);
		expect(labelled!.label).toBe('Roof');
	});

	it('leads with the wall the component declared', () => {
		const [labelled] = labelParts([part({ type: 'window_grid', role: 'window', face: 'south' })], SIZE);
		expect(labelled!.label).toBe('South windows');
	});

	it('does not lower-case a role name the user capitalised deliberately', () => {
		const design: BuildGuideDesignSystem = {
			...DEFAULT_DESIGN_SYSTEM,
			roleLabels: { ...DEFAULT_DESIGN_SYSTEM.roleLabels, strip: 'LED strip' },
		};
		const [labelled] = labelParts([part({ type: 'line', role: 'strip', face: 'north' })], SIZE, design);
		expect(labelled!.label).toBe('North LED strip');
	});
});

describe('design system — names are unique', () => {
	it('separates same-named parts by where they sit', () => {
		const corner = (id: number, x: number, z: number): BuildPart =>
			part({ id, type: 'box', role: 'frame', min: [x, 0, z], max: [x, 4, z], path: `components[${id}]` });

		const labels = labelParts(
			[
				corner(1, 0, 0),
				corner(2, SIZE.x - 1, 0),
				corner(3, 0, SIZE.z - 1),
				corner(4, SIZE.x - 1, SIZE.z - 1),
			],
			SIZE,
		).map((p) => p.label);

		expect(labels).toEqual([
			'Frame (north-west)',
			'Frame (north-east)',
			'Frame (south-west)',
			'Frame (south-east)',
		]);
	});

	it('leaves a lone part unqualified', () => {
		// Nothing to disambiguate against, so the bearing is noise rather than information.
		const [labelled] = labelParts([part({ type: 'box', role: 'frame', min: [0, 0, 0], max: [0, 4, 0] })], SIZE);
		expect(labelled!.label).toBe('Frame');
	});

	it('numbers parts that even a bearing cannot separate', () => {
		const stacked = (id: number, y: number): BuildPart =>
			part({ id, type: 'box', role: 'frame', min: [0, y, 0], max: [0, y, 0], path: `components[${id}]` });

		const labels = labelParts([stacked(1, 0), stacked(2, 4)], SIZE).map((p) => p.label);
		expect(labels).toEqual(['Frame (north-west)', 'Frame (north-west) 2']);
		expect(new Set(labels).size).toBe(2);
	});

	it('gives a real build no two parts the same name', () => {
		const { grid, parts } = expand(cottage, { provenance: true });
		const labels = labelParts(parts, grid.size).map((p) => p.label);
		expect(new Set(labels).size).toBe(labels.length);
	});
});

describe('design system — bearings', () => {
	it('names a side for a part hugging one edge', () => {
		const northWall = part({ type: 'box', min: [0, 0, 0], max: [SIZE.x - 1, 5, 0] });
		expect(bearing(northWall, SIZE)).toBe('north');
	});

	it('says nothing about a part sitting in the middle', () => {
		const centred = part({
			type: 'box',
			min: [SIZE.x >> 1, 0, SIZE.z >> 1],
			max: [SIZE.x >> 1, 5, SIZE.z >> 1],
		});
		expect(bearing(centred, SIZE)).toBeUndefined();
	});

	it('says nothing about a part with no bounds', () => {
		expect(bearing({ ...part({ type: 'box' }), min: undefined, max: undefined }, SIZE)).toBeUndefined();
	});

	it('survives a build one block wide', () => {
		const flat = { x: 1, y: 4, z: 1 };
		expect(bearing(part({ type: 'box', min: [0, 0, 0], max: [0, 3, 0] }), flat)).toBeUndefined();
	});
});

describe('design system — difficulty', () => {
	it('reads the bands in order', () => {
		expect(difficultyFor(1)).toBe('simple');
		expect(difficultyFor(10)).toBe('simple');
		expect(difficultyFor(11)).toBe('moderate');
		expect(difficultyFor(30)).toBe('moderate');
		expect(difficultyFor(31)).toBe('complex');
		expect(difficultyFor(80)).toBe('complex');
		expect(difficultyFor(81)).toBe('epic');
		expect(difficultyFor(100_000)).toBe('epic');
	});

	it('honours a design system that rescales them', () => {
		const strict: BuildGuideDesignSystem = {
			...DEFAULT_DESIGN_SYSTEM,
			difficulty: [
				{ upTo: 2, label: 'simple' },
				{ upTo: Infinity, label: 'epic' },
			],
		};
		expect(difficultyFor(2, strict)).toBe('simple');
		expect(difficultyFor(3, strict)).toBe('epic');
	});
});
