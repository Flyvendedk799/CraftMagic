/**
 * The blocks a picture may be built out of.
 *
 * Chosen from the registry rather than listed by hand, so the set can never name a block the
 * expander would reject, and it grows with the game. Three rules do almost all the filtering:
 *
 *  - **Opaque.** Glass and leaves let the sky through, and a mural you can see through is not
 *    a mural.
 *  - **Not directional.** A block with a `facing` or `axis` state — a log, a furnace, a piston
 *    — is placed by the expander with one particular face toward the viewer, and which face
 *    that is depends on rotation. Their registry colour is an average of all six.
 *  - **Full cubes.** Slabs, stairs, fences and panes do not fill their cell, so a wall built
 *    of them has holes in it.
 *
 * What the rules cannot catch is a full opaque cube whose *sides* look nothing like its
 * average: a grass block is green on top and dirt everywhere else, a crafting table is four
 * different textures. Those are named below, because getting one of them means a patch of
 * mural that is visibly the wrong colour.
 */

import { allBlocks, type RegistryBlock } from '../registry/registry.js';

/** A named set of materials to build a picture from. */
export type MuralPalette = 'full' | 'concrete' | 'wool' | 'terracotta';

export interface MuralPaletteOption {
  id: MuralPalette;
  label: string;
  hint: string;
}

export const MURAL_PALETTES: readonly MuralPaletteOption[] = [
  { id: 'full', label: 'Full range', hint: 'Every solid block — the most faithful' },
  { id: 'concrete', label: 'Concrete', hint: '16 flat, vivid colours' },
  { id: 'wool', label: 'Wool', hint: '16 soft colours, cheap to gather' },
  { id: 'terracotta', label: 'Terracotta', hint: 'Muted earth tones' },
];

/**
 * Full opaque cubes whose faces disagree with each other.
 *
 * Every one of these passes the mechanical filters and still reads as the wrong colour in a
 * wall, because the registry stores one average colour per block and these do not have one:
 * the side you see is not the side the average came from.
 */
const MISMATCHED_FACES = new Set([
  'minecraft:grass_block',
  'minecraft:mycelium',
  'minecraft:podzol',
  'minecraft:crafting_table',
  'minecraft:cartography_table',
  'minecraft:fletching_table',
  'minecraft:smithing_table',
  'minecraft:jukebox',
  'minecraft:note_block',
  'minecraft:bookshelf',
  'minecraft:lodestone',
  'minecraft:melon',
  'minecraft:pumpkin',
  'minecraft:target',
  'minecraft:azalea',
  'minecraft:flowering_azalea',
  'minecraft:dried_kelp_block',
  'minecraft:sponge',
  'minecraft:wet_sponge',
]);

/** Categories whose members are full, solid, single-texture cubes. */
const SOLID_CATEGORIES = new Set(['block', 'planks', 'wool', 'concrete', 'terracotta']);

function paintable(block: RegistryBlock): boolean {
  if (!SOLID_CATEGORIES.has(block.category)) return false;
  if (block.transparent === true) return false;
  // Directional blocks show a different face depending on how they were placed, and a mural
  // has no way to say which one it meant.
  if (block.rotation !== 'none') return false;
  // A glowing wall is a lovely thing and a terrible photograph: light sources wash out every
  // colour around them, including their own.
  if ((block.light ?? 0) > 0) return false;
  return !MISMATCHED_FACES.has(block.id);
}

/**
 * The blocks in a palette, as ids.
 *
 * Sorted, so the same picture always maps to the same blocks: two blocks can share a colour,
 * and which of them wins has to be decided by something stable rather than by registry order.
 */
export function muralBlocks(palette: MuralPalette = 'full'): string[] {
  const wanted = (block: RegistryBlock): boolean => {
    if (!paintable(block)) return false;
    if (palette === 'full') return true;
    return block.category === palette;
  };

  const ids = allBlocks().filter(wanted).map((block) => block.id);
  // A named material set that somehow matched nothing would silently produce an empty mural,
  // so it falls back to the full range rather than to nothing at all.
  return (ids.length > 0 ? ids : allBlocks().filter(paintable).map((b) => b.id)).sort();
}
