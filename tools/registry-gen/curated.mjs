/**
 * Which blocks CraftMagic is allowed to build with.
 *
 * Expressed as families and suffix patterns rather than a flat id list: the generator
 * expands every combination and then *drops the ones Minecraft does not actually have*,
 * checked against the data generator's report. That is why irregular families need no
 * special-casing here — crimson has stems instead of logs, bamboo has mosaic planks, and
 * the non-existent combinations simply fall out.
 *
 * Keeping the palette curated (rather than all 1196 blocks) matters for generation
 * quality: the model picks from a vocabulary of things that look good in a build, and
 * cannot reach for command blocks, spawners or budding amethyst.
 */

/** Wood-like families. Suffixes that do not exist for a family are dropped automatically. */
const WOOD_FAMILIES = [
	'oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'pale_oak',
	'mangrove', 'cherry', 'bamboo', 'crimson', 'warped',
];

const WOOD_SUFFIXES = [
	'planks', 'log', 'stripped_log', 'wood', 'stripped_wood',
	'stem', 'stripped_stem', 'hyphae', 'stripped_hyphae',
	'stairs', 'slab', 'fence', 'fence_gate', 'door', 'trapdoor', 'mosaic',
	'mosaic_stairs', 'mosaic_slab', 'block', 'leaves',
];

/** The 16 dye colours. */
const DYE_COLORS = [
	'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
	'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
];

const DYE_SUFFIXES = [
	'wool', 'concrete', 'terracotta', 'stained_glass', 'stained_glass_pane', 'glazed_terracotta',
];

/**
 * Stone-like base blocks. Each also gets stairs/slab/wall variants generated where they
 * exist, so `stone_bricks` implies `stone_brick_stairs` etc.
 */
const STONE_BASES = [
	'stone', 'cobblestone', 'mossy_cobblestone', 'smooth_stone',
	'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks',
	'andesite', 'polished_andesite', 'diorite', 'polished_diorite', 'granite', 'polished_granite',
	'deepslate', 'cobbled_deepslate', 'polished_deepslate', 'deepslate_bricks',
	'cracked_deepslate_bricks', 'deepslate_tiles', 'chiseled_deepslate',
	'tuff', 'polished_tuff', 'tuff_bricks', 'calcite', 'dripstone_block',
	'blackstone', 'polished_blackstone', 'polished_blackstone_bricks', 'gilded_blackstone',
	'basalt', 'polished_basalt', 'smooth_basalt',
	'bricks', 'mud_bricks', 'packed_mud',
	'sandstone', 'smooth_sandstone', 'cut_sandstone', 'chiseled_sandstone',
	'red_sandstone', 'smooth_red_sandstone', 'cut_red_sandstone', 'chiseled_red_sandstone',
	'quartz_block', 'smooth_quartz', 'quartz_bricks', 'chiseled_quartz_block', 'quartz_pillar',
	'prismarine', 'prismarine_bricks', 'dark_prismarine',
	'purpur_block', 'purpur_pillar', 'end_stone', 'end_stone_bricks',
	'nether_bricks', 'red_nether_bricks', 'chiseled_nether_bricks', 'cracked_nether_bricks',
	'resin_bricks', 'chiseled_resin_bricks',
];

/** Derived shapes. `stone_bricks` -> `stone_brick_stairs`, so singularise the `bricks` tail. */
function shapeVariants(base) {
	const stem = base.endsWith('bricks') ? base.slice(0, -1) : base;
	return [`${stem}_stairs`, `${stem}_slab`, `${stem}_wall`];
}

/** Blocks that stand alone: decoration, lighting, metal, terrain, foliage. */
const SINGLES = [
	// glass + panes
	'glass', 'glass_pane', 'tinted_glass',
	// metal / mineral blocks
	'iron_block', 'gold_block', 'diamond_block', 'emerald_block', 'lapis_block',
	'redstone_block', 'coal_block', 'netherite_block', 'amethyst_block', 'raw_iron_block',
	'raw_copper_block', 'raw_gold_block',
	// copper, including the weathering stages (great for palettes)
	'copper_block', 'exposed_copper', 'weathered_copper', 'oxidized_copper',
	'cut_copper', 'exposed_cut_copper', 'weathered_cut_copper', 'oxidized_cut_copper',
	'cut_copper_stairs', 'cut_copper_slab', 'chiseled_copper', 'copper_grate', 'copper_bulb',
	// lighting
	'glowstone', 'sea_lantern', 'shroomlight', 'lantern', 'soul_lantern', 'torch',
	'redstone_lamp', 'ochre_froglight', 'verdant_froglight', 'pearlescent_froglight',
	'jack_o_lantern', 'campfire', 'soul_campfire', 'end_rod', 'crying_obsidian',
	// terrain
	'dirt', 'coarse_dirt', 'rooted_dirt', 'grass_block', 'podzol', 'mycelium', 'mud',
	'sand', 'red_sand', 'gravel', 'clay', 'snow_block', 'ice', 'packed_ice', 'blue_ice',
	'obsidian', 'netherrack', 'magma_block', 'soul_sand', 'soul_soil', 'bone_block',
	'moss_block', 'pale_moss_block',
	// foliage
	'azalea', 'flowering_azalea', 'vine', 'hay_block', 'melon', 'pumpkin', 'carved_pumpkin',
	'mangrove_roots', 'muddy_mangrove_roots', 'sculk', 'dried_kelp_block', 'sponge', 'wet_sponge',
	// structural deco
	'bookshelf', 'chiseled_bookshelf', 'crafting_table', 'furnace', 'barrel', 'loom',
	'cartography_table', 'fletching_table', 'smithing_table', 'composter', 'note_block',
	'jukebox', 'iron_bars', 'chain', 'ladder', 'lightning_rod', 'anvil', 'bell',
	'honeycomb_block', 'honey_block', 'slime_block', 'target', 'lodestone', 'scaffolding',
	'brick_stairs', 'brick_slab', 'brick_wall',
	'mud_brick_stairs', 'mud_brick_slab', 'mud_brick_wall',
	'cobblestone_stairs', 'cobblestone_slab', 'cobblestone_wall',
	'polished_blackstone_brick_stairs', 'polished_blackstone_brick_slab',
	'petrified_oak_slab', 'smooth_stone_slab', 'smooth_quartz_stairs', 'smooth_quartz_slab',
	'nether_brick_fence',
];

/** Light level per emitting block, for the viewer and the guide. Not present in blocks.json. */
export const LIGHT_LEVELS = {
	'minecraft:glowstone': 15,
	'minecraft:sea_lantern': 15,
	'minecraft:shroomlight': 15,
	'minecraft:jack_o_lantern': 15,
	'minecraft:lantern': 15,
	'minecraft:campfire': 15,
	'minecraft:redstone_lamp': 15,
	'minecraft:ochre_froglight': 15,
	'minecraft:verdant_froglight': 15,
	'minecraft:pearlescent_froglight': 15,
	'minecraft:end_rod': 14,
	'minecraft:torch': 14,
	'minecraft:soul_lantern': 10,
	'minecraft:soul_campfire': 10,
	'minecraft:crying_obsidian': 10,
	'minecraft:magma_block': 3,
	'minecraft:copper_bulb': 15,
};

/** Category is used by the palette-swap tool and the bill of materials grouping. */
export function categoryOf(id) {
	const n = id.replace('minecraft:', '');
	if (n.endsWith('_stairs')) return 'stairs';
	if (n.endsWith('_slab')) return 'slab';
	if (n.endsWith('_wall')) return 'wall';
	if (n.endsWith('_fence') || n.endsWith('_fence_gate')) return 'fence';
	if (n.endsWith('_door')) return 'door';
	if (n.endsWith('_trapdoor')) return 'trapdoor';
	if (n.endsWith('_pane') || n === 'glass' || n === 'tinted_glass' || n.endsWith('_stained_glass')) return 'glass';
	if (n.endsWith('_leaves')) return 'foliage';
	if (n.endsWith('_log') || n.endsWith('_stem') || n.endsWith('_wood') || n.endsWith('_hyphae')) return 'log';
	if (n.endsWith('_planks')) return 'planks';
	if (n.endsWith('_wool')) return 'wool';
	if (n.endsWith('_concrete')) return 'concrete';
	if (n.endsWith('terracotta')) return 'terracotta';
	if (id in LIGHT_LEVELS) return 'light';
	return 'block';
}

/**
 * Family groups interchangeable blocks so the palette-swap tool can re-skin a build.
 *
 * Order matters: the compound families must be tested *before* the dye colours, or
 * `red_nether_bricks` and `red_sandstone` get filed under the dye "red" and become
 * swappable with red wool.
 */
export function familyOf(id) {
	const n = id.replace('minecraft:', '');

	for (const wood of WOOD_FAMILIES) {
		if (n === wood || n.startsWith(`${wood}_`) || n.startsWith(`stripped_${wood}_`)) return wood;
	}

	if (n.includes('deepslate')) return 'deepslate';
	if (n.includes('blackstone')) return 'blackstone';
	if (n.includes('red_sandstone')) return 'red_sandstone';
	if (n.includes('sandstone')) return 'sandstone';
	if (n.includes('quartz')) return 'quartz';
	if (n.includes('prismarine')) return 'prismarine';
	if (n.includes('nether_brick')) return 'nether_brick';
	if (n.includes('copper')) return 'copper';
	if (n.includes('stone_brick')) return 'stone_brick';
	if (n.includes('tuff')) return 'tuff';
	if (n.includes('purpur')) return 'purpur';
	if (n.includes('end_stone')) return 'end_stone';
	if (n.includes('mud_brick')) return 'mud_brick';
	if (n === 'bricks' || n.startsWith('brick_')) return 'brick';

	for (const color of DYE_COLORS) {
		if (n.startsWith(`${color}_`)) return color;
	}

	return 'misc';
}

/** Every candidate id, before existence filtering. */
export function candidateIds() {
	const ids = new Set();
	const add = (name) => ids.add(`minecraft:${name}`);

	for (const family of WOOD_FAMILIES) {
		for (const suffix of WOOD_SUFFIXES) {
			add(`${family}_${suffix}`);
			// Stripped variants invert the order: stripped_oak_log, not oak_stripped_log.
			if (suffix.startsWith('stripped_')) add(`stripped_${family}_${suffix.slice('stripped_'.length)}`);
		}
	}

	for (const color of DYE_COLORS) {
		for (const suffix of DYE_SUFFIXES) add(`${color}_${suffix}`);
	}

	for (const base of STONE_BASES) {
		add(base);
		for (const variant of shapeVariants(base)) add(variant);
	}

	for (const single of SINGLES) add(single);

	return [...ids];
}
