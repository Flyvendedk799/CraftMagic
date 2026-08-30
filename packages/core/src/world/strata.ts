/**
 * The ground palette: what a painted column is made of.
 *
 * Five profiles rather than a block picker, because the useful unit here is not a block but a
 * *ground*. Painting `minecraft:grass_block` over a hillside gives you a hillside of grass
 * with nothing under it; painting `grass` gives you grass over dirt over stone, which is what
 * anyone asking for grass meant. The same reason Minecraft's own worldgen has surface rules.
 *
 * The blocks are all real registry entries — a profile naming a block the registry does not
 * know would materialise into a palette slot the mesher cannot colour and the schem writer
 * cannot export, and it would do it silently, one region at a time.
 */

import { colorOf } from '../registry/registry.js';
import type { SurfaceProfile, WorldSettings } from './types.js';

/**
 * The strata a new world starts with.
 *
 * Index 0 is grass on purpose: `createTerrain` fills `strata` with zeroes and a new world
 * should come up as a field, not as whatever happened to be first.
 *
 * `path` uses gravel rather than `minecraft:dirt_path`, which the texture-derived registry
 * does not carry — and matching `stylePacks.ts`, whose `path` role made the same call.
 */
export const DEFAULT_STRATA: readonly SurfaceProfile[] = [
	{
		id: 'grass',
		label: 'Grass',
		surface: 'minecraft:grass_block',
		subsurface: 'minecraft:dirt',
		subsurfaceDepth: 3,
		filler: 'minecraft:stone',
	},
	{
		id: 'sand',
		label: 'Sand',
		surface: 'minecraft:sand',
		subsurface: 'minecraft:sand',
		subsurfaceDepth: 4,
		filler: 'minecraft:sandstone',
	},
	{
		id: 'stone',
		label: 'Stone',
		surface: 'minecraft:stone',
		subsurface: 'minecraft:stone',
		subsurfaceDepth: 4,
		filler: 'minecraft:deepslate',
	},
	{
		id: 'snow',
		label: 'Snow',
		surface: 'minecraft:snow_block',
		subsurface: 'minecraft:dirt',
		subsurfaceDepth: 3,
		filler: 'minecraft:stone',
	},
	{
		id: 'path',
		label: 'Path',
		surface: 'minecraft:gravel',
		subsurface: 'minecraft:coarse_dirt',
		subsurfaceDepth: 2,
		filler: 'minecraft:stone',
	},
];

/**
 * What fills a column between the ground and sea level.
 *
 * Not in `blocks.gen.json`, and that is not a mistake on either side: the registry is derived
 * from block *textures* and water is a fluid, so it has no entry to derive. The game knows the
 * id perfectly well, `canonical` passes unknown ids through unchanged, and a schematic
 * containing it imports fine. What it costs is a grey swatch in the mesher rather than blue,
 * which is a cosmetic debt worth naming here rather than a reason to fill the sea with wool.
 */
export const WORLD_WATER = 'minecraft:water';

/** The fallback every lookup lands on, so nothing downstream has to handle `undefined`. */
export const FALLBACK_PROFILE: SurfaceProfile = DEFAULT_STRATA[0]!;

/**
 * The profile a stratum byte names.
 *
 * Total by construction. A stratum index that has fallen off the end — a world saved with six
 * strata and reopened after one was deleted — resolves to the first profile rather than
 * throwing, because refusing to open the world over one stale byte is the worse failure and
 * the region still has to materialise into *something*.
 */
export function profileAt(settings: WorldSettings, index: number): SurfaceProfile {
	return settings.strata[index] ?? settings.strata[0] ?? FALLBACK_PROFILE;
}

/** Position of a profile in the settings, or -1. The inverse of `profileAt`, for the painter. */
export function strataIndexOf(settings: WorldSettings, id: string): number {
	return settings.strata.findIndex((profile) => profile.id === id);
}

export function findProfile(settings: WorldSettings, id: string): SurfaceProfile | undefined {
	return settings.strata.find((profile) => profile.id === id);
}

/**
 * The swatch a profile draws as.
 *
 * Derived from the surface block unless the profile overrides it, so adding a stratum costs
 * one line and never a colour decision — and so the map's palette cannot drift away from what
 * the world actually materialises into.
 */
export function profileColor(profile: SurfaceProfile): [number, number, number] {
	return profile.color ?? colorOf(profile.surface);
}

/** Every block a stratum can put in a grid, for palette pre-sizing and bills of materials. */
export function profileBlocks(profile: SurfaceProfile): string[] {
	return [profile.surface, profile.subsurface, profile.filler];
}
