// The schema is draft 2020-12; ajv's default export only knows draft-07.
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { beforeAll, describe, expect, it } from 'vitest';
import schema from './schema.json' with { type: 'json' };
import { COMPONENT_TYPES } from './types.js';
import { samples } from '../samples/index.js';
import type { BuildProgram } from './types.js';

let validate: ValidateFunction;

beforeAll(() => {
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	validate = ajv.compile(schema);
});

function valid(program: unknown): boolean {
	const ok = validate(program);
	if (!ok) {
		// Surfacing the first few errors makes a failure diagnosable without a debugger.
		console.error(validate.errors?.slice(0, 5));
	}
	return ok;
}

/** Minimal program the individual component cases can be dropped into. */
function withComponent(component: unknown): unknown {
	return {
		version: 1,
		meta: { name: 'test' },
		size: { x: 8, y: 8, z: 8 },
		palette: { wall_primary: 'minecraft:stone' },
		components: [component],
	};
}

describe('schema covers the component union', () => {
	it('has one case per ComponentType, and no extras', () => {
		// This is the drift guard. COMPONENT_TYPES cannot fall behind the TS union (a
		// compile-time Record forces that), and this assertion stops the schema falling
		// behind COMPONENT_TYPES.
		const cases = (schema.$defs.component.anyOf as { properties: { type: { const: string } } }[]).map(
			(entry) => entry.properties.type.const,
		);
		expect([...cases].sort()).toEqual([...COMPONENT_TYPES].sort());
	});
});

describe('schema accepts real programs', () => {
	it.each(Object.keys(samples))('accepts the %s sample', (name) => {
		expect(valid(samples[name] as BuildProgram)).toBe(true);
	});

	it('accepts components carrying id and label, so a diff-refined program round-trips', () => {
		// The pipeline assigns ids before a diff refine and the model echoes them back;
		// rejecting the field would turn every diff refine into a paid repair round.
		expect(
			valid(
				withComponent({
					type: 'box',
					id: 'walls',
					label: 'Main walls',
					pos: [0, 0, 0],
					size: [1, 1, 1],
					fill: { type: 'solid', role: 'wall_primary' },
				}),
			),
		).toBe(true);
		// Still additive, not lax: an id has to look like an identifier.
		expect(
			validate(
				withComponent({
					type: 'box',
					id: 'not a valid id!',
					pos: [0, 0, 0],
					size: [1, 1, 1],
					fill: { type: 'solid', role: 'wall_primary' },
				}),
			),
		).toBe(false);
	});

	it('accepts a resized program, so refining one does not cost a repair round', () => {
		// The editor writes `scale` into the program and refine hands that program back to the
		// model. If the schema did not know the field, the model echoing it would fail
		// validation and buy a paid repair round for a field it was right to keep.
		expect(valid({ ...(samples.cottage as BuildProgram), scale: { x: 200, y: 150, z: 200 } })).toBe(true);
		expect(validate({ ...(samples.cottage as BuildProgram), scale: { x: 200, y: 150 } })).toBe(false);
	});
});

describe('schema accepts valid coordinate expressions', () => {
	it.each([4, -3, 'min', 'max', 'center', 'max-1', 'center+2', '50%', '$floors', '$floors*4+1', '$height*30%', '$height-2+$radius', 'max - 1'])(
		'accepts %s',
		(coord) => {
			expect(valid(withComponent({ type: 'box', pos: [coord, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'wall_primary' } }))).toBe(true);
		},
	);

	it.each(['maxx', 'center*', '', 'min++1', '$', 'fifty%%'])('rejects %s', (coord) => {
		expect(validate(withComponent({ type: 'box', pos: [coord, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'wall_primary' } }))).toBe(false);
	});
});

describe('schema rejects malformed programs', () => {
	it('rejects an unknown component type', () => {
		expect(validate(withComponent({ type: 'teapot', pos: [0, 0, 0] }))).toBe(false);
	});

	it('rejects a component missing a required field', () => {
		expect(validate(withComponent({ type: 'box', pos: [0, 0, 0] }))).toBe(false);
	});

	it('rejects an unexpected property, so typos surface instead of being ignored', () => {
		expect(
			validate(
				withComponent({
					type: 'box',
					pos: [0, 0, 0],
					size: [1, 1, 1],
					fill: { type: 'solid', role: 'wall_primary' },
					colour: 'red',
				}),
			),
		).toBe(false);
	});

	it('rejects a build larger than the caps allow', () => {
		expect(
			validate({
				version: 1,
				meta: { name: 'huge' },
				size: { x: 999, y: 8, z: 8 },
				palette: { a: 'minecraft:stone' },
				components: [{ type: 'box', pos: [0, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'a' } }],
			}),
		).toBe(false);
	});

	it('rejects an empty palette', () => {
		expect(
			validate({
				version: 1,
				meta: { name: 'x' },
				size: { x: 8, y: 8, z: 8 },
				palette: {},
				components: [{ type: 'box', pos: [0, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'a' } }],
			}),
		).toBe(false);
	});

	it('rejects a malformed block reference', () => {
		expect(validate(withComponent({ type: 'door', face: 'south', at: [0, 0, 0], role: 'Oak Door' }))).toBe(true);
		// A role is free text, but an explicit block id must look like one.
		expect(
			validate({
				version: 1,
				meta: { name: 'x' },
				size: { x: 8, y: 8, z: 8 },
				palette: { a: 'Oak Planks' },
				components: [{ type: 'box', pos: [0, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'a' } }],
			}),
		).toBe(false);
	});

	it('accepts a block reference carrying states', () => {
		expect(
			valid({
				version: 1,
				meta: { name: 'x' },
				size: { x: 8, y: 8, z: 8 },
				palette: { a: 'minecraft:oak_stairs[facing=north,half=top]' },
				components: [{ type: 'box', pos: [0, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'a' } }],
			}),
		).toBe(true);
	});
});

describe('schema handles nesting', () => {
	it('accepts a group with transforms and nested children', () => {
		expect(
			valid(
				withComponent({
					type: 'group',
					transform: [
						{ op: 'translate', by: [1, 0, 1] },
						{ op: 'repeat', count: 4, step: [5, 0, 0] },
					],
					children: [
						{
							type: 'group',
							transform: [{ op: 'rotate90', times: 1, pivot: 'center' }],
							children: [
								{ type: 'box', pos: [0, 0, 0], size: [1, 6, 1], fill: { type: 'solid', role: 'wall_primary' } },
							],
						},
					],
				}),
			),
		).toBe(true);
	});

	it('rejects an invalid rotation count', () => {
		expect(
			validate(
				withComponent({
					type: 'group',
					transform: [{ op: 'rotate90', times: 5 }],
					children: [{ type: 'box', pos: [0, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'wall_primary' } }],
				}),
			),
		).toBe(false);
	});
});
