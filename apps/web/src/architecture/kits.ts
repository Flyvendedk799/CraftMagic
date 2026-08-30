/**
 * Material kits.
 *
 * The level editor engine this is ported from loads a *level kit* — a manifest of prefabs and
 * materials that a map is authored against, so a map is a list of references rather than a
 * list of meshes (`src/customMaps/levelKitRegistry.js` in flyvendedk799/firstpgame). The same
 * separation is the reason CraftMagic's IR has palette *roles* instead of block ids: a plan
 * names `wall_primary`, and what that is made of is a decision it does not have to carry.
 *
 * So a kit here is a role table. Swapping the kit re-skins a whole building — every storey,
 * every wall, both roofs — without touching a single item on the plan, which is the thing
 * that makes trying a material actually cheap rather than a re-draw.
 *
 * Roles are the IR's recommended vocabulary plus `air`, which is not a material at all: the
 * compiler carves stairwells and floor voids by painting air over structure that has already
 * been drawn, and painting needs a role like anything else.
 */

import type { BlockRef } from '@craftmagic/core';

/** Every role a compiled plan can reference. Kits must define all of them. */
export interface KitRoles {
  foundation: BlockRef;
  wall_primary: BlockRef;
  wall_secondary: BlockRef;
  frame: BlockRef;
  floor: BlockRef;
  ceiling: BlockRef;
  roof_primary: BlockRef;
  roof_trim: BlockRef;
  window: BlockRef;
  door: BlockRef;
  stair: BlockRef;
  trim: BlockRef;
  light: BlockRef;
}

export interface Kit {
  id: string;
  name: string;
  description: string;
  roles: KitRoles;
}

/**
 * Roles a room or a partition may be overridden to, in the inspector.
 *
 * Deliberately short. The point of an override is "this one wall is different" — an accent
 * wall, a stone core in a timber building — and offering the full thirteen turns a two-click
 * decision into a menu no one reads.
 */
export const OVERRIDE_ROLES: readonly (keyof KitRoles)[] = [
  'wall_primary',
  'wall_secondary',
  'frame',
  'trim',
  'floor',
  'foundation',
];

export const KITS: readonly Kit[] = [
  {
    id: 'oak-cottage',
    name: 'Oak cottage',
    description: 'Timber and plaster. The default domestic kit.',
    roles: {
      foundation: 'minecraft:cobblestone',
      wall_primary: 'minecraft:oak_planks',
      wall_secondary: 'minecraft:white_terracotta',
      frame: 'minecraft:oak_log',
      floor: 'minecraft:spruce_planks',
      ceiling: 'minecraft:oak_planks',
      roof_primary: 'minecraft:bricks',
      roof_trim: 'minecraft:oak_log',
      window: 'minecraft:glass',
      door: 'minecraft:oak_door',
      stair: 'minecraft:oak_stairs',
      trim: 'minecraft:stripped_oak_log',
      light: 'minecraft:lantern',
    },
  },
  {
    id: 'stone-keep',
    name: 'Stone keep',
    description: 'Load-bearing masonry, deep reveals, cold floors.',
    roles: {
      foundation: 'minecraft:cobblestone',
      wall_primary: 'minecraft:stone_bricks',
      wall_secondary: 'minecraft:andesite',
      frame: 'minecraft:polished_andesite',
      floor: 'minecraft:smooth_stone',
      ceiling: 'minecraft:stone_bricks',
      roof_primary: 'minecraft:deepslate_bricks',
      roof_trim: 'minecraft:polished_blackstone_bricks',
      window: 'minecraft:glass',
      door: 'minecraft:spruce_door',
      stair: 'minecraft:stone_brick_stairs',
      trim: 'minecraft:polished_blackstone_bricks',
      light: 'minecraft:lantern',
    },
  },
  {
    id: 'modern-concrete',
    name: 'Modern concrete',
    description: 'Flat slabs, big glazing, no ornament.',
    roles: {
      foundation: 'minecraft:gray_concrete',
      wall_primary: 'minecraft:white_concrete',
      wall_secondary: 'minecraft:light_gray_concrete',
      frame: 'minecraft:polished_andesite',
      floor: 'minecraft:smooth_quartz',
      ceiling: 'minecraft:white_concrete',
      roof_primary: 'minecraft:light_gray_concrete',
      roof_trim: 'minecraft:gray_concrete',
      window: 'minecraft:glass',
      door: 'minecraft:warped_door',
      stair: 'minecraft:smooth_quartz_stairs',
      trim: 'minecraft:quartz_block',
      light: 'minecraft:sea_lantern',
    },
  },
  {
    id: 'industrial',
    name: 'Industrial',
    description: 'Steel frame, brick infill, exposed services.',
    roles: {
      foundation: 'minecraft:stone_bricks',
      wall_primary: 'minecraft:bricks',
      wall_secondary: 'minecraft:deepslate_tiles',
      frame: 'minecraft:iron_block',
      floor: 'minecraft:polished_andesite',
      ceiling: 'minecraft:deepslate_tiles',
      roof_primary: 'minecraft:deepslate_tiles',
      roof_trim: 'minecraft:iron_block',
      window: 'minecraft:glass',
      door: 'minecraft:dark_oak_door',
      stair: 'minecraft:polished_andesite_stairs',
      trim: 'minecraft:iron_bars',
      light: 'minecraft:glowstone',
    },
  },
] as const;

export const DEFAULT_KIT_ID = KITS[0]!.id;

const BY_ID = new Map(KITS.map((kit) => [kit.id, kit]));

export function getKit(id: string): Kit {
  return BY_ID.get(id) ?? KITS[0]!;
}

/**
 * The palette a compiled program carries.
 *
 * `air` rides along because carving is painting: the compiler draws a floor void or a
 * stairwell by covering already-drawn structure with air, and the expander resolves that
 * through the palette like any other role.
 */
export function paletteFor(kitId: string): Record<string, BlockRef> {
  return { ...getKit(kitId).roles, air: 'minecraft:air' };
}
