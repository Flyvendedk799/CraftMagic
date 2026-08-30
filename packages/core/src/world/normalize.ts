/**
 * Reading a world that came from somewhere else.
 *
 * Same contract as the layouter's `normalizePlan`, and for the same reason: a world document
 * arrives from autosave, from a database row written by an older deploy, from another tab, and
 * from a file somebody mailed a friend. Anything unrecognised degrades to a default. Nothing
 * throws. A single bad placement must cost that placement, not the map — and a version this
 * build has never heard of must still open, because the alternative is a user with a file and
 * no way back into their work.
 *
 * Settings are resolved first, before anything else is read, because every other layer is
 * bounded against them. A document claiming a 40,000-block map cannot then smuggle in column
 * indices that the materialiser would have to defend itself against one region at a time.
 */

import type { BlockRef } from '../ir/types.js';
import { canonical } from '../registry/registry.js';
import {
	decodeOverlayChunk,
	decodeTerrain,
	encodeOverlayChunk,
	encodeTerrain,
	normalizeOverlayChunk,
	type EncodedTerrain,
} from './codec.js';
import {
	overlayChunkBox,
	overlayChunkKey,
	overlayCellIndex,
	parseOverlayChunkKey,
} from './overlay.js';
import { DEFAULT_STRATA } from './strata.js';
import { createTerrain, reindexTerrain } from './terrain.js';
import {
	WORLD_LIMITS,
	WORLD_VERSION,
	type Overlay,
	type PlacementAnchor,
	type SurfaceProfile,
	type Terrain,
	type WorldDoc,
	type WorldPlacement,
	type WorldSettings,
} from './types.js';

/** The persisted shape: identical to `WorldDoc` except the terrain, which JSON cannot hold. */
export interface WorldDocJSON extends Omit<WorldDoc, 'terrain'> {
	terrain: EncodedTerrain;
}

let idCounter = 0;

/**
 * A readable, collision-proof id — the layouter's `planId`, kept to the same shape so a
 * serialized world reads like a serialized plan does.
 */
export function worldId(prefix: string): string {
	idCounter = (idCounter + 1) % 1_000_000;
	return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const n = Math.round(Number(value));
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
}

function text(value: unknown, fallback: string, limit = 60): string {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : fallback;
}

/** Canonicalise defensively — junk must become a block ref, not a throw. */
function blockRef(value: unknown, fallback: BlockRef): BlockRef {
	if (typeof value !== 'string' || !value.trim()) return fallback;
	try {
		return canonical(value.trim());
	} catch {
		return fallback;
	}
}

function normalizeProfile(raw: unknown, index: number): SurfaceProfile {
	const profile = (raw ?? {}) as Partial<SurfaceProfile>;
	const fallback = DEFAULT_STRATA[index % DEFAULT_STRATA.length]!;
	const surface = blockRef(profile.surface, fallback.surface);

	const color = Array.isArray(profile.color) && profile.color.length === 3
		? (profile.color.map((c) => clampInt(c, 0, 255, 0)) as [number, number, number])
		: undefined;

	return {
		id: text(profile.id, fallback.id, 40),
		label: text(profile.label, fallback.label, 40),
		surface,
		subsurface: blockRef(profile.subsurface, fallback.subsurface),
		// Capped at 64 rather than at the world height: a subsurface deeper than the column is
		// just filler with extra steps, and an unbounded depth is an inner loop with no ceiling.
		subsurfaceDepth: clampInt(profile.subsurfaceDepth, 0, 64, fallback.subsurfaceDepth),
		filler: blockRef(profile.filler, fallback.filler),
		// Absent stays absent: no colour means "take the surface block's", which keeps following
		// the block if it is later changed. Baking one in here would freeze that.
		...(color ? { color } : {}),
	};
}

export function normalizeSettings(raw: unknown): WorldSettings {
	const settings = (raw ?? {}) as Partial<WorldSettings>;

	const minY = clampInt(settings.minY, WORLD_LIMITS.floorY, WORLD_LIMITS.ceilingY - 1, -64);
	const maxY = clampInt(settings.maxY, minY + 1, WORLD_LIMITS.ceilingY, Math.max(minY + 1, 192));

	const strata = (Array.isArray(settings.strata) ? settings.strata : [])
		.slice(0, WORLD_LIMITS.maxStrata)
		.map((profile, index) => normalizeProfile(profile, index));

	return {
		size: {
			x: clampInt(settings.size?.x, WORLD_LIMITS.minSize, WORLD_LIMITS.maxSize, 512),
			z: clampInt(settings.size?.z, WORLD_LIMITS.minSize, WORLD_LIMITS.maxSize, 512),
		},
		minY,
		maxY,
		seaLevel: clampInt(settings.seaLevel, minY, maxY, Math.min(maxY, Math.max(minY, 62))),
		regionSize: clampInt(
			settings.regionSize,
			WORLD_LIMITS.minRegionSize,
			WORLD_LIMITS.maxRegionSize,
			128,
		),
		// An empty strata list is not a world with no ground; it is a world nothing can be
		// painted with. The defaults come back rather than leaving every column unresolvable.
		strata: strata.length > 0 ? strata : DEFAULT_STRATA.map((profile) => ({ ...profile })),
	};
}

const ANCHORS: PlacementAnchor[] = ['surface', 'fixed', 'buried'];

/**
 * Coerce one placement.
 *
 * Position is clamped into the map rather than dropped. A placement is a reference to somebody's
 * saved building, and the failure mode that matters is a hub that quietly loses a shop — moving
 * one back inside the fence is recoverable by dragging it, losing it is not.
 */
export function normalizePlacement(raw: unknown, settings: WorldSettings): WorldPlacement | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const item = raw as Partial<WorldPlacement>;
	if (typeof item.buildId !== 'string' || !item.buildId) return null;

	return {
		id: text(item.id, worldId('place'), 60),
		buildId: item.buildId.slice(0, 120),
		x: clampInt(item.x, 0, settings.size.x - 1, 0),
		z: clampInt(item.z, 0, settings.size.z - 1, 0),
		y: clampInt(item.y, settings.minY, settings.maxY, settings.seaLevel),
		anchor: ANCHORS.includes(item.anchor as PlacementAnchor)
			? (item.anchor as PlacementAnchor)
			: 'surface',
		turns: clampInt(item.turns, 0, 3, 0) as 0 | 1 | 2 | 3,
		name: text(item.name, 'Build', 60),
		// The denormalised footprint is a hint, so it is bounded by the build engine's own caps
		// rather than by the world: it describes a build, and a build cannot be bigger than that.
		w: clampInt(item.w, 1, 256, 1),
		h: clampInt(item.h, 1, 320, 1),
		d: clampInt(item.d, 1, 256, 1),
	};
}

/**
 * Coerce the overlay.
 *
 * Chunks entirely outside the world are dropped: they cost bytes and intersection tests in
 * every materialise, and no region will ever reach them. Chunks that straddle an edge are kept
 * whole — clipping happens at materialise time, where the region bounds are already known.
 */
export function normalizeOverlay(raw: unknown, settings: WorldSettings): Overlay {
	if (typeof raw !== 'object' || raw === null) return {};
	const out: Overlay = {};
	let kept = 0;

	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (kept >= WORLD_LIMITS.maxOverlayChunks) break;
		const at = parseOverlayChunkKey(key);
		if (!at) continue;
		const box = overlayChunkBox(at.cx, at.cy, at.cz);
		if (
			box.maxX < 0 || box.minX >= settings.size.x ||
			box.maxZ < 0 || box.minZ >= settings.size.z ||
			box.maxY < settings.minY || box.minY > settings.maxY
		) {
			continue;
		}
		const chunk = normalizeOverlayChunk(value);
		if (!chunk) continue;
		out[overlayChunkKey(at.cx, at.cy, at.cz)] = chunk;
		kept++;
	}

	return out;
}

/** Coerce a whole world. The one entry point for anything that did not come from this module. */
export function normalizeWorld(raw: unknown): WorldDoc {
	const doc = (raw ?? {}) as Partial<WorldDoc>;
	const settings = normalizeSettings(doc.settings);

	const placements = (Array.isArray(doc.placements) ? doc.placements : [])
		.slice(0, WORLD_LIMITS.maxPlacements)
		.map((placement) => normalizePlacement(placement, settings))
		.filter((placement): placement is WorldPlacement => placement !== null);

	return {
		version: WORLD_VERSION,
		id: text(doc.id, worldId('world')),
		name: text(doc.name, 'Untitled world'),
		settings,
		terrain: clampTerrain(decodeTerrain(doc.terrain, settings), settings),
		overlay: normalizeOverlay(doc.overlay, settings),
		placements,
		updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date().toISOString(),
	};
}

/**
 * Pull every column inside the world's own y range and strata list.
 *
 * A height above `maxY` would materialise a column the region's grid has no room for, and a
 * stratum past the end of the list would resolve to the fallback on every single materialise —
 * a cost paid forever for a byte that could be fixed once, here.
 */
function clampTerrain(terrain: Terrain, settings: WorldSettings): Terrain {
	const floor = settings.minY - 1;
	for (let i = 0; i < terrain.height.length; i++) {
		const height = terrain.height[i]!;
		if (height < floor) terrain.height[i] = floor;
		else if (height > settings.maxY) terrain.height[i] = settings.maxY;
		if (terrain.strata[i]! >= settings.strata.length) terrain.strata[i] = 0;
	}
	return terrain;
}

/** A new world: flat ground at sea level, nothing carved, nothing placed. */
export function createWorld(settings: Partial<WorldSettings> = {}): WorldDoc {
	const resolved = normalizeSettings(settings);
	return {
		version: WORLD_VERSION,
		id: worldId('world'),
		name: 'Untitled world',
		settings: resolved,
		terrain: createTerrain(resolved),
		overlay: {},
		placements: [],
		updatedAt: new Date().toISOString(),
	};
}

/**
 * Change the map's extent without losing what is inside it.
 *
 * Non-destructive is the whole requirement. A resize control that silently drops the terrain —
 * which is what a naive `new Int16Array(columns)` does, and what a straight array copy does
 * more subtly by shearing the map onto the new stride — is a data-loss button in a toolbar,
 * and the user finds out after they have already saved over the good version.
 *
 * Growing keeps everything and fills the new ground flat at sea level. Shrinking keeps
 * everything that still fits; anything past the new edge is genuinely gone, so the caller is
 * expected to have asked first. `lost` says how much, so it can ask with a number.
 */
export function resizeWorld(
	doc: WorldDoc,
	size: { x: number; z: number },
): { world: WorldDoc; lost: { columns: number; chunks: number; movedPlacements: number } } {
	const next: WorldSettings = {
		...doc.settings,
		size: {
			x: clampInt(size.x, WORLD_LIMITS.minSize, WORLD_LIMITS.maxSize, doc.settings.size.x),
			z: clampInt(size.z, WORLD_LIMITS.minSize, WORLD_LIMITS.maxSize, doc.settings.size.z),
		},
	};

	const terrain = reindexTerrain(doc.terrain, doc.settings.size, next.size, {
		height: next.seaLevel,
		stratum: 0,
	});

	const { overlay, dropped } = clipOverlay(doc.overlay, next);

	let movedPlacements = 0;
	const placements = doc.placements.map((placement) => {
		const x = Math.min(placement.x, next.size.x - 1);
		const z = Math.min(placement.z, next.size.z - 1);
		if (x !== placement.x || z !== placement.z) movedPlacements++;
		return { ...placement, x, z };
	});

	const keptColumns = Math.min(doc.settings.size.x, next.size.x) * Math.min(doc.settings.size.z, next.size.z);
	const lostColumns = doc.settings.size.x * doc.settings.size.z - keptColumns;

	return {
		world: { ...doc, settings: next, terrain, overlay, placements },
		lost: { columns: lostColumns, chunks: dropped, movedPlacements },
	};
}

/**
 * Trim the overlay to a new extent.
 *
 * Chunks wholly outside go. Chunks straddling the new edge are rewritten with the outside
 * cells cleared rather than kept whole: an override sitting at x=600 in a 512-wide world is
 * unreachable, and leaving it there means it reappears the moment somebody widens the map
 * again — a cave that comes back from a resize two edits ago reads as haunted, not as undo.
 */
function clipOverlay(
	overlay: Overlay,
	settings: WorldSettings,
): { overlay: Overlay; dropped: number } {
	const out: Overlay = {};
	let dropped = 0;

	for (const [key, chunk] of Object.entries(overlay)) {
		const at = parseOverlayChunkKey(key);
		if (!at) continue;
		const box = overlayChunkBox(at.cx, at.cy, at.cz);

		if (box.minX >= settings.size.x || box.minZ >= settings.size.z || box.maxX < 0 || box.maxZ < 0) {
			dropped++;
			continue;
		}

		if (box.maxX < settings.size.x && box.maxZ < settings.size.z) {
			out[key] = chunk;
			continue;
		}

		const cells = decodeOverlayChunk(chunk);
		let kept = 0;
		for (let y = box.minY; y <= box.maxY; y++) {
			for (let z = box.minZ; z <= box.maxZ; z++) {
				for (let x = box.minX; x <= box.maxX; x++) {
					const index = overlayCellIndex(x, y, z);
					if (x >= settings.size.x || z >= settings.size.z) cells[index] = 0;
					else if (cells[index] !== 0) kept++;
				}
			}
		}
		if (kept === 0) dropped++;
		else out[key] = encodeOverlayChunk(cells, chunk.palette);
	}

	return { overlay: out, dropped };
}

/** The document as plain JSON — typed arrays out, base64 in. `normalizeWorld` is the inverse. */
export function worldToJSON(doc: WorldDoc): WorldDocJSON {
	return { ...doc, terrain: encodeTerrain(doc.terrain, doc.settings.size) };
}

/** A deep-enough copy to edit without touching the original — typed arrays included. */
export function cloneWorld(doc: WorldDoc): WorldDoc {
	return {
		...doc,
		settings: { ...doc.settings, size: { ...doc.settings.size }, strata: doc.settings.strata.map((p) => ({ ...p })) },
		terrain: { height: doc.terrain.height.slice(), strata: doc.terrain.strata.slice() },
		overlay: { ...doc.overlay },
		placements: doc.placements.map((placement) => ({ ...placement })),
	};
}
