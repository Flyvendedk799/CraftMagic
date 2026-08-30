/**
 * The system prompt for build generation.
 *
 * Two things make this prompt do real work rather than just describe the format:
 *
 *  - **The anchoring rules.** A model left to itself writes literal coordinates, which look
 *    fine once and then fall apart the moment the build is resized. Most of the guidance
 *    below is about expressing intent (`max-1`, `center`, `$floors*4`) instead of position.
 *  - **What NOT to specify.** Stair facing, door hinges and roof corners are computed by the
 *    expander from geometry. Telling the model to leave them alone removes the single
 *    largest source of wrong-looking output.
 *
 * The block digest is generated from the registry rather than written out, so it can never
 * list a block the expander would reject.
 */

import {
	allBlocks,
	describeBudget,
	LIMITS,
	SIZE_OPTIONS,
	type SizeChoice,
} from '@craftmagic/core';

/**
 * A compact view of the palette: families and shapes, not 499 ids.
 *
 * The full id list would cost thousands of tokens every call and still not guarantee
 * validity — the validator does that. This gives the model enough to choose materials
 * confidently, and the repair round catches anything it invents.
 */
export function blockDigest(): string {
	const blocks = allBlocks();

	const byCategory = new Map<string, Set<string>>();
	for (const block of blocks) {
		if (!byCategory.has(block.category)) byCategory.set(block.category, new Set());
		byCategory.get(block.category)!.add(block.family);
	}

	// Materials with the widest shape coverage are the ones worth building with.
	const shapeCategories = ['planks', 'log', 'stairs', 'slab', 'wall', 'fence', 'door', 'trapdoor'];
	const woodFamilies = [...(byCategory.get('planks') ?? [])].sort();
	const colours = [...(byCategory.get('wool') ?? [])].sort();
	// "misc" is the registry's catch-all, not a family anyone can swap between, and the dye
	// colours are listed separately — neither belongs in the stone list.
	const stoneFamilies = [...(byCategory.get('stairs') ?? [])]
		.filter((f) => f !== 'misc' && !woodFamilies.includes(f) && !colours.includes(f))
		.sort();

	const named = (category: string, limit = 24) =>
		blocks
			.filter((b) => b.category === category)
			.map((b) => b.id.replace('minecraft:', ''))
			.slice(0, limit)
			.join(', ');

	return [
		`Wood families (each has ${shapeCategories.join('/')} where the game provides them): ${woodFamilies.join(', ')}.`,
		`Stone-like families with stairs/slabs/walls: ${stoneFamilies.join(', ')}.`,
		`Dye colours (wool, concrete, terracotta, stained_glass, stained_glass_pane): ${colours.join(', ')}.`,
		`Glass: glass, tinted_glass, glass_pane, and <colour>_stained_glass / <colour>_stained_glass_pane for every dye colour.`,
		`Light sources: ${named('light', 14)}.`,
		`Foliage: ${named('foliage', 10)}.`,
		'Common standalone blocks: stone, cobblestone, stone_bricks, mossy_stone_bricks, smooth_stone, bricks, sandstone, quartz_block, deepslate, calcite, tuff, blackstone, prismarine, iron_block, gold_block, copper_block, bookshelf, hay_block, lantern, chain, iron_bars, ladder, dirt, grass_block, sand, gravel, snow_block, ice.',
		'Blocks must be written with the minecraft: namespace, e.g. "minecraft:stone_bricks".',
	].join('\n');
}

const CONVENTIONS = `## Coordinates

Right-handed and Y-up, matching Minecraft: +X is east, +Y is up, +Z is south.
The origin (0,0,0) is the structure's minimum corner and ground level is y=0.
North is -Z, south is +Z, east is +X, west is -X.

A coordinate is an integer OR an arithmetic expression built from:

  min            the low edge of that axis (0)
  max            the high edge (size-1)
  center         the middle
  N%             a percentage
  $name          a value from params

combined freely with + - * / and parentheses (decimals are fine), with as many terms as
you need:

  "max-1"                  one in from the far edge
  "center+2"               just past the middle
  "50%"                    halfway along the axis
  "$floors*4+1"            scales with a param
  "$height*30%"            30% of $height
  "$height-2+$radius"      params combined with each other

A percentage on its own is a share of the axis; used after * it is a plain fraction — so
"50%" is the axis midpoint, while "$height*50%" is half the height.

Sizes are lengths, not indices: a size of ["max", 1, "max"] spans the whole footprint,
one block tall.`;

const EXPANSION_RULES = `## How components are drawn

Components are drawn **in order, like paint**. A later component overwrites what an earlier
one put down. Painting "minecraft:air" therefore *carves* — that is how you cut a doorway
through a wall you already built.

Build in this order, because each stage cuts into the last:
foundation → walls → floors → openings (windows, doors, arches) → roof → details.

**Do not specify block orientation.** The expander computes it from geometry:
- roof slopes get the right stair facing, and hip-roof corners the right outer-corner shape
- staircases face their direction of travel
- doors get their upper/lower half and hinge
- rotating a group rewrites its blocks' facings to match
Writing explicit states like [facing=north] in the palette is allowed but almost never what
you want, and getting it wrong is very visible.

**Emit only the fields each component defines.** Every component type has a fixed, closed
set of properties. Do not add commentary fields such as "note" or "type_note", and do not
mix fields from one component type into another — an unrecognised property makes the whole
component invalid and it will be dropped.`;

const ANCHORING_RULES = `## Making the build survive a resize

This is the most important rule here. Every program you write can be re-expanded at a
different size, or with different param values, and it has to still look deliberate. That
only works if coordinates express *intent* rather than position.

  Wall on the far edge          pos: ["max", 1, "min"]      not  pos: [20, 1, 0]
  Something centred             pos: ["center", 1, "max"]   not  pos: [10, 1, 12]
  A band across a face          size: ["max", 3, 1]         not  size: [21, 3, 1]
  Storey height                 "$floors*5"                 not  5
  A row of pillars              a group with a repeat       not  eight copies

Use literal numbers only for genuinely fixed things — a wall's thickness, a window's size,
the number of blocks a roof overhangs.

Declare a param when a build has an obvious dial: floors, height, radius, how many arches.
Give it a sensible min/max, and make sure the structure's \`size\` is large enough for the
param's **maximum** value, or the build will be clipped at the top when someone turns it up.`;

const PALETTE_RULES = `## Palette

Components never name a block. They name a **role**, and the palette maps roles to blocks,
so a whole structure can be re-skinned by swapping the palette alone.

Prefer these role names: wall_primary, wall_secondary, wall_accent, foundation, floor,
frame, roof_primary, roof_trim, window, door, trim, path, foliage, light, decoration.

A role may map to a single block, or to a weighted list for texture variation:

  "wall_primary": [
    { "block": "minecraft:stone_bricks", "weight": 5 },
    { "block": "minecraft:mossy_stone_bricks", "weight": 1 }
  ]

Weighted picks are deterministic, so the same program always produces the same build.`;

const QUALITY_RULES = `## Making it look good

- Give walls a base course and a top plate in a contrasting material; flat single-material
  walls read as unfinished.
- Corner posts (a 1x1 column of log or a contrasting block) make a rectangular building look
  built rather than extruded.
- Roofs want an overhang of 1-2 blocks. Eaves should sit level with the top of the walls,
  not float above them — remember the roof's own base level is its eave course.
- Windows in a row, evenly spaced, using window_grid rather than individually placed boxes.
- Silhouette first: spend components on roof shape, depth in the facade, and material
  contrast before anything else.
- But a building people can enter must not be a solid mass or an empty shell. Use hollow_box
  with floor: true for each storey, put a stairs_run between storeys, and give rooms a floor
  material distinct from the walls. One or two interior light blocks per storey (a lantern
  role in the palette) stop the inside reading as a cave through the windows.
- Use \`details\` sparingly, for accents like a lantern or a chimney cap. It is capped at
  ${LIMITS.maxDetailOps} ops and a single fill may not exceed ${LIMITS.maxDetailFillVolume}
  blocks; anything larger belongs in a component.`;

/**
 * The size the user asked for, phrased as an ambition rather than as a cap.
 *
 * The distinction is the entire point. Told "make it 300 blocks", a model designs *down* to
 * 300 blocks: it drops the corner posts, the base course and the window mullions, because
 * there is no room for them at that size, and what comes back is a flat little box. So the
 * brief asks for the structure at whatever size it needs to read properly and promises to
 * shrink it afterwards — which the expander can do faithfully, and which leaves the detail in
 * the program for anyone who drags the size slider back up.
 *
 * Blocks rather than dimensions, because that is the number a builder can picture: "a cottage
 * or a small tower" and "300–800 blocks" describe the same thing to somebody who builds, where
 * "32 blocks across" describes a tower and a barn equally badly.
 */
export function sizeBrief(choice: SizeChoice | undefined): string | null {
	const option = SIZE_OPTIONS.find((entry) => entry.id === choice);
	if (!option?.blocks) return null;

	const budget = option.blocks;
	const room = budget.max === null ? `${budget.min * 2} or more` : `about ${budget.max}`;

	return [
		`Target size: ${describeBudget(budget)} placed — ${option.example}.`,
		``,
		`Design it at whatever size it needs to look right, with every bit of the detail you`,
		`would give it at that size — corner posts, a base course, window frames, roof trim.`,
		`Do not simplify the design to hit the number: a smaller build is one that has fewer`,
		`blocks, not one that has fewer ideas. If the structure only reads properly at ${room}`,
		`blocks, write it that way and it will be scaled down to fit; the detail stays in the`,
		`program either way. Overshooting by two or three times is fine. Overshooting by ten is`,
		`not — past that, shrinking loses the detail you spent components on.`,
	].join('\n');
}

/**
 * What to do with a picture.
 *
 * The instruction a picture needs is not "describe this" but "build this", and the difference
 * is the whole feature: asked to reproduce a photograph, a model reaches for a flat wall of
 * coloured blocks, which is both a bad structure and something the app already does exactly
 * — pixel by pixel, for free, without asking anyone. What it is being asked for here is the
 * thing a builder would make *of* the subject: a statue of the person, a model of the ship,
 * the building itself as a building.
 */
export function pictureBrief(): string {
	return [
		`The picture is the brief. Build what it shows as a Minecraft structure.`,
		``,
		`- Build the **subject**, not the photograph. A person becomes a statue, a car becomes a`,
		`  model of that car, a house becomes that house. Never a flat wall of coloured blocks.`,
		`- Take the silhouette seriously — proportions, stance, and the outline read from a`,
		`  distance long before any detail does.`,
		`- Take the colours from the picture and find the closest blocks for them, using the`,
		`  palette roles as usual so the whole thing can be re-skinned afterwards.`,
		`- Anything painted flat white in the picture was masked out deliberately. It is not`,
		`  part of the subject and must not appear in the build.`,
		`- Say what you built in \`meta.name\` and \`meta.description\`.`,
	].join('\n');
}

const LIMITS_TEXT = `## Limits

- size at most ${LIMITS.maxSizeX} x ${LIMITS.maxSizeY} x ${LIMITS.maxSizeZ}
- at most ${LIMITS.maxComponents} components and ${LIMITS.maxBlocks} placed blocks
- pick a size that fits the subject snugly; empty space around a build is wasted volume`;

const EXAMPLE = `## Worked example

A cottage, showing the shape of a good program — note that almost nothing is a literal
coordinate, and that the roof's base level equals the wall height so the eaves land on the
wall head:

{
  "version": 1,
  "meta": { "name": "Oak Cottage", "style": "medieval" },
  "size": { "x": 21, "y": 19, "z": 13 },
  "params": { "floors": { "value": 1, "min": 1, "max": 2, "label": "Floors" } },
  "palette": {
    "foundation": "minecraft:stone_bricks",
    "wall_primary": "minecraft:oak_planks",
    "frame": "minecraft:oak_log",
    "roof_primary": "minecraft:oak_stairs",
    "roof_trim": "minecraft:oak_planks",
    "window": "minecraft:glass",
    "door": "minecraft:oak_door"
  },
  "components": [
    { "type": "box", "pos": ["min","min","min"], "size": ["max",1,"max"],
      "fill": { "type": "solid", "role": "foundation" } },
    { "type": "hollow_box", "pos": ["min",1,"min"], "size": ["max","$floors*5","max"],
      "wallThickness": 1, "floor": true,
      "fill": { "type": "solid", "role": "wall_primary" } },
    { "type": "group", "children": [
      { "type": "box", "pos": ["min",1,"min"], "size": [1,"$floors*5",1],
        "fill": { "type": "solid", "role": "frame" } },
      { "type": "box", "pos": ["max",1,"min"], "size": [1,"$floors*5",1],
        "fill": { "type": "solid", "role": "frame" } },
      { "type": "box", "pos": ["min",1,"max"], "size": [1,"$floors*5",1],
        "fill": { "type": "solid", "role": "frame" } },
      { "type": "box", "pos": ["max",1,"max"], "size": [1,"$floors*5",1],
        "fill": { "type": "solid", "role": "frame" } }
    ] },
    { "type": "window_grid", "face": "south",
      "region": { "pos": ["min",3,"max"], "size": ["max",2,1] },
      "rows": 1, "cols": 2, "windowSize": [2,2], "margin": 2, "role": "window" },
    { "type": "door", "face": "south", "at": ["center",2,"max"], "role": "door" },
    { "type": "gable_roof", "pos": ["min","$floors*5","min"], "size": ["max",8,"max"],
      "ridgeAxis": "x", "overhang": 1, "style": "stairs",
      "roofRole": "roof_primary", "trimRole": "roof_trim" }
  ]
}

A second, rounder shape — a watchtower — showing cylinder, sphere and a weighted noise fill
for weathered stonework. The dome is centred at "$height+1" with radius 7, and the volume's
height covers the param's *maximum*, so turning the dial up never clips the dome:

{
  "version": 1,
  "meta": { "name": "Stone Tower" },
  "size": { "x": 17, "y": 30, "z": 17 },
  "params": { "height": { "value": 20, "min": 10, "max": 21, "label": "Tower height" } },
  "palette": {
    "foundation": "minecraft:cobblestone",
    "wall_primary": "minecraft:stone_bricks",
    "wall_accent": "minecraft:mossy_stone_bricks",
    "roof_primary": "minecraft:dark_oak_planks",
    "light": "minecraft:lantern"
  },
  "components": [
    { "type": "cylinder", "base": ["center","min","center"], "radius": 7, "height": 1,
      "axis": "y", "fill": { "type": "solid", "role": "foundation" } },
    { "type": "cylinder", "base": ["center",1,"center"], "radius": 6, "height": "$height",
      "axis": "y", "hollow": true,
      "fill": { "type": "noise", "seed": 7, "roles": [
        { "role": "wall_primary", "weight": 4 }, { "role": "wall_accent", "weight": 1 } ] } },
    { "type": "sphere", "center": ["center","$height+1","center"], "radius": 7,
      "hollow": true, "cap": "top_half", "fill": { "type": "solid", "role": "roof_primary" } }
  ],
  "details": [ { "op": "set", "at": [8, 4, 8], "block": "minecraft:lantern" } ]
}`;

export function systemPrompt(): string {
	return [
		`You design Minecraft structures for CraftMagic.`,
		``,
		`You do not place blocks one at a time. You write a **build program**: a compact,`,
		`parametric description that a deterministic expander turns into voxels. Think like an`,
		`architect describing a building, not like someone filling in a grid.`,
		``,
		`Always answer by calling the \`emit_build_program\` tool. Never reply with prose.`,
		``,
		CONVENTIONS,
		``,
		EXPANSION_RULES,
		``,
		ANCHORING_RULES,
		``,
		PALETTE_RULES,
		``,
		`## Available blocks`,
		``,
		blockDigest(),
		``,
		QUALITY_RULES,
		``,
		LIMITS_TEXT,
		``,
		EXAMPLE,
	].join('\n');
}

/** Repair instructions, sent back as a tool_result when the expander rejects a program. */
export function repairPrompt(
	issues: { path: string; code: string; message: string }[],
	offerPatch = false,
): string {
	const listed = issues
		.slice(0, 30)
		.map((issue) => `- ${issue.path} [${issue.code}]: ${issue.message}`)
		.join('\n');
	const truncated = issues.length > 30 ? `\n(and ${issues.length - 30} more)` : '';

	return [
		`The program could not be built. Problems found:`,
		``,
		listed + truncated,
		``,
		...(offerPatch
			? [
					`Fix every one of these — either with \`edit_build_program\` ops against the current`,
					`program, or by calling \`emit_build_program\` with the complete corrected program.`,
				]
			: [
					`Fix every one of these and call \`emit_build_program\` again with the complete corrected`,
					`program. Do not send a partial program or a diff.`,
				]),
	].join('\n');
}

/**
 * Ask for a change to an existing build rather than a new one.
 *
 * The whole program is sent back, not a description of it. It is a few KB — cheap next to a
 * cached system prompt — and it is the only way the model can keep the parts nobody asked to
 * change: the same palette roles, the same anchoring expressions, the same component order.
 * Describing a build in prose and asking for it again produces a *different* building that
 * happens to match the description, which is not what "make the roof steeper" means.
 *
 * The emphasis on returning everything is deliberate. Asked to modify a structure, a model
 * will happily reply with only the components it touched, which expands to a house with
 * nothing but a roof.
 */
export function refinePrompt(program: unknown, instruction: string, offerPatch = false): string {
	// The scale is the user's, not the model's: it is what the size control did to the build
	// after it was written. Sending it would invite the model to reason about coordinates in a
	// space it does not write in, and to drop or invent a value that the caller then has to
	// second-guess. It is put back on whatever comes out.
	const { scale: _scale, ...unscaled } = (program ?? {}) as Record<string, unknown>;

	// With the patch tool on offer the contract flips: the preferred answer is a short list of
	// ops addressed to component ids, and re-emitting everything is the fallback for a
	// sweeping change. Preservation stops being an instruction the model has to obey and
	// becomes a property of the mechanism — ops cannot touch what they do not name.
	const answering = offerPatch
		? [
				`How to answer:`,
				`- For a targeted change, call \`edit_build_program\` with a short list of ops.`,
				`  Address components by the \`id\` field shown above. Ops available:`,
				`  replaceComponent { target, component } · addComponent { component, before? } ·`,
				`  removeComponent { target } · setPalette { role, block } (null removes) ·`,
				`  setParam { name, param } (null removes) · setMeta { name?, description?, style? }.`,
				`  Everything your ops do not touch is preserved exactly, by construction.`,
				`- Only if the change genuinely reshapes most of the build, call`,
				`  \`emit_build_program\` with the COMPLETE updated program instead — everything you`,
				`  omit there disappears from the build.`,
				`- A replaced or added component follows all the usual rules (roles, anchoring,`,
				`  resize-safe expressions). Keep ids you were given; give new components fresh ids.`,
			]
		: [
				`Rules for this edit:`,
				`- Call \`emit_build_program\` with the COMPLETE updated program, not a diff and not`,
				`  only the parts you changed. Everything you omit disappears from the build.`,
			];

	return [
		`Here is an existing build program:`,
		``,
		'```json',
		JSON.stringify(unscaled, null, 1),
		'```',
		``,
		`Change it as follows:`,
		``,
		instruction,
		``,
		...answering,
		`- Keep anything the instruction does not mention exactly as it is — the same palette`,
		`  roles, the same coordinate expressions, the same component order.`,
		`- Keep \`meta.name\` unless the change makes it wrong.`,
		`- Preserve the resize-safe anchoring already in the program. If a wall is anchored`,
		`  with \`max-1\`, it stays \`max-1\`; do not replace expressions with fixed numbers.`,
	].join('\n');
}
