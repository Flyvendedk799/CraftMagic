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
	BuildPart,
	BuildProgram,
	Component,
	Coord,
	CVec3,
	DetailOp,
	ExpandIssue,
	ExpandOptions,
	ExpandResult,
	Face,
	Transform,
	Vec3,
} from '../ir/types.js';
import { AIR_BLOCK, COMPONENT_TYPES, LIMITS, voxelPosition } from '../ir/types.js';
import { CoordError, clampParam, resolveCoord } from '../ir/coords.js';
import { scaleFactors, scaleLen, scalePos, scaledSize, type Size3 } from '../ir/scale.js';
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

export function expand(program: BuildProgram, options: ExpandOptions = {}): ExpandResult {
	const errors: ExpandIssue[] = [];
	const warnings: ExpandIssue[] = [];
	const provenance = options.provenance === true;

	// Coordinates resolve against the program's *own* size and are scaled afterwards, so a
	// resize enlarges the structure rather than only the volume it sits in. At 100% the factors
	// are 1 and every coordinate comes out exactly as it did before.
	const base = clampSize(program.size, errors);
	const size = scaledSize(base, program.scale);
	const factor = scaleFactors(base, program.scale);

	const canvas = new VoxelCanvas(size, provenance);
	const palette = new Palette(program.palette ?? {});
	const params = normalizeParams(program.params);
	const parts = new PartRegistry(provenance);

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

	const ctx: ExpandContext = { base, size, factor, palette, params, errors, warnings, canvas, parts };

	components.slice(0, LIMITS.maxComponents).forEach((component, index) => {
		const path = `components[${index}]`;
		drawComponent(rootBrush, component, path, path, ctx);
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

	return {
		grid,
		blockCount,
		warnings,
		errors,
		origin: canvas.origin,
		parts: canvas.origin ? parts.measure(canvas.origin, size) : [],
	};
}

/**
 * Hands out one id per component that draws, and remembers what each one is.
 *
 * Keyed by a path that deliberately omits repeat indices, so the ten thousand towers a pair
 * of nested `repeat`s produces stay one part rather than ten thousand. That is the whole
 * reason identity is a string key and not a running counter.
 *
 * Inert when provenance is off: `claim` returns 0, `beginPart(0)` is what the canvas already
 * assumes, and nothing is allocated.
 */
class PartRegistry {
	private readonly byKey = new Map<string, BuildPart>();
	private readonly ordered: BuildPart[] = [];

	constructor(private readonly enabled: boolean) {}

	claim(key: string, type: BuildPart['type'], describe: () => Pick<BuildPart, 'role' | 'face'>): number {
		if (!this.enabled) return 0;

		const existing = this.byKey.get(key);
		if (existing) return existing.id;
		if (this.ordered.length >= LIMITS.maxParts) return 0;

		const part: BuildPart = { id: this.ordered.length + 1, path: key, type, blocks: 0, ...describe() };
		this.byKey.set(key, part);
		this.ordered.push(part);
		return part.id;
	}

	/**
	 * Count and bound what each part actually kept.
	 *
	 * One pass over the finished origin map, after every component has had its turn — so a
	 * wall painted over by a later wall is measured at what survived, not at what it drew.
	 * Parts that kept nothing are dropped: an invisible part is not worth a line in any
	 * document, and their ids simply never appear in `origin`.
	 */
	measure(origin: Uint16Array, size: Size3): BuildPart[] {
		for (let i = 0; i < origin.length; i++) {
			const id = origin[i]!;
			if (id === 0) continue;
			const part = this.ordered[id - 1];
			if (!part) continue;

			const [x, y, z] = voxelPosition(size, i);
			if (part.blocks === 0) {
				part.min = [x, y, z];
				part.max = [x, y, z];
			} else {
				const min = part.min!;
				const max = part.max!;
				if (x < min[0]) min[0] = x;
				if (y < min[1]) min[1] = y;
				if (z < min[2]) min[2] = z;
				if (x > max[0]) max[0] = x;
				if (y > max[1]) max[1] = y;
				if (z > max[2]) max[2] = z;
			}
			part.blocks++;
		}

		return this.ordered.filter((part) => part.blocks > 0);
	}
}

interface ExpandContext {
	/** The program's own size — the space its coordinates are written in. */
	base: Size3;
	/** The volume actually drawn, after `program.scale`. */
	size: Size3;
	/** Per-axis multiplier from base space to drawn space. All 1 when nothing is scaled. */
	factor: Size3;
	palette: Palette;
	params: Record<string, import('../ir/types.js').ProgramParam> | undefined;
	errors: ExpandIssue[];
	warnings: ExpandIssue[];
	canvas: VoxelCanvas;
	parts: PartRegistry;
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

/**
 * @param path    Where this draw happened, repeat indices and all — what an error message
 *                must quote so the user can find the component that failed.
 * @param partKey The same location with repeats collapsed, which is what gives every copy of
 *                a repeated child one shared identity. Errors want the former, provenance the
 *                latter, and conflating them was the difference between "Tower walls" and a
 *                hundred parts called "Tower walls".
 */
function drawComponent(
	brush: Brush,
	component: Component,
	path: string,
	partKey: string,
	ctx: ExpandContext,
): void {
	// Roles are checked up front so a typo reports the component that caused it rather than
	// surfacing later as a mysteriously empty region.
	const missingBefore = ctx.palette.missing.size;

	// A group has no geometry of its own — only its leaves write — so it claims nothing and
	// lets each child own what it draws.
	if (component.type !== 'group') {
		ctx.canvas.beginPart(ctx.parts.claim(partKey, component.type, () => describePart(component)));
	}

	try {
		draw(brush, component, path, partKey, ctx);
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

/**
 * The two facts about a component worth carrying into provenance: what it is made of, and
 * which wall it faces.
 *
 * A role only survives when the component draws in exactly one — a checkerboard of
 * foundation and path is neither, and calling it either would be a lie a document then
 * repeats. `face` is only ever the component's own declaration; nothing is inferred here.
 */
function describePart(component: Exclude<Component, { type: 'group' }>): Pick<BuildPart, 'role' | 'face'> {
	const only = (roles: string[]): string | undefined => (roles.length === 1 ? roles[0] : undefined);
	const withFace = (role: string | undefined, face: Face) => ({ ...(role ? { role } : {}), face });

	switch (component.type) {
		case 'box':
		case 'hollow_box':
		case 'cylinder':
		case 'sphere':
		case 'pyramid':
		case 'line':
		case 'arch': {
			const role = only(rolesOf(component.fill));
			return role ? { role } : {};
		}
		case 'gable_roof':
		case 'hip_roof':
			return { role: component.roofRole };
		case 'window_grid':
			return withFace(component.role, component.face);
		case 'door':
			return withFace(component.role, component.face);
		case 'stairs_run':
			return withFace(component.role, component.direction);
	}
}

function draw(
	brush: Brush,
	component: Component,
	path: string,
	partKey: string,
	ctx: ExpandContext,
): void {
	const pos = (v: CVec3) => resolvePos(v, ctx);
	const box = (at: CVec3, size: CVec3) => region(at, size, ctx);

	switch (component.type) {
		case 'box':
			checkRoles(component.fill, path, ctx);
			buildBox(brush, ctx.palette, box(component.pos, component.size), component.fill);
			return;

		case 'hollow_box':
			checkRoles(component.fill, path, ctx);
			buildHollowBox(
				brush,
				ctx.palette,
				box(component.pos, component.size),
				component.fill,
				{
					// Thickness reaches into all three axes: the walls in x/z, the floor and
					// ceiling in y.
					wallThickness: magnitude(component.wallThickness, ctx, AXES, 1),
					floor: component.floor,
					ceiling: component.ceiling,
				},
			);
			return;

		case 'cylinder': {
			checkRoles(component.fill, path, ctx);
			// The radius lies in the two axes the cylinder does *not* run along, and the height
			// along the one it does.
			const axis = component.axis ?? 'y';
			buildCylinder(
				brush,
				ctx.palette,
				pos(component.base),
				scalar(component.radius, ctx, 'x', AXES.filter((a) => a !== axis)),
				scalar(component.height, ctx, axis),
				axis,
				component.hollow ?? false,
				component.fill,
			);
			return;
		}

		case 'sphere':
			checkRoles(component.fill, path, ctx);
			// A sphere is round in all three, so under a per-axis resize it stays a sphere and
			// takes the axis that grew least rather than bulging out of its own build.
			buildSphere(
				brush,
				ctx.palette,
				pos(component.center),
				scalar(component.radius, ctx, 'x', AXES),
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
				// The inset each tier takes is a horizontal distance, so it follows x and z.
				magnitude(component.step, ctx, ['x', 'z'], 1),
				component.hollow ?? false,
				component.fill,
			);
			return;

		case 'gable_roof':
			requireRole(component.roofRole, path, ctx);
			buildGableRoof(
				brush,
				ctx.palette,
				box(component.pos, component.size),
				component.ridgeAxis,
				// Eaves project horizontally, so the overhang grows with the footprint.
				magnitude(component.overhang, ctx, ['x', 'z'], 0, 0),
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
				box(component.pos, component.size),
				magnitude(component.overhang, ctx, ['x', 'z'], 0, 0),
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

		case 'window_grid': {
			requireRole(component.role, path, ctx);
			// A north/south wall spans x, an east/west wall spans z. Window width and the
			// corner margin lie along that axis; window height is always y. The row and column
			// *counts* stay put, so a resized wall gets bigger windows rather than more of them
			// — the facade keeps its design instead of being redrawn.
			const span: AxisName = component.face === 'north' || component.face === 'south' ? 'x' : 'z';
			buildWindowGrid(brush, ctx.palette, {
				face: component.face,
				region: box(component.region.pos, component.region.size),
				rows: count(component.rows, ctx, 1),
				cols: count(component.cols, ctx, 1),
				windowSize: [
					magnitude(component.windowSize[0], ctx, [span], 1),
					magnitude(component.windowSize[1], ctx, ['y'], 1),
				],
				margin: magnitude(component.margin, ctx, [span], 0, 0),
				role: component.role,
				sill: component.sill ?? false,
			});
			return;
		}

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
				// A line's girth is perpendicular to a direction only known at draw time.
				magnitude(component.thickness, ctx, AXES, 1),
				component.fill,
			);
			return;

		case 'stairs_run': {
			requireRole(component.role, path, ctx);
			// Each step climbs one and travels one, so the number of them is bounded by
			// whichever of those two axes grew least; width runs across the travel direction.
			const travel: AxisName =
				component.direction === 'north' || component.direction === 'south' ? 'z' : 'x';
			const across: AxisName = travel === 'z' ? 'x' : 'z';
			buildStairsRun(
				brush,
				ctx.palette,
				pos(component.pos),
				component.direction,
				scalar(component.width, ctx, 'x', [across]),
				scalar(component.steps, ctx, 'y', ['y', travel]),
				component.role,
				component.style ?? 'stairs',
			);
			return;
		}

		case 'group':
			drawGroup(brush, component, path, partKey, ctx);
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
	partKey: string,
	ctx: ExpandContext,
): void {
	// The pivot is the *scaled* centre of the program's own volume, not the centre of the drawn
	// one: children arrive here already scaled, so mirroring them about anything else would
	// land the reflection a block or two off its original position.
	const centre: Vec3 = [
		scalePos(Math.floor((ctx.base.x - 1) / 2), ctx.factor.x),
		scalePos(Math.floor((ctx.base.y - 1) / 2), ctx.factor.y),
		scalePos(Math.floor((ctx.base.z - 1) / 2), ctx.factor.z),
	];

	const repeats: Transform[] = [];
	let frame: Frame = brush.currentFrame;

	for (const transform of group.transform ?? []) {
		switch (transform.op) {
			case 'translate':
				frame = translated(frame, scaleVec(transform.by, ctx));
				break;
			case 'rotate90':
				frame = rotated(frame, transform.times, resolvePivot(transform.pivot, centre, ctx));
				break;
			case 'mirror':
				frame = mirrored(frame, transform.axis, resolvePivot(transform.pivot, centre, ctx));
				break;
			case 'repeat':
				repeats.push(transform);
				break;
		}
	}

	// `label` carries the repeat index and `partKey` does not, which is exactly the point:
	// the hundredth copy of a tower reports its own path in an error and shares the first
	// copy's part in the guide.
	const drawChildren = (childFrame: Frame, label: string) => {
		const childBrush = brush.withFrame(childFrame);
		group.children.forEach((child, index) => {
			drawComponent(childBrush, child, `${label}.children[${index}]`, `${partKey}.children[${index}]`, ctx);
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
		// The stride is a distance, so it scales; the count is a count, so it does not. A row
		// of pillars spreads across the larger footprint instead of huddling in one corner of
		// it, and stays the same row of pillars.
		//
		// The *accumulated* offset is what gets scaled, never the stride on its own: rounding a
		// stride of 2.6 up to 3 and then multiplying by the index walks the last pillar of a
		// long row clean out of the build volume.
		for (let i = 0; i < count; i++) {
			let stepFrame = translated(
				current,
				scaleVec([repeat.step[0] * i, repeat.step[1] * i, repeat.step[2] * i], ctx),
			);
			if (repeat.alternateMirror && i % 2 === 1) {
				stepFrame = mirrored(stepFrame, 'x', centre);
			}
			expandRepeats(index + 1, stepFrame, `${label}[${i}]`);
		}
	};

	expandRepeats(0, frame, path);
}

function resolvePivot(
	pivot: 'center' | CVec3 | undefined,
	centre: Vec3,
	ctx: ExpandContext,
): Vec3 {
	if (pivot === undefined || pivot === 'center') return centre;
	// A pivot given as raw numbers is used as-is; expressions are not supported here
	// because a pivot must stay fixed while children move around it. It is still a position in
	// the program's own space, so it scales like one.
	return scaleVec([Number(pivot[0]) || 0, Number(pivot[1]) || 0, Number(pivot[2]) || 0], ctx);
}

/** Scale a literal offset written in the program's own coordinate space. */
function scaleVec(v: Vec3, ctx: ExpandContext): Vec3 {
	return [
		scalePos(v[0], ctx.factor.x),
		scalePos(v[1], ctx.factor.y),
		scalePos(v[2], ctx.factor.z),
	];
}

// --- coordinate helpers -------------------------------------------------

type AxisName = 'x' | 'y' | 'z';

const AXES = ['x', 'y', 'z'] as const;

/**
 * Everything below resolves against `ctx.base` — the size the program was written for — and
 * then scales the result. That is what makes a resize move *every* block: a literal `radius: 7`
 * or a `$height` param has no relationship to the build volume, so re-resolving it against a
 * bigger volume changes nothing, while scaling what it resolved to changes it by exactly the
 * factor the user asked for.
 */
function resolvePos(v: CVec3, ctx: ExpandContext): Vec3 {
	const raw = basePos(v, ctx);
	return [
		scalePos(raw[0], ctx.factor.x),
		scalePos(raw[1], ctx.factor.y),
		scalePos(raw[2], ctx.factor.z),
	];
}

/** A position in the program's own space, before scaling. */
function basePos(v: CVec3, ctx: ExpandContext): Vec3 {
	return [
		resolveCoord(v[0], { extent: ctx.base.x, params: ctx.params }),
		resolveCoord(v[1], { extent: ctx.base.y, params: ctx.params }),
		resolveCoord(v[2], { extent: ctx.base.z, params: ctx.params }),
	];
}

/**
 * A component's box, scaled by its two corners rather than by its position and length
 * separately.
 *
 * Rounding a position and a length independently lets them drift apart: at 54% a roof that sat
 * flush inside its volume comes out a block wider than the volume it is inside, and the eaves
 * are silently dropped. Scaling `pos` and `pos + size` and subtracting keeps every edge exactly
 * where the scaled coordinate space puts it.
 */
function region(at: CVec3, size: CVec3, ctx: ExpandContext): { pos: Vec3; size: Vec3 } {
	const near = basePos(at, ctx);
	const extent = baseLen(size, ctx);
	const pos = scaleVec(near, ctx);

	return {
		pos,
		size: AXES.map((axis, i) => {
			if (extent[i]! <= 0) return 0;
			const far = scalePos(near[i]! + extent[i]!, ctx.factor[axis]);
			return Math.max(1, far - pos[i]!);
		}) as Vec3,
	};
}

/** Sizes are lengths, so they resolve against `extent`, not `extent - 1`. */
function baseLen(v: CVec3, ctx: ExpandContext): Vec3 {
	return AXES.map((axis, i) =>
		Math.max(0, resolveCoord(v[i]!, { extent: ctx.base[axis] + 1, params: ctx.params })),
	) as Vec3;
}

/**
 * A length along one known axis — a radius, a height, a run of steps.
 *
 * `spans` is the axes the length actually occupies, which is not always the one it is written
 * against: a radius resolves as an x-axis length but a cylinder's radius reaches into two axes
 * at once, and under a per-axis resize it can only follow the smaller of them.
 */
function scalar(
	value: Coord,
	ctx: ExpandContext,
	axis: AxisName,
	spans: readonly AxisName[] = [axis],
): number {
	const raw = resolveCoord(value, { extent: ctx.base[axis] + 1, params: ctx.params });
	return scaleLen(raw, minFactor(ctx, spans));
}

/**
 * Resolve a count — a number of things rather than a distance.
 *
 * These accept expressions for the same reason coordinates do: "one row of windows per
 * floor" is `rows: "$floors"`, and a program that cannot say that has to hard-code a number
 * that then stops matching when the param moves. There is no axis to anchor against, so
 * `min`/`max`/`%` are meaningless here and simply resolve against a unit span.
 *
 * Counts do not scale. A house twice the size wants windows twice as big, not twice as many —
 * doubling the count would redesign the facade rather than resize it.
 */
function count(value: Coord | undefined, ctx: ExpandContext, fallback: number): number {
	if (value === undefined) return fallback;
	return resolveCoord(value, { extent: 1, params: ctx.params });
}

/**
 * A distance whose axis is ambiguous — wall thickness, a roof overhang, a line's girth.
 *
 * Takes the smallest factor of the axes it could lie along. Under a linked resize they are all
 * the same number anyway; under a per-axis one, the smallest is the only choice that cannot
 * push a thickness through the geometry it is meant to sit inside.
 */
function magnitude(
	value: Coord | undefined,
	ctx: ExpandContext,
	axes: readonly AxisName[],
	fallback: number,
	/** Where shrinking stops — 0 for trim a small build is better off without. */
	min = 1,
): number {
	return scaleLen(count(value, ctx, fallback), minFactor(ctx, axes), min);
}

function minFactor(ctx: ExpandContext, axes: readonly AxisName[]): number {
	return Math.min(...axes.map((axis) => ctx.factor[axis]));
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
	// Every detail op shares one part. They are accents by definition — the schema caps a
	// single fill at 512 blocks and calls them "small accents only" — so five thousand parts
	// named `details[0]`…`details[4999]` would bury the handful of parts that describe the
	// actual structure. One "Details" part is what a builder would say out loud anyway.
	ctx.canvas.beginPart(ctx.parts.claim('details', 'details', () => ({})));

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
		// The unscaled corners are kept because the fill cap below measures what the *program*
		// asked for. Charging it for the resize would turn a legal detail into an error the
		// moment somebody dragged the size slider.
		let baseFrom: Vec3 | undefined;
		let baseTo: Vec3 | undefined;
		try {
			if (op.op === 'set') at = resolvePos(op.at, ctx);
			else {
				baseFrom = basePos(op.from, ctx);
				baseTo = basePos(op.to, ctx);
				from = scaleVec(baseFrom, ctx);
				to = scaleVec(baseTo, ctx);
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
				const volume = boxVolume(baseFrom!, baseTo!);
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
