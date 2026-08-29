/**
 * Structural validation of a generated program.
 *
 * The API cannot enforce our schema — strict tool use rejects it because a group's children
 * are themselves components, which is a circular `$ref`. So the same schema is enforced
 * here instead, before the expander runs.
 *
 * Error *quality* is the whole point of this module. A component is a tagged union, and a
 * plain `anyOf` failure reports every branch that did not match: one stray property on a
 * window_grid produces a dozen complaints about missing `pos`/`size`/`fill` from the box
 * branch, none of which name the real problem. Since each repair round costs real money,
 * a misleading message is expensive. So components are validated against the single branch
 * their own `type` names, which produces exactly the errors that apply.
 */

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import schema from '@craftmagic/core/schema' with { type: 'json' };
import { COMPONENT_TYPES, type ExpandIssue } from '@craftmagic/core';

interface Compiled {
	program: ValidateFunction;
	/** One validator per component type, so union errors can be attributed correctly. */
	byType: Map<string, ValidateFunction>;
	/** Same, for detail ops, which are a union on `op`. */
	byOp: Map<string, ValidateFunction>;
}

const DETAIL_OPS = ['set', 'fill', 'clear'] as const;

let compiled: Compiled | undefined;

function compile(): Compiled {
	if (compiled) return compiled;

	const ajv = new Ajv2020({ allErrors: true, strict: false });
	ajv.addSchema(schema, 'build-program');

	const branches = (schema as unknown as {
		$defs: { component: { anyOf: { properties: { type: { const: string } } }[] } };
	}).$defs.component.anyOf;

	const byType = new Map<string, ValidateFunction>();
	branches.forEach((branch, index) => {
		const type = branch.properties.type.const;
		byType.set(
			type,
			ajv.compile({
				$ref: `build-program#/$defs/component/anyOf/${index}`,
			}),
		);
	});

	const byOp = new Map<string, ValidateFunction>();
	DETAIL_OPS.forEach((op, index) => {
		byOp.set(op, ajv.compile({ $ref: `build-program#/$defs/detailOp/anyOf/${index}` }));
	});

	compiled = { program: ajv.compile(schema), byType, byOp };
	return compiled;
}

function walkDetails(details: unknown[], add: (path: string, message: string) => void): void {
	const { byOp } = compile();

	details.forEach((detail, index) => {
		const path = `details[${index}]`;
		if (typeof detail !== 'object' || detail === null) {
			add(path, `${path} must be an object`);
			return;
		}

		const op = (detail as { op?: unknown }).op;
		if (typeof op !== 'string') {
			add(path, `${path} is missing its "op" field`);
			return;
		}

		const validate = byOp.get(op);
		if (!validate) {
			add(path, `${path} has unknown op ${JSON.stringify(op)}. Supported: ${DETAIL_OPS.join(', ')}.`);
			return;
		}

		if (!validate(detail)) {
			for (const error of validate.errors ?? []) {
				if (error.keyword === 'anyOf') continue;
				const full = `${path}${jsonPathToDotted(error.instancePath)}`;
				add(full, `${full} ${error.message ?? 'is invalid'}${describeParams(error)}`);
			}
		}
	});
}

/** Returns structural problems, most useful first. Empty means the program is well formed. */
export function schemaIssues(program: unknown): ExpandIssue[] {
	const { program: validateProgram } = compile();
	if (validateProgram(program)) return [];

	const issues: ExpandIssue[] = [];
	const seen = new Set<string>();

	const add = (path: string, message: string) => {
		const key = `${path}|${message}`;
		if (seen.has(key) || issues.length >= 30) return;
		seen.add(key);
		issues.push({ path, code: 'BAD_STATE', message });
	};

	// Problems outside the tagged unions: size, palette, meta, missing top-level fields.
	// Components and details are handled below, per branch, because a plain `anyOf` failure
	// there names the wrong branch.
	for (const error of validateProgram.errors ?? []) {
		if (error.instancePath.startsWith('/components')) continue;
		if (error.instancePath.startsWith('/details')) continue;
		if (error.keyword === 'anyOf') continue;
		const path = jsonPathToDotted(error.instancePath) || 'program';
		add(path, `${path} ${error.message ?? 'is invalid'}${describeParams(error)}`);
	}

	// Errors under `/details` are skipped above so the per-op branch can attribute them, which
	// left one gap: a `details` that is not a list at all had its own error skipped too and no
	// branch to report it, so a program with `details` as a string produced no complaint here
	// and then broke the expander. Details are optional, so only a present one is checked.
	const details = (program as { details?: unknown }).details;
	if (Array.isArray(details)) walkDetails(details, add);
	else if (details !== undefined && details !== null) {
		add('details', 'details must be an array of { op: "set" | "fill" | "clear", ... } objects');
	}

	// Components, attributed to the branch each one's own `type` names.
	const components = (program as { components?: unknown }).components;
	if (Array.isArray(components)) {
		walkComponents(components, 'components', add);
	} else {
		add('components', 'components must be an array of build components');
	}

	return issues;
}

function walkComponents(
	components: unknown[],
	basePath: string,
	add: (path: string, message: string) => void,
): void {
	const { byType } = compile();

	components.forEach((component, index) => {
		const path = `${basePath}[${index}]`;
		if (typeof component !== 'object' || component === null) {
			add(path, `${path} must be an object`);
			return;
		}

		const type = (component as { type?: unknown }).type;
		if (typeof type !== 'string') {
			add(path, `${path} is missing its "type" field`);
			return;
		}

		const validate = byType.get(type);
		if (!validate) {
			add(
				path,
				`${path} has unknown type ${JSON.stringify(type)}. Supported types: ${COMPONENT_TYPES.join(', ')}.`,
			);
			return;
		}

		if (!validate(component)) {
			for (const error of validate.errors ?? []) {
				if (error.keyword === 'anyOf') continue;
				const full = `${path}${jsonPathToDotted(error.instancePath)}`;
				add(full, `${full} ${error.message ?? 'is invalid'}${describeParams(error)}`);
			}
		}

		// Groups nest, and a bad child is just as fatal as a bad top-level component.
		if (type === 'group') {
			const children = (component as { children?: unknown }).children;
			if (Array.isArray(children)) walkComponents(children, `${path}.children`, add);
		}
	});
}

/** `/components/3/size` -> `components[3].size`, matching the expander's path style. */
function jsonPathToDotted(instancePath: string): string {
	return instancePath
		.split('/')
		.filter(Boolean)
		.map((segment) => (/^\d+$/.test(segment) ? `[${segment}]` : `.${segment}`))
		.join('');
}

function describeParams(error: ErrorObject): string {
	const params = error.params as Record<string, unknown>;
	if (Array.isArray(params.allowedValues)) {
		return ` (allowed: ${params.allowedValues.join(', ')})`;
	}
	if (typeof params.additionalProperty === 'string') {
		return ` — remove "${params.additionalProperty}"`;
	}
	return '';
}
