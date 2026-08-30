/**
 * Program patches — the diff half of diff refine.
 *
 * A refine used to have exactly one shape: the model re-emits the entire program with the
 * change worked in. That is robust but pays for every component the user never mentioned,
 * and invites the classic failure where the model "helpfully" rewrites coordinates it was
 * told to leave alone. A patch turns the contract around: the model names the components it
 * wants to touch, by `id`, and everything else is untouched *by construction*.
 *
 * The applier is deliberately forgiving. Ops come out of a model, so a malformed op is an
 * expected input, not an exception: it is skipped and reported, and the remaining ops still
 * apply. The patched program then goes through exactly the same schema validation and
 * expansion as an emitted one — nothing here needs to be the last line of defence.
 */

import { LIMITS } from './types.js';
import type {
	BlockRef,
	BuildProgram,
	Component,
	ExpandIssue,
	ProgramParam,
	WeightedBlockRef,
} from './types.js';

/** Addresses a component: its `id`, or a plain index into `components` as a fallback. */
export type ComponentTarget = string | number;

export type ProgramPatchOp =
	| { op: 'replaceComponent'; target: ComponentTarget; component: Component }
	| { op: 'addComponent'; component: Component; before?: ComponentTarget }
	| { op: 'removeComponent'; target: ComponentTarget }
	| { op: 'setPalette'; role: string; block: BlockRef | WeightedBlockRef[] | null }
	| { op: 'setParam'; name: string; param: ProgramParam | null }
	| { op: 'setMeta'; name?: string; description?: string; style?: string };

export interface ProgramPatch {
	ops: ProgramPatchOp[];
}

export interface PatchResult {
	program: BuildProgram;
	/** Ops that changed the program. */
	applied: number;
	/** Ops that could not be applied, with why. The rest applied anyway. */
	issues: ExpandIssue[];
}

/** True when a tool input is shaped like a patch rather than a whole program. */
export function looksLikePatch(input: unknown): input is { ops: unknown[] } {
	return (
		typeof input === 'object' &&
		input !== null &&
		Array.isArray((input as { ops?: unknown }).ops) &&
		!('components' in input)
	);
}

/**
 * Give every top-level component an `id`, keeping any it already has.
 *
 * Called on a program before it is shown to the model for a diff refine — an op addressed to
 * an id only works if the ids exist. Generated ids are `c1`, `c2`, … by position, skipping
 * anything already taken so a program that mixes authored and generated ids stays collision
 * free. Children of groups are left alone: a group is one editable unit, and asking the model
 * to address `c3.children[1]` is asking for the failure modes of paths without the benefits.
 */
export function assignComponentIds(program: BuildProgram): BuildProgram {
	const taken = new Set<string>();
	for (const component of program.components) {
		if (component.id) taken.add(component.id);
	}

	let counter = 0;
	const next = (): string => {
		let id: string;
		do {
			counter += 1;
			id = `c${counter}`;
		} while (taken.has(id));
		taken.add(id);
		return id;
	};

	let changed = false;
	const components = program.components.map((component) => {
		if (component.id) return component;
		changed = true;
		return { ...component, id: next() };
	});

	return changed ? { ...program, components } : program;
}

/**
 * Apply a patch, returning a new program. The input is never mutated.
 *
 * `ops` is typed `unknown` because it arrives straight from a tool call: every op is checked
 * before it is trusted, bad ones are skipped and reported in `issues`, and the caller decides
 * what surviving issues mean (the pipeline feeds them to the repair round like any other).
 */
export function applyProgramPatch(program: BuildProgram, ops: unknown): PatchResult {
	const issues: ExpandIssue[] = [];
	const refuse = (path: string, message: string) => {
		issues.push({ path, code: 'BAD_PATCH', message });
	};

	const list = Array.isArray(ops)
		? ops
		: looksLikePatch(ops)
			? ops.ops
			: null;
	if (!list) {
		refuse('ops', 'the patch must be { "ops": [...] }');
		return { program, applied: 0, issues };
	}

	// Working copy: components array is cloned once, palette/params/meta cloned on first write.
	let out: BuildProgram = { ...program, components: [...program.components] };
	let applied = 0;

	const find = (target: unknown, path: string): number | null => {
		if (typeof target === 'number' && Number.isInteger(target)) {
			if (target >= 0 && target < out.components.length) return target;
			refuse(path, `index ${target} is out of range (0..${out.components.length - 1})`);
			return null;
		}
		if (typeof target === 'string') {
			const index = out.components.findIndex((component) => component.id === target);
			if (index >= 0) return index;
			refuse(
				path,
				`no component has id ${JSON.stringify(target)}. Known ids: ${out.components.map((c) => c.id).filter(Boolean).join(', ') || '(none)'}`,
			);
			return null;
		}
		refuse(path, 'target must be a component id (string) or an index (integer)');
		return null;
	};

	const componentOf = (value: unknown, path: string): Component | null => {
		// Only the shallowest check here — the real validation is the program schema, run on
		// the patched result. What this guards is the applier itself indexing into garbage.
		if (typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string') {
			return value as Component;
		}
		refuse(path, 'component must be an object with a "type" field');
		return null;
	};

	list.forEach((raw, index) => {
		const path = `ops[${index}]`;
		if (typeof raw !== 'object' || raw === null) {
			refuse(path, 'each op must be an object');
			return;
		}
		const op = raw as Record<string, unknown>;

		switch (op.op) {
			case 'replaceComponent': {
				const at = find(op.target, path);
				const component = componentOf(op.component, path);
				if (at === null || component === null) return;
				// Keep the target's id unless the replacement brings its own: later ops in the
				// same patch (and the next refine) still need to address this component.
				const kept = out.components[at]!.id;
				out.components[at] = component.id || !kept ? component : { ...component, id: kept };
				applied += 1;
				return;
			}
			case 'addComponent': {
				const component = componentOf(op.component, path);
				if (component === null) return;
				if (out.components.length >= LIMITS.maxComponents) {
					refuse(path, `the program already has ${LIMITS.maxComponents} components`);
					return;
				}
				if (op.before === undefined) {
					out.components.push(component);
				} else {
					const at = find(op.before, path);
					// An unresolvable anchor still adds the component — dropping a paid-for
					// component over its position would lose more than it protects.
					if (at === null) out.components.push(component);
					else out.components.splice(at, 0, component);
				}
				applied += 1;
				return;
			}
			case 'removeComponent': {
				const at = find(op.target, path);
				if (at === null) return;
				if (out.components.length === 1) {
					refuse(path, 'cannot remove the last component');
					return;
				}
				out.components.splice(at, 1);
				applied += 1;
				return;
			}
			case 'setPalette': {
				if (typeof op.role !== 'string' || op.role.length === 0) {
					refuse(path, 'setPalette needs a "role" string');
					return;
				}
				const block = op.block;
				const palette = { ...out.palette };
				if (block === null) {
					if (!(op.role in palette)) {
						refuse(path, `role ${JSON.stringify(op.role)} is not in the palette`);
						return;
					}
					delete palette[op.role];
				} else if (typeof block === 'string' || Array.isArray(block)) {
					palette[op.role] = block as BlockRef | WeightedBlockRef[];
				} else {
					refuse(path, 'setPalette "block" must be a block ref, a weighted list, or null to remove');
					return;
				}
				out = { ...out, palette };
				applied += 1;
				return;
			}
			case 'setParam': {
				if (typeof op.name !== 'string' || op.name.length === 0) {
					refuse(path, 'setParam needs a "name" string');
					return;
				}
				const params = { ...out.params };
				if (op.param === null) {
					if (!(op.name in params)) {
						refuse(path, `param ${JSON.stringify(op.name)} does not exist`);
						return;
					}
					delete params[op.name];
				} else {
					const param = op.param as ProgramParam | undefined;
					if (
						typeof param !== 'object' ||
						param === null ||
						typeof param.value !== 'number' ||
						typeof param.min !== 'number' ||
						typeof param.max !== 'number'
					) {
						refuse(path, 'setParam "param" must be { value, min, max } or null to remove');
						return;
					}
					params[op.name] = param;
				}
				out = { ...out, params };
				applied += 1;
				return;
			}
			case 'setMeta': {
				const meta = { ...out.meta };
				if (op.name !== undefined) {
					if (typeof op.name !== 'string' || op.name.length === 0) {
						refuse(path, 'setMeta "name" must be a non-empty string');
						return;
					}
					meta.name = op.name;
				}
				if (op.description !== undefined) {
					if (typeof op.description !== 'string') {
						refuse(path, 'setMeta "description" must be a string');
						return;
					}
					meta.description = op.description;
				}
				if (op.style !== undefined) {
					if (typeof op.style !== 'string') {
						refuse(path, 'setMeta "style" must be a string');
						return;
					}
					meta.style = op.style;
				}
				out = { ...out, meta };
				applied += 1;
				return;
			}
			default:
				refuse(
					path,
					`unknown op ${JSON.stringify(op.op)}. Supported: replaceComponent, addComponent, removeComponent, setPalette, setParam, setMeta.`,
				);
		}
	});

	return { program: out, applied, issues };
}
