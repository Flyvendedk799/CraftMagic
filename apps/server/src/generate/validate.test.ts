import { describe, expect, it } from 'vitest';
import { schemaIssues } from './validate.js';

const base = {
	version: 1,
	meta: { name: 'Stone Cottage' },
	size: { x: 9, y: 9, z: 9 },
	palette: { wall: 'minecraft:stone_bricks' },
	components: [
		{ type: 'box', pos: [0, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'wall' } },
	],
};

describe('schemaIssues', () => {
	it('passes a well formed program', () => {
		expect(schemaIssues(base)).toEqual([]);
	});

	/**
	 * Errors under `/details` are dropped so each op can be reported against the branch its
	 * own `op` names — which used to drop the error saying `details` was not a list at all.
	 * A program with `details` as a sentence came back clean from here and then crashed the
	 * expander, so the generation failed with a TypeError instead of a repair round.
	 */
	it('reports a details field that is not an array', () => {
		const issues = schemaIssues({ ...base, details: 'lanterns on the corner posts' });
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({ path: 'details' });
		expect(issues[0]?.message).toContain('array');
	});

	it('reports a single detail op handed over without its array', () => {
		const issues = schemaIssues({
			...base,
			details: { op: 'set', at: [0, 0, 0], block: 'minecraft:lantern' },
		});
		expect(issues).toContainEqual(expect.objectContaining({ path: 'details' }));
	});

	it('still attributes a bad detail op to its own index', () => {
		const issues = schemaIssues({ ...base, details: [{ op: 'teleport' }] });
		expect(issues).toContainEqual(
			expect.objectContaining({ path: 'details[0]', message: expect.stringContaining('teleport') }),
		);
	});

	it('accepts a program with no details at all', () => {
		expect(schemaIssues({ ...base, details: [] })).toEqual([]);
	});

	it('reports components that are not an array', () => {
		expect(schemaIssues({ ...base, components: 'a stone cottage' })).toContainEqual(
			expect.objectContaining({ path: 'components' }),
		);
	});
});
