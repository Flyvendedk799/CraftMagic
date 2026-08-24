/**
 * Bakes a `BuildProgram` into voxels.
 *
 * Two properties matter more than anything else here:
 *
 *  - **Determinism.** The same program must always produce the same grid, or a stored build
 *    would drift away from the program that describes it and resizing would reshuffle the
 *    structure. Nothing in this path uses `Math.random` or wall-clock time.
 *  - **Partial failure.** A component that cannot be drawn is skipped and reported, never
 *    thrown. A user who asked for a castle should get the castle minus one bad turret, with
 *    an explanation — not a blank screen.
 */

import type {
	BuildProgram,
	Component,
	Coord,
	CVec3,
	DetailOp,
	ExpandIssue,
	ExpandResult,
	Transform,
	Vec3,
} from '../ir/types.js';
import { AIR_BLOCK, COMPONENT_TYPES, LIMITS } from '../ir/types.js';
import { CoordError, clampParam, resolveCoord } from '../ir/coords.js';
import { validateBlockRef } from '../registry/registry.js';
import {
	Brush,
	IDENTITY_FRAME,
	VoxelCanvas,
	mirrored,
	rotated,
	translated,
	type Frame,
} from './canvas.js';
import { Palette, rolesOf } from './fills.js';
import {
	buildBox,
	buildCylinder,
	buildHollowBox,
	buildLine,
	buildPyramid,
	buildSphere,
} from './components/primitives.js';
import { buildGableRoof, buildHipRoof, buildStairsRun } from './components/roofs.js';
import { buildArch, buildDoor, buildWindowGrid } from './components/openings.js';

/** Share of a build that may fall outside the volume before it is worth reporting. */
const CLIP_WARNING_RATIO = 0.05;

export function expand(program: BuildProgram): ExpandResult {
	const errors: ExpandIssue[] = [];
	const warnings: ExpandIssue[] = [];

	const size = clampSize(program.size, errors);
	const canvas = new VoxelCanvas(size);
	const palette = new Palette(program.palette ?? {});
	const params = normalizeParams(program.params);

	validatePaletteBlocks(program, errors);

	const rootBrush = new Brush(canvas, IDENTITY_FRAME);
	const components = program.components ?? [];

	if (components.length > LIMITS.maxComponents) {
		warnings.push({
			path: 'components',
			code: 'SIZE_CAP',
			message: `program has ${components.length} components; only the first ${LIMITS.maxComponents} were drawn`,
		});
	}

	const ctx: ExpandContext = { size, palette, params, errors, warnings, canvas };

	components.slice(0, LIMITS.maxComponents).forEach((component, index) => {
		drawComponent(rootBrush, component, `components[${index}]`, ctx);
	});

	applyDetails(rootBrush, program.details ?? [], ctx);

	// Roles referenced but never defined would silently draw nothing, so surface them once
	// at the end rather than per-block.
	for (const role of palette.missing) {
		errors.push({
			path: 'palette',
			code: 'UNDEFINED_ROLE',
			message: `components use the role "${role}" but the palette does not define it`,
		});
	}

	const grid = canvas.finish();
	let blockCount = 0;
	for (let i = 0; i < grid.voxels.length; i++) if (grid.voxels[i] !== 0) blockCount++;

	if (blockCount > LIMITS.maxBlocks) {
		warnings.push({
			path: 'components',
			code: 'SIZE_CAP',
			message: `build contains ${blockCount} blocks, above the ${LIMITS.maxBlocks} limit`,
		});
	}

	// Writes landing outside the volume are usually deliberate — a roof overhang is meant to
	// project past its walls — so a handful is not worth mentioning. Losing a serious share
	// of the build is different: it means `size` is too small for what was drawn, most often
	// because a param was turned up past what the volume can hold. Reporting it turns a
	// silently truncated dome into something the user, and the repair round, can act on.
	const clipped = canvas.clippedWrites;
	if (clipped > 0 && clipped > blockCount * CLIP_WARNING_RATIO) {
		warnings.push({
			path: 'size',
			code: 'OUT_OF_BOUNDS',
			message:
				`${clipped} blocks fell outside the ${size.x}x${size.y}x${size.z} build volume and were dropped. ` +
				`Enlarge "size" — remember it must fit the largest value each param can take.`,
		});
	}

	return { grid, blockCount, warnings, errors };
}

interface ExpandContext {
	size: { x: number; y: number; z: number };
	palette: Palette;
	params: Record<string, import('../ir/types.js').ProgramParam> | undefined;
	errors: ExpandIssue[];
	warnings: ExpandIssue[];
	canvas: VoxelCanvas;
}

function clampSize(
	size: { x: number; y: number; z: number } | undefined,
	errors: ExpandIssue[],
): { x: number; y: number; z: number } {
	const raw = size ?? { x: 16, y: 16, z: 16 };
	const clamped = {
		x: clampAxis(raw.x, LIMITS.maxSizeX),
		y: clampAxis(raw.y, LIMITS.maxSizeY),
		z: clampAxis(raw.z, LIMITS.maxSizeZ),
	};
	if (clamped.x !== raw.x || clamped.y !== raw.y || clamped.z !== raw.z) {
		errors.push({
			path: 'size',
			code: 'SIZE_CAP',
			message: `size ${raw.x}x${raw.y}x${raw.z} is outside the allowed range; clamped to ${clamped.x}x${clamped.y}x${clamped.z} (max ${LIMITS.maxSizeX}x${LIMITS.maxSizeY}x${LIMITS.maxSizeZ})`,
		});
	}
	return clamped;
}

function clampAxis(value: number, max: number): number {
	if (!Number.isFinite(value)) return 16;
	return Math.max(1, Math.min(max, Math.floor(value)));
}

function normalizeParams(
	params: BuildProgram['params'],
): Record<string, import('../ir/types.js').ProgramParam> | undefined {
	if (!params) return undefined;
	const out: Record<string, import('../ir/types.js').ProgramParam> = {};
	for (const [name, param] of Object.entries(params)) {
		out[name] = { ...param, value: clampParam(param) };
	}
	return out;
}

function validatePaletteBlocks(program: BuildProgram, errors: ExpandIssue[]): void {
	for (const [role, entry] of Object.entries(program.palette ?? {})) {
		const refs = typeof entry === 'string' ? [entry] : entry.map((e) => e.block);
		for (const ref of refs) {
			const problem = validateBlockRef(ref);
			if (problem) {
				errors.push({ path: `palette.${role}`, code: problem.code, message: problem.message });
			}
		}
	}
}

// --- component dispatch -------------------------------------------------

function drawComponent(brush: Brush, component: Component, path: string, ctx: ExpandContext): void {
	// Roles are checked up front so a typo reports the component that caused it rather than
	// surfacing later as a mysteriously empty region.
	const missingBefore = ctx.palette.missing.size;

	try {
		draw(brush, component, path, ctx);
	} catch (err) {
		if (err instanceof CoordError) {
			ctx.errors.push({ path, code: 'BAD_COORD_EXPR', message: err.message });
		} else {
			ctx.errors.push({
				path,
				code: 'EMPTY_COMPONENT',
				message: `could not draw ${component.type}: ${(err as Error).message}`,
			});
		}
		return;
	}

	if (ctx.palette.missing.size > missingBefore) {
		// Already recorded globally; nothing further to add here.
	}
}

function draw(brush: Brush, component: Component, path: string, ctx: ExpandContext): void {
	const pos = (v: CVec3) => resolvePos(v, ctx);
	const len = (v: CVec3) => resolveLen(v, ctx);

	switch (component.type) {
		case 'box':
			checkRoles(component.fill, path, ctx);
			buildBox(brush, ctx.palette, { pos: pos(component.pos), size: len(component.size) }, component.fill);
			return;

		case 'hollow_box':
			checkRoles(component.fill, path, ctx);
			buildHollowBox(
				brush,
				ctx.palette,
				{ pos: pos(component.pos), size: len(component.size) },
				component.fill,
				{
					wallThickness: count(component.wallThickness, ctx, 1),
					floor: component.floor,
					ceiling: component.ceiling,
				},
			);
			return;

		case 'cylinder':
			checkRoles(component.fill, path, ctx);
			buildCylinder(
				brush,
				ctx.palette,
				pos(component.base),
				scalar(component.radius, ctx, 'x'),
				scalar(component.height, ctx, 'y'),
				component.axis ?? 'y',
				component.hollow ?? false,
				component.fill,
			);
			return;

		case 'sphere':
			checkRoles(component.fill, path, ctx);
			buildSphere(
				brush,
				ctx.palette,
				pos(component.center),
				scalar(component.radius, ctx, 'x'),
				component.hollow ?? false,
				component.cap ?? 'full',
				component.fill,
			);
			return;

		case 'pyramid':
			checkRoles(component.fill, path, ctx);
			buildPyramid(
				brush,
				ctx.palette,
				pos(component.pos),
				[scalar(component.baseSize[0], ctx, 'x'), scalar(component.baseSize[1], ctx, 'z')],
				count(component.step, ctx, 1),
				component.hollow ?? false,
				component.fill,
			);
			return;

		case 'gable_roof':
			requireRole(component.roofRole, path, ctx);
			buildGableRoof(
				brush,
				ctx.palette,
				{ pos: pos(component.pos), size: len(component.size) },
				component.ridgeAxis,
				count(component.overhang, ctx, 0),
				component.style ?? 'stairs',
				component.roofRole,
				component.trimRole,
			);
			return;

		case 'hip_roof':
			requireRole(component.roofRole, path, ctx);
			buildHipRoof(
				brush,
				ctx.palette,
				{ pos: pos(component.pos), size: len(component.size) },
				count(component.overhang, ctx, 0),
				component.style ?? 'stairs',
				component.roofRole,
			);
			return;

		case 'arch':
			if (!component.carve) checkRoles(component.fill, path, ctx);
			buildArch(
				brush,
				ctx.palette,
				pos(component.pos),
				scalar(component.width, ctx, component.axis),
				scalar(component.height, ctx, 'y'),
				scalar(component.depth, ctx, component.axis === 'x' ? 'z' : 'x'),
				component.axis,
				component.style ?? 'round',
				component.fill,
				component.carve ?? false,
			);
			return;

		case 'window_grid':
			requireRole(component.role, path, ctx);
			buildWindowGrid(brush, ctx.palette, {
				face: component.face,
				region: { pos: pos(component.region.pos), size: len(component.region.size) },
				rows: count(component.rows, ctx, 1),
				cols: count(component.cols, ctx, 1),
				windowSize: [count(component.windowSize[0], ctx, 1), count(component.windowSize[1], ctx, 1)],
				margin: count(component.margin, ctx, 0),
				role: component.role,
				sill: component.sill ?? false,
			});
			return;

		case 'door':
			requireRole(component.role, path, ctx);
			buildDoor(
				brush,
				ctx.palette,
				component.face,
				pos(component.at),
				component.width ?? 1,
				component.height ?? 2,
				component.role,
			);
			return;

		case 'line':
			checkRoles(component.fill, path, ctx);
			buildLine(
				brush,
				ctx.palette,
				pos(component.from),
				pos(component.to),
				count(component.thickness, ctx, 1),
				component.fill,
			);
			return;

		case 'stairs_run':
			requireRole(component.role, path, ctx);
			buildStairsRun(
				brush,
				ctx.palette,
				pos(component.pos),
				component.direction,
				scalar(component.width, ctx, 'x'),
				scalar(component.steps, ctx, 'y'),
				component.role,
				component.style ?? 'stairs',
			);
			return;

		case 'group':
			drawGroup(brush, component, path, ctx);
			return;

		default: {
			// Without this, a component type the expander does not know is silently skipped:
			// the build comes out empty or incomplete with no errors to explain why, and a
			// repair round is never triggered because nothing looks wrong.
			const unknown = component as { type?: unknown };
			ctx.errors.push({
				path,
				code: 'EMPTY_COMPONENT',
				message:
					`unknown component type ${JSON.stringify(unknown.type)}. ` +
					`Supported types: ${COMPONENT_TYPES.join(', ')}.`,
			});
			return;
		}
	}
}

/**
 * Groups apply their transforms to every child.
 *
 * `repeat` is handled as an outer loop rather than a frame, because it is the one transform
 * that draws its children more than once.
 */
function drawGroup(
	brush: Brush,
	group: Extract<Component, { type: 'group' }>,
	path: string,
	ctx: ExpandContext,
): void {
	const centre: Vec3 = [
		Math.floor((ctx.size.x - 1) / 2),
		Math.floor((ctx.size.y - 1) / 2),
		Math.floor((ctx.size.z - 1) / 2),
	];

	const repeats: Transform[] = [];
	let frame: Frame = brush.currentFrame;

	for (const transform of group.transform ?? []) {
		switch (transform.op) {
			case 'translate':
				frame = translated(frame, transform.by);
				break;
			case 'rotate90':
				frame = rotated(frame, transform.times, resolvePivot(transform.pivot, centre));
				break;
			case 'mirror':
				frame = mirrored(frame, transform.axis, resolvePivot(transform.pivot, centre));
				break;
			case 'repeat':
				repeats.push(transform);
				break;
		}
	}

	const drawChildren = (childFrame: Frame, label: string) => {
		const childBrush = brush.withFrame(childFrame);
		group.children.forEach((child, index) => {
			drawComponent(childBrush, child, `${label}.children[${index}]`, ctx);
		});
	};

	if (repeats.length === 0) {
		drawChildren(frame, path);
		return;
	}

	// Nested repeats multiply, so a 3x3 courtyard is two repeats rather than nine groups.
	const expandRepeats = (index: number, current: Frame, label: string): void => {
		if (index >= repeats.length) {
			drawChildren(current, label);
			return;
		}
		const repeat = repeats[index] as Extract<Transform, { op: 'repeat' }>;
		const count = Math.max(1, Math.min(256, Math.floor(repeat.count)));
		for (let i = 0; i < count; i++) {
			let stepFrame = translated(current, [
				repeat.step[0] * i,
				repeat.step[1] * i,
				repeat.step[2] * i,
			]);
			if (repeat.alternateMirror && i % 2 === 1) {
				stepFrame = mirrored(stepFrame, 'x', centre);
			}
			expandRepeats(index + 1, stepFrame, `${label}[${i}]`);
		}
	};

	expandRepeats(0, frame, path);
}

function resolvePivot(pivot: 'center' | CVec3 | undefined, centre: Vec3): Vec3 {
	if (pivot === undefined || pivot === 'center') return centre;
	// A pivot given as raw numbers is used as-is; expressions are not supported here
	// because a pivot must stay fixed while children move around it.
	return [Number(pivot[0]) || 0, Number(pivot[1]) || 0, Number(pivot[2]) || 0];
}

// --- coordinate helpers -------------------------------------------------

function resolvePos(v: CVec3, ctx: ExpandContext): [number, number, number] {
	return [
		resolveCoord(v[0], { extent: ctx.size.x, params: ctx.params }),
		resolveCoord(v[1], { extent: ctx.size.y, params: ctx.params }),
		resolveCoord(v[2], { extent: ctx.size.z, params: ctx.params }),
	];
}

/** Sizes are lengths, so they resolve against `extent`, not `extent - 1`. */
function resolveLen(v: CVec3, ctx: ExpandContext): [number, number, number] {
	const extents = [ctx.size.x, ctx.size.y, ctx.size.z];
	return [0, 1, 2].map((i) =>
		Math.max(0, resolveCoord(v[i]!, { extent: extents[i]! + 1, params: ctx.params })),
	) as [number, number, number];
}

function scalar(value: Coord, ctx: ExpandContext, axis: 'x' | 'y' | 'z'): number {
	const extent = axis === 'x' ? ctx.size.x : axis === 'y' ? ctx.size.y : ctx.size.z;
	return resolveCoord(value, { extent: extent + 1, params: ctx.params });
}

/**
 * Resolve a count or thickness — a magnitude rather than a position.
 *
 * These accept expressions for the same reason coordinates do: "one row of windows per
 * floor" is `rows: "$floors"`, and a program that cannot say that has to hard-code a number
 * that then stops matching when the param moves. There is no axis to anchor against, so
 * `min`/`max`/`%` are meaningless here and simply resolve against a unit span.
 */
function count(value: Coord | undefined, ctx: ExpandContext, fallback: number): number {
	if (value === undefined) return fallback;
	return resolveCoord(value, { extent: 1, params: ctx.params });
}

function checkRoles(fill: import('../ir/types.js').Fill, path: string, ctx: ExpandContext): void {
	for (const role of rolesOf(fill)) requireRole(role, path, ctx);
}

function requireRole(role: string, path: string, ctx: ExpandContext): void {
	if (ctx.palette.has(role) || role.includes(':')) return;
	ctx.palette.missing.add(role);
	void path;
}

// --- details ------------------------------------------------------------

function applyDetails(brush: Brush, details: DetailOp[], ctx: ExpandContext): void {
	if (details.length > LIMITS.maxDetailOps) {
		ctx.warnings.push({
			path: 'details',
			code: 'DETAIL_CAP',
			message: `program has ${details.length} detail ops; only the first ${LIMITS.maxDetailOps} were applied`,
		});
	}

	details.slice(0, LIMITS.maxDetailOps).forEach((op, index) => {
		const path = `details[${index}]`;

		// Details take coordinate expressions like everything else, so a bad one is reported
		// against its own op rather than aborting the whole details pass.
		let at: Vec3 | undefined;
		let from: Vec3 | undefined;
		let to: Vec3 | undefined;
		try {
			if (op.op === 'set') at = resolvePos(op.at, ctx);
			else {
				from = resolvePos(op.from, ctx);
				to = resolvePos(op.to, ctx);
			}
		} catch (err) {
			ctx.errors.push({
				path,
				code: err instanceof CoordError ? 'BAD_COORD_EXPR' : 'BAD_STATE',
				message: (err as Error).message,
			});
			return;
		}

		switch (op.op) {
			case 'set': {
				const problem = validateBlockRef(op.block);
				if (problem) {
					ctx.errors.push({ path, code: problem.code, message: problem.message });
					return;
				}
				brush.set(at![0], at![1], at![2], op.block);
				return;
			}
			case 'fill':
			case 'clear': {
				const volume = boxVolume(from!, to!);
				if (volume > LIMITS.maxDetailFillVolume) {
					ctx.errors.push({
						path,
						code: 'DETAIL_CAP',
						message: `detail ${op.op} covers ${volume} blocks, above the ${LIMITS.maxDetailFillVolume} limit — use a box component instead`,
					});
					return;
				}
				const block = op.op === 'fill' ? op.block : AIR_BLOCK;
				if (op.op === 'fill') {
					const problem = validateBlockRef(block);
					if (problem) {
						ctx.errors.push({ path, code: problem.code, message: problem.message });
						return;
					}
				}
				forEachInBox(from!, to!, (x, y, z) => {
					if (op.op === 'clear') brush.clear(x, y, z);
					else brush.set(x, y, z, block);
				});
				return;
			}
		}
	});
}

function boxVolume(from: Vec3, to: Vec3): number {
	return (
		(Math.abs(to[0] - from[0]) + 1) *
		(Math.abs(to[1] - from[1]) + 1) *
		(Math.abs(to[2] - from[2]) + 1)
	);
}

function forEachInBox(from: Vec3, to: Vec3, fn: (x: number, y: number, z: number) => void): void {
	const [x0, x1] = from[0] <= to[0] ? [from[0], to[0]] : [to[0], from[0]];
	const [y0, y1] = from[1] <= to[1] ? [from[1], to[1]] : [to[1], from[1]];
	const [z0, z1] = from[2] <= to[2] ? [from[2], to[2]] : [to[2], from[2]];
	for (let y = y0; y <= y1; y++) {
		for (let z = z0; z <= z1; z++) {
			for (let x = x0; x <= x1; x++) fn(x, y, z);
		}
	}
}
