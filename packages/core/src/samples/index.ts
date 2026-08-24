/**
 * Hand-written build programs.
 *
 * These serve three jobs: expander fixtures, demo content for the editor, and — most
 * usefully — worked examples of the anchoring style the generation prompt asks for. Note
 * that almost nothing here is a literal coordinate. Walls anchor to `min`/`max`, the door
 * sits at `center`, and storey height is driven by a `$floors` param, which is precisely
 * what lets these survive a resize.
 */

import type { BuildProgram } from '../ir/types.js';

/** A small timber cottage: foundation, walls, windows, a door and a gabled roof. */
export const cottage: BuildProgram = {
	version: 1,
	meta: { name: 'Oak Cottage', description: 'A small timber cottage with a gabled roof', style: 'medieval' },
	// Height accommodates the *maximum* storey count, so raising $floors never clips the
	// roof off the top of the build volume.
	size: { x: 21, y: 19, z: 13 },
	params: {
		floors: { value: 1, min: 1, max: 2, label: 'Floors' },
	},
	// Contrast is deliberate. Oak stairs and oak planks share a texture in Minecraft, so a
	// cottage roofed in its own wall material reads as one flat mass — exactly the mistake
	// the generation prompt warns against. Dark oak above tan walls above a grey plinth
	// gives the silhouette three legible bands.
	palette: {
		foundation: 'minecraft:stone_bricks',
		wall_primary: 'minecraft:oak_planks',
		frame: 'minecraft:stripped_dark_oak_log',
		roof_primary: 'minecraft:dark_oak_stairs',
		roof_trim: 'minecraft:dark_oak_planks',
		window: 'minecraft:glass',
		door: 'minecraft:oak_door',
		floor: 'minecraft:spruce_planks',
	},
	// The building is inset one block from the volume on every side, so the roof's overhang
	// has somewhere to go. Anchoring the walls flush to min/max instead would push the eaves
	// outside the build volume, where they are silently dropped — an overhang that projects
	// over nothing but empty air.
	components: [
		// Foundation covers the whole footprint, so the inset reads as a plinth.
		{ type: 'box', pos: ['min', 'min', 'min'], size: ['max', 1, 'max'], fill: { type: 'solid', role: 'foundation' } },

		// Walls. Height follows $floors, so adding a storey raises everything above it.
		{
			type: 'hollow_box',
			pos: ['min+1', 1, 'min+1'],
			size: ['max-2', '$floors*5', 'max-2'],
			wallThickness: 1,
			floor: true,
			ceiling: false,
			fill: { type: 'solid', role: 'wall_primary' },
		},

		// Corner posts, drawn after the walls so they read as framing on top of the planks.
		{
			type: 'group',
			children: [
				{ type: 'box', pos: ['min+1', 1, 'min+1'], size: [1, '$floors*5', 1], fill: { type: 'solid', role: 'frame' } },
				{ type: 'box', pos: ['max-1', 1, 'min+1'], size: [1, '$floors*5', 1], fill: { type: 'solid', role: 'frame' } },
				{ type: 'box', pos: ['min+1', 1, 'max-1'], size: [1, '$floors*5', 1], fill: { type: 'solid', role: 'frame' } },
				{ type: 'box', pos: ['max-1', 1, 'max-1'], size: [1, '$floors*5', 1], fill: { type: 'solid', role: 'frame' } },
			],
		},

		// Windows on the two long walls.
		{
			type: 'window_grid',
			face: 'south',
			region: { pos: ['min+1', 3, 'max-1'], size: ['max-2', 2, 1] },
			rows: 1,
			// Two windows on this wall, because the door takes the centre.
			cols: 2,
			windowSize: [2, 2],
			margin: 2,
			role: 'window',
		},
		{
			type: 'window_grid',
			face: 'north',
			region: { pos: ['min+1', 3, 'min+1'], size: ['max-2', 2, 1] },
			rows: 1,
			cols: 3,
			windowSize: [2, 2],
			margin: 2,
			role: 'window',
		},

		// Door centred on the south wall.
		{ type: 'door', face: 'south', at: ['center', 2, 'max-1'], width: 1, height: 2, role: 'door' },

		// Gabled roof. Its base level is the wall head, so the eaves sit on the wall rather
		// than floating above it, and the overhang lands on the plinth.
		{
			type: 'gable_roof',
			pos: ['min+1', '$floors*5', 'min+1'],
			size: ['max-2', 8, 'max-2'],
			ridgeAxis: 'x',
			overhang: 1,
			style: 'stairs',
			roofRole: 'roof_primary',
			trimRole: 'roof_trim',
		},
	],
};

/** A round stone tower with a domed cap — exercises cylinder and sphere. */
export const tower: BuildProgram = {
	version: 1,
	meta: { name: 'Stone Tower', description: 'A round watchtower with a domed roof' },
	// The dome is centred at $height+1 with radius 7, so the tallest it can reach is
	// $height+8. Capping height at 21 keeps that at y=29, exactly the top of the volume —
	// at 26 the dome was silently clipped into a crown.
	size: { x: 17, y: 30, z: 17 },
	params: {
		height: { value: 20, min: 10, max: 21, label: 'Tower height' },
	},
	palette: {
		foundation: 'minecraft:cobblestone',
		wall_primary: 'minecraft:stone_bricks',
		wall_accent: 'minecraft:mossy_stone_bricks',
		roof_primary: 'minecraft:dark_oak_planks',
		window: 'minecraft:glass',
		light: 'minecraft:lantern',
	},
	components: [
		{
			type: 'cylinder',
			base: ['center', 'min', 'center'],
			radius: 7,
			height: 1,
			axis: 'y',
			fill: { type: 'solid', role: 'foundation' },
		},
		{
			type: 'cylinder',
			base: ['center', 1, 'center'],
			radius: 6,
			height: '$height',
			axis: 'y',
			hollow: true,
			// Weathered stonework: deterministic, so the same tower always looks the same.
			fill: {
				type: 'noise',
				seed: 7,
				roles: [
					{ role: 'wall_primary', weight: 4 },
					{ role: 'wall_accent', weight: 1 },
				],
			},
		},
		{
			type: 'sphere',
			center: ['center', '$height+1', 'center'],
			radius: 7,
			hollow: true,
			cap: 'top_half',
			fill: { type: 'solid', role: 'roof_primary' },
		},
	],
	details: [
		{ op: 'set', at: [8, 4, 8], block: 'minecraft:lantern' },
	],
};

/** An open pavilion: repeated pillars under a hip roof. Exercises group + repeat. */
export const pavilion: BuildProgram = {
	version: 1,
	meta: { name: 'Garden Pavilion', description: 'An open pavilion with repeated pillars' },
	size: { x: 19, y: 17, z: 19 },
	palette: {
		foundation: 'minecraft:polished_andesite',
		path: 'minecraft:smooth_stone',
		frame: 'minecraft:stripped_birch_log',
		roof_primary: 'minecraft:spruce_stairs',
		light: 'minecraft:lantern',
	},
	components: [
		{
			type: 'box',
			pos: ['min', 'min', 'min'],
			size: ['max', 1, 'max'],
			fill: { type: 'checker', a: 'foundation', b: 'path', plane: 'xz' },
		},
		// One pillar, repeated across the front row, then that whole row repeated back.
		{
			type: 'group',
			transform: [
				{ op: 'repeat', count: 4, step: [5, 0, 0] },
				{ op: 'repeat', count: 4, step: [0, 0, 5] },
			],
			children: [
				{ type: 'box', pos: [2, 1, 2], size: [1, 6, 1], fill: { type: 'solid', role: 'frame' } },
			],
		},
		// Inset by one so the eaves project onto the paving instead of off the edge of the
		// build volume, where they would be dropped.
		{
			type: 'hip_roof',
			pos: ['min+1', 6, 'min+1'],
			size: ['max-2', 10, 'max-2'],
			overhang: 1,
			style: 'stairs',
			roofRole: 'roof_primary',
		},
	],
};

export const samples: Record<string, BuildProgram> = { cottage, tower, pavilion };
