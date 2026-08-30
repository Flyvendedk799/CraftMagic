/**
 * The world document: a server hub or map, described rather than stored.
 *
 * A build is a `VoxelGrid` because a build fits in one. A world does not. A 1024x1024 map
 * 160 blocks tall is 168 million cells — 320 MB of `Uint16Array` and 40,960 mesh chunks — so
 * the moment a world is a grid it is a world nobody can open. This document is the answer:
 * it stores the *description*, and `region.ts` materialises an ordinary `VoxelGrid` out of it
 * one region at a time. Everything downstream — the mesher, the schem writer, the mod — keeps
 * working unchanged, because what it is handed is still just a grid.
 *
 * Three layers, in increasing cost and decreasing coverage:
 *
 * - **Terrain** is two flat arrays over the columns: a height and a stratum each. That is
 *   three bytes per column, so a 1024² map is 3 MB — small enough to hold, send and undo.
 * - **Overlay** is the sparse 16³ patch for everything a heightfield cannot say: caves,
 *   overhangs, cliff faces, tunnels. Only the chunks somebody actually carved exist.
 * - **Placements** are library builds referenced by id, so a hub with forty copies of the
 *   same shop is forty rows, not forty buildings.
 *
 * Coordinates match the IR and Minecraft: +x east, +y up, +z south. Column indices are
 * row-major (`z * size.x + x`); the voxel grids this materialises into are YZX. The two are
 * not the same order and transposing one is invisible — it produces a world that looks
 * plausible and is mirrored — so the conversion happens in exactly one place, `columnIndex`.
 */

import type { BlockRef } from '../ir/types.js';

export const WORLD_VERSION = 1;

/**
 * How a painted column becomes blocks — Minecraft's own surface rules, essentially.
 *
 * A column stores one byte saying *what kind of ground* it is, not a stack of blocks, which
 * is what keeps the terrain arrays three bytes wide. The profile is what turns that byte back
 * into grass over dirt over stone at materialise time.
 */
export interface SurfaceProfile {
	/**
	 * Stable across edits and saves. The terrain array stores *indices*, so a reorder or an
	 * import has to match profiles up by something that is not their position.
	 */
	id: string;
	label: string;
	/** The top block of the column. */
	surface: BlockRef;
	subsurface: BlockRef;
	/** Blocks of subsurface directly under the surface block. */
	subsurfaceDepth: number;
	/** Everything below the subsurface, down to `minY`. */
	filler: BlockRef;
	/** Swatch for the painter's UI. Defaults to `colorOf(surface)` when absent. */
	color?: [number, number, number];
}

export interface WorldSettings {
	/**
	 * Extent in columns. Per-project, not a constant: a duel arena and a survival hub are
	 * three orders of magnitude apart in area and neither should have to pay for the other.
	 */
	size: { x: number; z: number };
	/** Floor of the world, in Minecraft y. Default -64, matching the game since 1.18. */
	minY: number;
	/** Ceiling. `maxY` is itself a buildable block, so the span is `maxY - minY + 1`. */
	maxY: number;
	seaLevel: number;
	/** Edge of the square a single materialise covers. Default 128. */
	regionSize: number;
	strata: SurfaceProfile[];
}

/**
 * The heightfield: one height and one stratum per column.
 *
 * `height[i]` is the y of the TOPMOST SOLID block of column i. An empty column — a hole
 * straight through to the void — is `minY - 1`, which is the only value that makes "fill from
 * minY up to height" produce nothing without a second flag to carry alongside.
 *
 * Int16 rather than Uint8 or Uint16 because Minecraft y runs -64..320. An unsigned height
 * cannot express the floor of the world, and a byte cannot express its ceiling; either one
 * turns the Leveler into a toy that can only flatten ground it happens to agree with.
 */
export interface Terrain {
	height: Int16Array;
	/** Index into `WorldSettings.strata`. Row-major, same indexing as `height`. */
	strata: Uint8Array;
}

/**
 * One 16³ chunk of the sparse overlay, encoded with the same varint-RLE + base64 codec as
 * `Prefab.data`.
 *
 * Cells are TRI-STATE and this is the crux of the whole design:
 *
 *   0    no override — the terrain column decides this cell
 *   1    forced air — this is the carve, and it is why caves work
 *   >=2  an explicit block from this chunk's palette
 *
 * Without the middle state a heightfield can only ever describe a lumpy field. "Nothing said
 * here" and "air here" have to be different answers, or a tunnel bored through a hill fills
 * itself back in the next time the region is materialised.
 *
 * `palette[0]` is always `''` (pass-through) and `palette[1]` is always `minecraft:air`, so
 * the two structural states read as themselves in the JSON instead of being magic numbers.
 */
export interface OverlayChunk {
	palette: BlockRef[];
	data: string;
}

/** Keyed by `${cx},${cy},${cz}` in world-chunk coordinates — see `overlayChunkKey`. */
export type Overlay = Record<string, OverlayChunk>;

/**
 * What a placement's `y` is measured against.
 *
 * `surface` is the one that makes a hub editable: raise the ground under a house and the
 * house rises with it, instead of ending up buried or floating. `fixed` is the escape hatch
 * for anything deliberately in the air, and `buried` sinks a build so its top is flush with
 * the ground — dungeons, foundations, half-sunken ruins.
 */
export type PlacementAnchor = 'surface' | 'fixed' | 'buried';

export interface WorldPlacement {
	id: string;
	/** Library row id. The voxels are never copied into the world document. */
	buildId: string;
	x: number;
	z: number;
	/** Only meaningful when `anchor === 'fixed'`; kept regardless, so toggling is lossless. */
	y: number;
	anchor: PlacementAnchor;
	/** Quarter-turns clockwise. `x`/`z` stay the min corner of the *turned* footprint. */
	turns: 0 | 1 | 2 | 3;
	/**
	 * Last known name and UNTURNED footprint, denormalised.
	 *
	 * A world restored from storage has to draw its plan before the library has answered —
	 * often before the network has even been asked. Without these the map opens as a field of
	 * unnamed one-block dots that jump to their real size a second later, which reads as a
	 * bug rather than as loading. Stale by nature; refreshed whenever the library does answer.
	 */
	name: string;
	w: number;
	h: number;
	d: number;
}

export interface WorldDoc {
	version: typeof WORLD_VERSION;
	id: string;
	name: string;
	settings: WorldSettings;
	terrain: Terrain;
	overlay: Overlay;
	placements: WorldPlacement[];
	updatedAt: string;
}

/**
 * Bounds for anything arriving from storage.
 *
 * Separate from `LIMITS` in the IR: those cap one *build*, and a world is deliberately far
 * bigger than a build. What the two share is `maxSizeY` and `maxBlocks`, which bound a
 * materialised region — because a materialised region is a build.
 */
export const WORLD_LIMITS = {
	minSize: 16,
	/** 2048² is 4.2M columns, 12 MB of terrain. Past that it stops being a document. */
	maxSize: 2048,
	/** The game's own build range. */
	floorY: -64,
	ceilingY: 320,
	minRegionSize: 16,
	/** A region materialises into a grid, and `LIMITS.maxSizeX` caps that at 256. */
	maxRegionSize: 256,
	maxStrata: 64,
	maxPlacements: 4_000,
	/** Generous — a carved cave system is a lot of chunks — but not unbounded. */
	maxOverlayChunks: 100_000,
} as const;

/** Edge of an overlay chunk. 16, to match Minecraft's own sections and the mesher's chunking. */
export const OVERLAY_CHUNK = 16;

/** Pass-through, in slot 0 of every overlay palette. Not a block: the absence of an opinion. */
export const OVERLAY_PASS = '';

/** Slot 0 of an overlay chunk's cells: this chunk says nothing about this cell. */
export const OVERLAY_NONE = 0;

/** Slot 1: forced air. The carve. */
export const OVERLAY_AIR = 1;
