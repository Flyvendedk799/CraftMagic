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

import { allBlocks, LIMITS } from '@craftmagic/core';

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
- Interiors matter less than silhouette. Spend components on roof shape, depth in the
  facade, and material contrast.
- Use \`details\` sparingly, for accents like a lantern or a chimney cap. It is capped at
  ${LIMITS.maxDetailOps} ops and a single fill may not exceed ${LIMITS.maxDetailFillVolume}
  blocks; anything larger belongs in a component.`;

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
export function repairPrompt(issues: { path: string; code: string; message: string }[]): string {
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
		`Fix every one of these and call \`emit_build_program\` again with the complete corrected`,
		`program. Do not send a partial program or a diff.`,
	].join('\n');
}
