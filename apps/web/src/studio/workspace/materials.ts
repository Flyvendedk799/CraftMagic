import { allBlocks, displayName, type BlockRef } from '@craftmagic/core';
export type MaterialCategory =
  | 'all'
  | 'wood'
  | 'stone'
  | 'colour'
  | 'glass'
  | 'nature'
  | 'detail'
  | 'favourites';
export const MATERIAL_CATEGORIES: { id: MaterialCategory; label: string }[] = [
  { id: 'all', label: 'All blocks' },
  { id: 'wood', label: 'Wood' },
  { id: 'stone', label: 'Stone' },
  { id: 'colour', label: 'Colour' },
  { id: 'glass', label: 'Glass' },
  { id: 'nature', label: 'Nature' },
  { id: 'detail', label: 'Details' },
  { id: 'favourites', label: 'Favourites' },
];
const expressions: Record<
  Exclude<MaterialCategory, 'all' | 'favourites'>,
  RegExp
> = {
  wood: /oak|spruce|birch|jungle|acacia|mangrove|cherry|bamboo|crimson|warped/,
  stone:
    /stone|brick|granite|diorite|andesite|deepslate|tuff|basalt|quartz|prismarine/,
  colour: /wool|concrete|terracotta|carpet/,
  glass: /glass|ice/,
  nature:
    /dirt|grass|sand|gravel|leaves|moss|flower|azalea|cactus|mud|snow|water/,
  detail:
    /door|trapdoor|fence|wall|lantern|torch|chain|barrel|bookshelf|chest|ladder|iron_bars/,
};
export const MATERIALS = allBlocks().map((block) => ({
  id: block.id,
  label: displayName(block.id),
}));
const known = new Set(MATERIALS.map((block) => block.id));
export function readFavourites(raw: string | null): string[] {
  try {
    const value = JSON.parse(raw ?? '[]');
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (v): v is string => typeof v === 'string' && known.has(v),
            ),
          ),
        ].slice(0, 48)
      : [];
  } catch {
    return [];
  }
}
export function findMaterials(
  query: string,
  category: MaterialCategory,
  favourites: readonly string[],
) {
  const words = query
    .toLowerCase()
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return MATERIALS.filter(
    (block) =>
      words.every((word) =>
        `${block.id.replace(/_/g, ' ')} ${block.label}`
          .toLowerCase()
          .includes(word),
      ) &&
      (category === 'all' ||
        (category === 'favourites' && favourites.includes(block.id)) ||
        (category !== 'favourites' && expressions[category].test(block.id))),
  );
}
export function toggleFavourite(
  current: readonly string[],
  id: BlockRef,
): string[] {
  if (!known.has(id)) return [...current];
  return current.includes(id)
    ? current.filter((v) => v !== id)
    : [id, ...current].slice(0, 48);
}
