/**
 * The build guide's design system.
 *
 * A design system for a *document*, not for a screen: it fixes the decisions that make every
 * guide read the same way, so a booklet for a cottage and a booklet for a castle feel like
 * two pages of one manual rather than two programs' output. Concretely it owns four things —
 *
 *  1. **How big a step is.** The cap, the floor below which a step is not worth a page, and
 *     whether a step may mix parts.
 *  2. **What a part is called.** "South windows", not `components[3]`.
 *  3. **What a step is called.** Named after the part it advances, falling back to its layer
 *     when there is nothing better to say.
 *  4. **The thresholds** the cover reports — difficulty bands, and the stack size a bill of
 *     materials counts in.
 *
 * Naming lives here rather than in the expander on purpose. What a part *is* — a
 * `hollow_box` drawing the role `wall_primary` — is a fact about the program and is settled
 * at expansion. What it is *called* depends on the build's proportions, on what else shares
 * its name, and on which document is asking; that is a design decision, and design decisions
 * belong to the design system.
 *
 * Everything here is data plus pure functions, so a caller can hand {@link buildGuide} a
 * variant — a terser one for a phone, a chattier one for a beginner — without forking the
 * segmentation code.
 */

import type { BuildPart, VoxelGrid } from '../ir/types.js';

export type Difficulty = 'simple' | 'moderate' | 'complex' | 'epic';

/** A part with the name this design system gives it. Unique within a guide. */
export interface GuidePart extends BuildPart {
	label: string;
}

export interface DifficultyBand {
	/** The highest step count that still earns this label. `Infinity` for the last band. */
	readonly upTo: number;
	readonly label: Difficulty;
}

export interface BuildGuideDesignSystem {
	/** Shown on the cover, and the thing to change when forking a variant. */
	readonly name: string;

	readonly step: {
		/**
		 * Blocks one step may ask for. Past this the reader loses their place in the diagram
		 * before they finish placing.
		 */
		readonly maxBlocks: number;
		/** Below this a step is not worth its own page; it folds into the one before. */
		readonly minBlocks: number;
		/**
		 * Keep a step to a single part when provenance says which part is which.
		 *
		 * "Finish this wall, then these windows" is followable; "place these 40 blocks, some
		 * of which are wall and some of which are glass" is not. Without provenance there is
		 * nothing to split on and segmentation falls back to pure geometry.
		 */
		readonly splitByPart: boolean;
	};

	/** The unit inventory actually works in. */
	readonly stackSize: number;

	/** Checked in order; the first band whose `upTo` is not exceeded wins. */
	readonly difficulty: readonly DifficultyBand[];

	/**
	 * What to call a part drawing a given palette role.
	 *
	 * Consulted before {@link typeLabels}, because the role is the more specific fact: a
	 * cylinder is a "Tower" in general, but a cylinder drawing `foundation` is the pad the
	 * tower stands on, and calling that a tower would be plainly wrong.
	 */
	readonly roleLabels: Readonly<Record<string, string>>;

	/** The fallback name for each component type, used when its role has no entry above. */
	readonly typeLabels: Readonly<Record<BuildPart['type'], string>>;

	/** What a step is called when nothing owns its blocks. `{layer}` is substituted. */
	readonly anonymousStep: string;

	/**
	 * How far off-centre a part must sit before the guide will name a side for it.
	 *
	 * A fraction of the build's footprint. Too low and a part that merely leans north gets
	 * called the north wall; too high and four corner posts end up with the same name.
	 */
	readonly edgeThreshold: number;
}

export const DEFAULT_DESIGN_SYSTEM: BuildGuideDesignSystem = {
	name: 'CraftMagic build guide',

	step: {
		maxBlocks: 40,
		minBlocks: 6,
		splitByPart: true,
	},

	stackSize: 64,

	difficulty: [
		{ upTo: 10, label: 'simple' },
		{ upTo: 30, label: 'moderate' },
		{ upTo: 80, label: 'complex' },
		{ upTo: Infinity, label: 'epic' },
	],

	// The vocabulary of `PaletteRole`, plus the handful of names generators reach for anyway.
	// An unlisted role is not an error — it simply falls through to the component type.
	roleLabels: {
		foundation: 'Foundation',
		floor: 'Floor',
		wall_primary: 'Walls',
		wall_secondary: 'Inner walls',
		wall_accent: 'Wall accents',
		frame: 'Frame',
		roof_primary: 'Roof',
		roof_trim: 'Roof trim',
		window: 'Windows',
		door: 'Door',
		trim: 'Trim',
		path: 'Path',
		foliage: 'Planting',
		light: 'Lighting',
		decoration: 'Decoration',
	},

	typeLabels: {
		// What a step calls a placed build. Not its name — the guide is instructions, and
		// "Place the saved build" is the step, whichever building it happens to be.
		prefab: 'Placed build',
		box: 'Structure',
		hollow_box: 'Walls',
		cylinder: 'Tower',
		sphere: 'Dome',
		pyramid: 'Spire',
		gable_roof: 'Roof',
		hip_roof: 'Roof',
		arch: 'Arch',
		window_grid: 'Windows',
		door: 'Door',
		line: 'Beam',
		stairs_run: 'Stairs',
		// Groups never claim a part — only the leaves that actually write do — so this is
		// here to keep the record total rather than because it is ever read.
		group: 'Assembly',
		details: 'Details',
	},

	anonymousStep: 'Layer {layer}',

	edgeThreshold: 1 / 3,
};

/* --- naming ---------------------------------------------------------------------------- */

/**
 * Name every part, and guarantee the names are distinct.
 *
 * Uniqueness is the reason this takes the whole list rather than one part at a time. Four
 * corner posts are four `frame` boxes and would all come out "Frame"; a step that says
 * "Frame" then leaves the reader to work out *which* frame has failed at the only job it
 * had. Duplicates are separated by where they sit — "Frame (north-west)" — and, if even that
 * collides, by a number, so a label is never ambiguous no matter how odd the program.
 */
export function labelParts(
	parts: readonly BuildPart[],
	size: VoxelGrid['size'],
	design: BuildGuideDesignSystem = DEFAULT_DESIGN_SYSTEM,
): GuidePart[] {
	const base = parts.map((part) => baseLabel(part, design));

	const counts = new Map<string, number>();
	for (const label of base) counts.set(label, (counts.get(label) ?? 0) + 1);

	const used = new Set<string>();
	return parts.map((part, i) => {
		let label = base[i]!;

		if ((counts.get(label) ?? 0) > 1) {
			const where = bearing(part, size, design);
			if (where) label = `${label} (${where})`;
		}

		// Two posts on the same edge, or a program odd enough that bearings tie. A number is
		// not informative, but it is unambiguous, which is the property being defended.
		if (used.has(label)) {
			let n = 2;
			while (used.has(`${label} ${n}`)) n++;
			label = `${label} ${n}`;
		}

		used.add(label);
		return { ...part, label };
	});
}

/** The name a part gets before any thought about collisions. */
function baseLabel(part: BuildPart, design: BuildGuideDesignSystem): string {
	const noun =
		(part.role !== undefined ? design.roleLabels[part.role] : undefined) ??
		design.typeLabels[part.type] ??
		'Structure';

	// The component's own declaration, never a guess: a window grid knows which wall it was
	// hung on, and that beats anything derivable from a two-block-thick bounding box.
	if (part.face) return `${capitalise(part.face)} ${lower(noun)}`;
	return noun;
}

/**
 * Where a part sits, as a compass bearing, or undefined if it is central enough that saying
 * would mislead.
 *
 * Measured from the centre of the part's own bounds against the build's footprint, so it
 * describes where the reader should look rather than how the program was written.
 */
export function bearing(
	part: BuildPart,
	size: VoxelGrid['size'],
	design: BuildGuideDesignSystem = DEFAULT_DESIGN_SYSTEM,
): string | undefined {
	if (!part.min || !part.max) return undefined;

	const near = design.edgeThreshold;
	const far = 1 - near;

	// A one-block-wide build has no inside, so guard the division rather than dividing by 0
	// and calling everything north-west.
	const fx = size.x > 1 ? (part.min[0] + part.max[0]) / 2 / (size.x - 1) : 0.5;
	const fz = size.z > 1 ? (part.min[2] + part.max[2]) / 2 / (size.z - 1) : 0.5;

	// -Z is north and +X is east, matching the coordinate convention the whole IR uses.
	const ns = fz < near ? 'north' : fz > far ? 'south' : '';
	const ew = fx < near ? 'west' : fx > far ? 'east' : '';

	if (ns && ew) return `${ns}-${ew}`;
	return ns || ew || undefined;
}

/* --- thresholds ------------------------------------------------------------------------ */

export function difficultyFor(
	stepCount: number,
	design: BuildGuideDesignSystem = DEFAULT_DESIGN_SYSTEM,
): Difficulty {
	for (const band of design.difficulty) {
		if (stepCount <= band.upTo) return band.label;
	}
	// Only reachable if a caller supplies bands that stop short of Infinity.
	return design.difficulty[design.difficulty.length - 1]?.label ?? 'epic';
}

/** `Layer 7` — the name for a step whose blocks nothing claims. */
export function anonymousStepTitle(layer: number, design: BuildGuideDesignSystem): string {
	return design.anonymousStep.replace('{layer}', String(layer));
}

/* --- text ------------------------------------------------------------------------------ */

function capitalise(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Lower-case a noun so it can follow a bearing — "South windows", not "South Windows".
 *
 * Only the first letter, and only when the word is not already an all-caps or mixed-caps
 * term a user chose deliberately: a custom role label of "LED strip" must not become
 * "lED strip".
 */
function lower(noun: string): string {
	if (noun.length > 1 && noun[1] === noun[1]!.toUpperCase() && noun[1] !== noun[1]!.toLowerCase()) {
		return noun;
	}
	return noun.charAt(0).toLowerCase() + noun.slice(1);
}
