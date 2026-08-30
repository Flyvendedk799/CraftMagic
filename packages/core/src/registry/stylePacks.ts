/**
 * Style packs: whole-build re-skins that respect what each block *is*.
 *
 * The palette is semantic — components name roles, roles name blocks — so restyling a build
 * is a palette rewrite and nothing else: the program's components, params and scale are
 * untouched, which is why a restyled build keeps its sliders, its refine, and its share URL.
 *
 * The subtlety is shape. `roof_primary` is usually a *stairs* block (the expander leans on
 * stair states to draw slopes), while the same role on a flat-roofed build is a full block.
 * A pack that mapped every role to one block would flatten every pitched roof it touched. So
 * a role's style is written per shape category — full block, stairs, slab, door, log — and
 * the block actually in the palette decides which one applies. A shape the pack does not
 * name keeps the original block, which degrades to "partially restyled" rather than to a
 * broken roof.
 *
 * Roles a pack does not mention keep the program's own choice. `decoration` and `window` are
 * left alone in most packs deliberately: what counts as decoration is the build's own idea,
 * and swapping glass for glass is noise.
 */

import type { BlockRef, BuildProgram, WeightedBlockRef } from '../ir/types.js';
import { getBlock, parseBlockRef } from './registry.js';

/** How one palette role is restyled, keyed by the shape of the block it replaces. */
export interface RoleStyle {
	/** The replacement for a full block — planks, bricks, glass, terracotta, anything solid. */
	block: BlockRef | WeightedBlockRef[];
	stairs?: BlockRef;
	slab?: BlockRef;
	door?: BlockRef;
	log?: BlockRef;
}

export interface StylePack {
	id: string;
	label: string;
	/** One phrase, shown under the label in the picker. */
	description: string;
	roles: Record<string, RoleStyle>;
}

/**
 * Rewrite a program's palette in a pack's materials.
 *
 * Pure and cheap — no expansion, no validation. The result is a new program object sharing
 * everything but the palette, so callers can expand it exactly as they would the original.
 */
export function applyStylePack(program: BuildProgram, pack: StylePack): BuildProgram {
	const palette: BuildProgram['palette'] = {};
	for (const [role, value] of Object.entries(program.palette)) {
		const style = pack.roles[role];
		palette[role] = style ? restyle(value, style) : value;
	}
	return { ...program, palette };
}

export function stylePackById(id: string | null | undefined): StylePack | null {
	if (!id) return null;
	return STYLE_PACKS.find((pack) => pack.id === id) ?? null;
}

function restyle(value: BlockRef | WeightedBlockRef[], style: RoleStyle): BlockRef | WeightedBlockRef[] {
	// A weighted list exists for texture — stone bricks with the odd cracked one. The pack's
	// own `block` entry carries its texture (it may itself be weighted), so the whole list is
	// replaced rather than each entry mapped onto the same target.
	if (Array.isArray(value)) return copyBlocks(style.block);

	const category = categoryOf(value);
	if (category === 'stairs') return style.stairs ?? value;
	if (category === 'slab') return style.slab ?? value;
	if (category === 'door') return style.door ?? value;
	if (category === 'log') return style.log ?? value;
	return copyBlocks(style.block);
}

function categoryOf(ref: BlockRef): string | null {
	try {
		return getBlock(parseBlockRef(ref).id)?.category ?? null;
	} catch {
		// An unparseable ref is the expander's problem to report, not the restyler's to fix.
		return null;
	}
}

/** Weighted lists are shared module constants below; hand out copies so nobody mutates them. */
function copyBlocks(value: BlockRef | WeightedBlockRef[]): BlockRef | WeightedBlockRef[] {
	return Array.isArray(value) ? value.map((entry) => ({ ...entry })) : value;
}

/** Shorthand: a weighted list from [block, weight] pairs. */
function mix(...entries: [BlockRef, number][]): WeightedBlockRef[] {
	return entries.map(([block, weight]) => ({ block, weight }));
}

export const STYLE_PACKS: StylePack[] = [
	{
		id: 'nordic',
		label: 'Nordic',
		description: 'Spruce and weathered stone under a slate roof',
		roles: {
			wall_primary: {
				block: mix(['minecraft:spruce_planks', 6], ['minecraft:stripped_spruce_log', 1]),
				stairs: 'minecraft:spruce_stairs',
				slab: 'minecraft:spruce_slab',
				door: 'minecraft:spruce_door',
				log: 'minecraft:stripped_spruce_log',
			},
			wall_secondary: {
				block: mix(
					['minecraft:stone_bricks', 5],
					['minecraft:cracked_stone_bricks', 1],
					['minecraft:mossy_stone_bricks', 1],
				),
				stairs: 'minecraft:stone_brick_stairs',
				slab: 'minecraft:stone_brick_slab',
			},
			wall_accent: { block: 'minecraft:stripped_spruce_wood', log: 'minecraft:stripped_spruce_wood' },
			foundation: {
				block: mix(['minecraft:cobblestone', 4], ['minecraft:mossy_cobblestone', 1]),
				stairs: 'minecraft:cobblestone_stairs',
				slab: 'minecraft:cobblestone_slab',
			},
			floor: { block: 'minecraft:spruce_planks', stairs: 'minecraft:spruce_stairs', slab: 'minecraft:spruce_slab' },
			frame: { block: 'minecraft:stripped_spruce_log', log: 'minecraft:stripped_spruce_log' },
			roof_primary: {
				block: 'minecraft:deepslate_bricks',
				stairs: 'minecraft:deepslate_brick_stairs',
				slab: 'minecraft:deepslate_brick_slab',
			},
			roof_trim: { block: 'minecraft:spruce_planks', stairs: 'minecraft:spruce_stairs', slab: 'minecraft:spruce_slab', log: 'minecraft:spruce_log' },
			door: { block: 'minecraft:spruce_door', door: 'minecraft:spruce_door' },
			trim: { block: 'minecraft:dark_oak_planks', stairs: 'minecraft:dark_oak_stairs', slab: 'minecraft:dark_oak_slab', log: 'minecraft:dark_oak_log' },
			path: { block: 'minecraft:cobblestone', stairs: 'minecraft:cobblestone_stairs', slab: 'minecraft:cobblestone_slab' },
			light: { block: 'minecraft:lantern' },
		},
	},
	{
		id: 'desert',
		label: 'Desert',
		description: 'Sandstone, cut and carved, roofed in red',
		roles: {
			wall_primary: {
				block: 'minecraft:smooth_sandstone',
				stairs: 'minecraft:smooth_sandstone_stairs',
				slab: 'minecraft:smooth_sandstone_slab',
				door: 'minecraft:acacia_door',
			},
			wall_secondary: { block: 'minecraft:sandstone', stairs: 'minecraft:sandstone_stairs', slab: 'minecraft:sandstone_slab' },
			wall_accent: { block: 'minecraft:chiseled_sandstone' },
			foundation: { block: 'minecraft:sandstone', stairs: 'minecraft:sandstone_stairs', slab: 'minecraft:sandstone_slab' },
			floor: { block: 'minecraft:smooth_sandstone', stairs: 'minecraft:smooth_sandstone_stairs', slab: 'minecraft:smooth_sandstone_slab' },
			frame: { block: 'minecraft:cut_sandstone', log: 'minecraft:stripped_acacia_log' },
			roof_primary: {
				block: 'minecraft:smooth_red_sandstone',
				stairs: 'minecraft:smooth_red_sandstone_stairs',
				slab: 'minecraft:smooth_red_sandstone_slab',
			},
			roof_trim: { block: 'minecraft:red_sandstone', stairs: 'minecraft:red_sandstone_stairs', slab: 'minecraft:red_sandstone_slab' },
			door: { block: 'minecraft:acacia_door', door: 'minecraft:acacia_door' },
			trim: { block: 'minecraft:cut_sandstone', slab: 'minecraft:cut_sandstone_slab' },
			path: { block: 'minecraft:smooth_sandstone', slab: 'minecraft:smooth_sandstone_slab' },
			light: { block: 'minecraft:glowstone' },
		},
	},
	{
		id: 'gothic',
		label: 'Gothic',
		description: 'Blackstone and deepslate, lit by soul fire',
		roles: {
			wall_primary: {
				block: mix(
					['minecraft:polished_blackstone_bricks', 6],
					['minecraft:blackstone', 1],
				),
				stairs: 'minecraft:polished_blackstone_brick_stairs',
				slab: 'minecraft:polished_blackstone_brick_slab',
			},
			wall_secondary: { block: 'minecraft:blackstone', stairs: 'minecraft:blackstone_stairs', slab: 'minecraft:blackstone_slab' },
			wall_accent: { block: 'minecraft:gilded_blackstone' },
			foundation: { block: 'minecraft:blackstone', stairs: 'minecraft:blackstone_stairs', slab: 'minecraft:blackstone_slab' },
			floor: {
				block: 'minecraft:polished_blackstone',
				stairs: 'minecraft:polished_blackstone_stairs',
				slab: 'minecraft:polished_blackstone_slab',
			},
			frame: { block: 'minecraft:polished_blackstone', log: 'minecraft:stripped_dark_oak_log' },
			roof_primary: {
				block: 'minecraft:deepslate_bricks',
				stairs: 'minecraft:deepslate_brick_stairs',
				slab: 'minecraft:deepslate_brick_slab',
			},
			roof_trim: {
				block: 'minecraft:polished_blackstone',
				stairs: 'minecraft:polished_blackstone_stairs',
				slab: 'minecraft:polished_blackstone_slab',
			},
			door: { block: 'minecraft:dark_oak_door', door: 'minecraft:dark_oak_door' },
			trim: { block: 'minecraft:gilded_blackstone' },
			path: { block: 'minecraft:blackstone', slab: 'minecraft:blackstone_slab' },
			light: { block: 'minecraft:soul_lantern' },
		},
	},
	{
		id: 'blossom',
		label: 'Blossom',
		description: 'White plaster and cherry wood',
		roles: {
			wall_primary: { block: 'minecraft:white_terracotta', stairs: 'minecraft:smooth_quartz_stairs', slab: 'minecraft:smooth_quartz_slab' },
			wall_secondary: { block: 'minecraft:cherry_planks', stairs: 'minecraft:cherry_stairs', slab: 'minecraft:cherry_slab' },
			wall_accent: { block: 'minecraft:stripped_cherry_wood' },
			foundation: { block: 'minecraft:stone_bricks', stairs: 'minecraft:stone_brick_stairs', slab: 'minecraft:stone_brick_slab' },
			floor: { block: 'minecraft:cherry_planks', stairs: 'minecraft:cherry_stairs', slab: 'minecraft:cherry_slab' },
			frame: { block: 'minecraft:stripped_cherry_log', log: 'minecraft:stripped_cherry_log' },
			roof_primary: { block: 'minecraft:cherry_planks', stairs: 'minecraft:cherry_stairs', slab: 'minecraft:cherry_slab' },
			roof_trim: { block: 'minecraft:stripped_cherry_wood', stairs: 'minecraft:cherry_stairs', slab: 'minecraft:cherry_slab', log: 'minecraft:cherry_log' },
			door: { block: 'minecraft:cherry_door', door: 'minecraft:cherry_door' },
			trim: { block: 'minecraft:stripped_cherry_wood' },
			path: { block: 'minecraft:gravel' },
			light: { block: 'minecraft:lantern' },
			foliage: { block: 'minecraft:cherry_leaves' },
		},
	},
	{
		id: 'ocean',
		label: 'Ocean',
		description: 'Prismarine from the deep, glowing sea lanterns',
		roles: {
			wall_primary: {
				block: 'minecraft:prismarine_bricks',
				stairs: 'minecraft:prismarine_brick_stairs',
				slab: 'minecraft:prismarine_brick_slab',
			},
			wall_secondary: { block: 'minecraft:prismarine', stairs: 'minecraft:prismarine_stairs', slab: 'minecraft:prismarine_slab' },
			wall_accent: { block: 'minecraft:dark_prismarine' },
			foundation: { block: 'minecraft:dark_prismarine', stairs: 'minecraft:dark_prismarine_stairs', slab: 'minecraft:dark_prismarine_slab' },
			floor: { block: 'minecraft:dark_prismarine', stairs: 'minecraft:dark_prismarine_stairs', slab: 'minecraft:dark_prismarine_slab' },
			frame: { block: 'minecraft:dark_prismarine' },
			roof_primary: {
				block: 'minecraft:dark_prismarine',
				stairs: 'minecraft:dark_prismarine_stairs',
				slab: 'minecraft:dark_prismarine_slab',
			},
			roof_trim: {
				block: 'minecraft:prismarine_bricks',
				stairs: 'minecraft:prismarine_brick_stairs',
				slab: 'minecraft:prismarine_brick_slab',
			},
			door: { block: 'minecraft:warped_door', door: 'minecraft:warped_door' },
			trim: { block: 'minecraft:prismarine_bricks' },
			path: { block: 'minecraft:prismarine', slab: 'minecraft:prismarine_slab' },
			light: { block: 'minecraft:sea_lantern' },
		},
	},
];
