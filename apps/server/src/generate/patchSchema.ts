/**
 * The input schema for `edit_build_program` — the diff half of a refine.
 *
 * Built on top of the program schema's own `$defs` so that a component inside an op is
 * described by exactly the same rules as one inside a program; there is no second definition
 * to drift. Like the program schema, it is advisory at the API level (strict tool use rejects
 * the circular component `$ref`), so `applyProgramPatch` treats every op as untrusted and the
 * patched program still runs through ajv + the expander like any other.
 */

import schema from '@craftmagic/core/schema' with { type: 'json' };

const TARGET = {
	description:
		'Which component: its "id" (as shown in the program you were given), or a 0-based index as a fallback.',
	anyOf: [{ type: 'string', minLength: 1, maxLength: 40 }, { type: 'integer', minimum: 0 }],
};

const OPS = [
	{
		title: 'replaceComponent',
		description: 'Swap one component for a new version of itself. Everything else stays untouched.',
		type: 'object',
		additionalProperties: false,
		required: ['op', 'target', 'component'],
		properties: {
			op: { const: 'replaceComponent' },
			target: TARGET,
			component: { $ref: '#/$defs/component' },
		},
	},
	{
		title: 'addComponent',
		description:
			'Add a component. Appended (drawn last, so it paints over everything) unless "before" names the component it should be drawn ahead of.',
		type: 'object',
		additionalProperties: false,
		required: ['op', 'component'],
		properties: {
			op: { const: 'addComponent' },
			component: { $ref: '#/$defs/component' },
			before: TARGET,
		},
	},
	{
		title: 'removeComponent',
		type: 'object',
		additionalProperties: false,
		required: ['op', 'target'],
		properties: {
			op: { const: 'removeComponent' },
			target: TARGET,
		},
	},
	{
		title: 'setPalette',
		description: 'Point a palette role at a different block (or weighted list). null removes the role.',
		type: 'object',
		additionalProperties: false,
		required: ['op', 'role', 'block'],
		properties: {
			op: { const: 'setPalette' },
			role: { type: 'string', minLength: 1, maxLength: 40 },
			block: {
				anyOf: [
					{ $ref: '#/$defs/blockRef' },
					{ type: 'array', minItems: 1, maxItems: 8, items: { $ref: '#/$defs/weightedBlockRef' } },
					{ type: 'null' },
				],
			},
		},
	},
	{
		title: 'setParam',
		description: 'Add or change a named param. null removes it (only if no coordinate still uses it).',
		type: 'object',
		additionalProperties: false,
		required: ['op', 'name', 'param'],
		properties: {
			op: { const: 'setParam' },
			name: { type: 'string', minLength: 1, maxLength: 40 },
			param: {
				anyOf: [
					{
						type: 'object',
						additionalProperties: false,
						required: ['value', 'min', 'max'],
						properties: {
							value: { type: 'integer' },
							min: { type: 'integer' },
							max: { type: 'integer' },
							label: { type: 'string', maxLength: 40 },
						},
					},
					{ type: 'null' },
				],
			},
		},
	},
	{
		title: 'setMeta',
		description: 'Change the build\'s name, description or style. Only the fields given change.',
		type: 'object',
		additionalProperties: false,
		required: ['op'],
		properties: {
			op: { const: 'setMeta' },
			name: { type: 'string', minLength: 1, maxLength: 80 },
			description: { type: 'string', maxLength: 400 },
			style: { type: 'string', maxLength: 80 },
		},
	},
];

/** JSON Schema for the `edit_build_program` tool input: `{ ops: [...] }`. */
export function programPatchSchema(): Record<string, unknown> {
	return {
		type: 'object',
		additionalProperties: false,
		required: ['ops'],
		properties: {
			ops: {
				description: 'Applied in order against the program you were shown.',
				type: 'array',
				minItems: 1,
				maxItems: 100,
				items: { anyOf: OPS },
			},
		},
		// The program schema's own definitions, so "component" and "blockRef" mean exactly what
		// they mean in emit_build_program.
		$defs: (schema as unknown as { $defs: Record<string, unknown> }).$defs,
	};
}
