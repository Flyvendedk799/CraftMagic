import { describe, expect, it } from 'vitest';
import { applyProgramPatch, assignComponentIds, looksLikePatch } from './patch.js';
import type { BuildProgram, Component } from './types.js';

const box = (id?: string): Component => ({
	type: 'box',
	...(id ? { id } : {}),
	pos: [0, 0, 0],
	size: [2, 2, 2],
	fill: { type: 'solid', role: 'wall_primary' },
});

function program(): BuildProgram {
	return {
		version: 1,
		meta: { name: 'Test' },
		size: { x: 8, y: 8, z: 8 },
		params: { floors: { value: 1, min: 1, max: 3 } },
		palette: { wall_primary: 'minecraft:stone', roof_primary: 'minecraft:oak_stairs' },
		components: [box('walls'), box('roof'), box()],
	};
}

describe('assignComponentIds', () => {
	it('fills gaps without touching existing ids or colliding with them', () => {
		const base = program();
		base.components = [box('c1'), box(), box()];
		const tagged = assignComponentIds(base);
		const ids = tagged.components.map((c) => c.id);
		expect(ids[0]).toBe('c1');
		expect(new Set(ids).size).toBe(3);
		expect(ids.every(Boolean)).toBe(true);
		// The input is never mutated.
		expect(base.components[1]!.id).toBeUndefined();
	});

	it('returns the same object when every component already has an id', () => {
		const base = program();
		base.components = [box('a'), box('b')];
		expect(assignComponentIds(base)).toBe(base);
	});
});

describe('looksLikePatch', () => {
	it('recognises an ops object and rejects a program', () => {
		expect(looksLikePatch({ ops: [] })).toBe(true);
		expect(looksLikePatch(program())).toBe(false);
		expect(looksLikePatch({ ops: [], components: [] })).toBe(false);
		expect(looksLikePatch(null)).toBe(false);
	});
});

describe('applyProgramPatch', () => {
	it('replaces a component by id, keeping the id when the replacement drops it', () => {
		const next = box();
		next.size = [4, 4, 4];
		const { program: out, applied, issues } = applyProgramPatch(program(), [
			{ op: 'replaceComponent', target: 'roof', component: next },
		]);
		expect(applied).toBe(1);
		expect(issues).toEqual([]);
		expect(out.components[1]!.size).toEqual([4, 4, 4]);
		expect(out.components[1]!.id).toBe('roof');
	});

	it('replaces by index as the fallback for unnamed components', () => {
		const next = box('new');
		const { program: out, applied } = applyProgramPatch(program(), [
			{ op: 'replaceComponent', target: 2, component: next },
		]);
		expect(applied).toBe(1);
		expect(out.components[2]!.id).toBe('new');
	});

	it('adds a component, at the end or before an anchor', () => {
		const { program: out } = applyProgramPatch(program(), [
			{ op: 'addComponent', component: box('tail') },
			{ op: 'addComponent', component: box('head'), before: 'walls' },
		]);
		expect(out.components.map((c) => c.id)).toEqual(['head', 'walls', 'roof', undefined, 'tail']);
	});

	it('removes a component but refuses to remove the last one', () => {
		const base = program();
		const first = applyProgramPatch(base, [{ op: 'removeComponent', target: 'roof' }]);
		expect(first.program.components.map((c) => c.id)).toEqual(['walls', undefined]);

		const single: BuildProgram = { ...base, components: [box('only')] };
		const second = applyProgramPatch(single, [{ op: 'removeComponent', target: 'only' }]);
		expect(second.applied).toBe(0);
		expect(second.issues[0]!.message).toMatch(/last component/);
	});

	it('sets, replaces and removes palette roles and params', () => {
		const { program: out, applied, issues } = applyProgramPatch(program(), [
			{ op: 'setPalette', role: 'wall_primary', block: 'minecraft:bricks' },
			{ op: 'setPalette', role: 'trim', block: [{ block: 'minecraft:stone', weight: 1 }] },
			{ op: 'setPalette', role: 'roof_primary', block: null },
			{ op: 'setParam', name: 'height', param: { value: 5, min: 3, max: 9 } },
			{ op: 'setParam', name: 'floors', param: null },
		]);
		expect(issues).toEqual([]);
		expect(applied).toBe(5);
		expect(out.palette.wall_primary).toBe('minecraft:bricks');
		expect(out.palette.trim).toEqual([{ block: 'minecraft:stone', weight: 1 }]);
		expect('roof_primary' in out.palette).toBe(false);
		expect(out.params).toEqual({ height: { value: 5, min: 3, max: 9 } });
	});

	it('merges meta fields without clearing the others', () => {
		const { program: out } = applyProgramPatch(program(), [
			{ op: 'setMeta', description: 'now with a porch' },
		]);
		expect(out.meta).toEqual({ name: 'Test', description: 'now with a porch' });
	});

	it('skips bad ops with an issue each and applies the rest', () => {
		const { program: out, applied, issues } = applyProgramPatch(program(), [
			{ op: 'replaceComponent', target: 'nope', component: box() },
			{ op: 'removeComponent', target: 99 },
			{ op: 'teleport', to: 'the moon' },
			'not even an object',
			{ op: 'setMeta', name: 'Still Applied' },
		]);
		expect(applied).toBe(1);
		expect(out.meta.name).toBe('Still Applied');
		expect(issues).toHaveLength(4);
		expect(issues.every((issue) => issue.code === 'BAD_PATCH')).toBe(true);
		// The unknown-id message lists what would have worked.
		expect(issues[0]!.message).toContain('walls');
	});

	it('accepts the wrapped { ops: [...] } shape a tool input arrives in', () => {
		const { applied } = applyProgramPatch(program(), {
			ops: [{ op: 'setMeta', name: 'Wrapped' }],
		});
		expect(applied).toBe(1);
	});

	it('rejects a patch that is not an ops list without touching the program', () => {
		const base = program();
		const { program: out, applied, issues } = applyProgramPatch(base, { nothing: true });
		expect(out).toBe(base);
		expect(applied).toBe(0);
		expect(issues[0]!.message).toContain('"ops"');
	});

	it('never mutates the input program', () => {
		const base = program();
		const snapshot = JSON.parse(JSON.stringify(base));
		applyProgramPatch(base, [
			{ op: 'replaceComponent', target: 'walls', component: box('other') },
			{ op: 'removeComponent', target: 'roof' },
			{ op: 'setPalette', role: 'wall_primary', block: 'minecraft:bricks' },
			{ op: 'setParam', name: 'floors', param: null },
			{ op: 'setMeta', name: 'Changed' },
		]);
		expect(base).toEqual(snapshot);
	});
});
