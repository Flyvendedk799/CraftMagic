/**
 * Regions: turning a world back into something the rest of the engine already understands.
 *
 * This is the keystone. Everything downstream of the IR — the mesher, the editor, the schem
 * writer, the mod's paste — takes a `VoxelGrid`, and a world is far too big to be one. So a
 * world is cut into regions, and a region materialises into an ordinary grid. Nothing
 * downstream learns a new type; a region is simply a build that happened to be described by a
 * heightfield instead of by components.
 *
 * ## Terrain goes straight into the grid
 *
 * Not through the IR, and this is deliberate rather than lazy. No component expresses a
 * heightfield — a hillside is not a box, a cylinder or a roof — so the only IR that could
 * carry it is `details`, and `details` caps at `LIMITS.maxDetailOps` (5,000). One 40-block
 * hill is more `set` ops than that. Routing ground through the IR would mean either raising a
 * cap that exists to stop the model emitting nonsense, or shipping a program the expander
 * refuses. The prefab placements *do* come back as IR, because those genuinely are components
 * and a caller may want to re-expand or export them — that is what `program` is.
 *
 * ## Order matters
 *
 * Terrain, then overlay, then placements. Painter's order, same as the expander's: the overlay
 * exists to override the ground, so it has to run after it, and a placed building sits on top
 * of both. Reversing any pair produces something that still renders and is wrong — a tunnel
 * that fills itself in, or a house with the hill drawn back over its ground floor.
 *
 * ## Y is computed, not assumed
 *
 * A region's grid is only as tall as its contents, clamped to `LIMITS.maxSizeY` (160). A world
 * is allowed to be 257 blocks tall — Minecraft's -64..192 is — and a build is not, so a region
 * whose slab would exceed the cap is split by `regionsOf` into stacked ones. Materialising a
 * tall column without asking for a slab clips to the top 160 and says so in the stats, because
 * silently handing back an illegal grid is how a size cap turns into a rendering bug three
 * layers away.
 */

import {
	forEachPrefabRun,
	prefabPosition,
	turnedPrefabOffset,
	turnedPrefabSize,
	type Prefab,
} from '../ir/prefab.js';
import { AIR_BLOCK, LIMITS, voxelIndex, type BuildProgram, type Vec3, type VoxelGrid } from '../ir/types.js';
import { rotate } from '../registry/registry.js';
import { decodeOverlayChunk } from './codec.js';
import { overlayCellIndex, overlayChunkBox, parseOverlayChunkKey } from './overlay.js';
import { profileAt, WORLD_WATER } from './strata.js';
import { columnIndex } from './terrain.js';
import {
	OVERLAY_AIR,
	OVERLAY_NONE,
	type WorldDoc,
	type WorldPlacement,
	type WorldSettings,
} from './types.js';

/** One materialisable piece of a world. `ry` is 0 unless the world is too tall to be one grid. */
export interface Region {
	rx: number;
	rz: number;
	ry: number;
	key: string;
	/** Min corner in world columns, and the extent actually on the map. */
	x: number;
	z: number;
	w: number;
	d: number;
	/** The y slab this region owns, inclusive. Never more than `LIMITS.maxSizeY` tall. */
	minY: number;
	maxY: number;
}

/** Inclusive y slab. */
export interface Slab {
	minY: number;
	maxY: number;
}

/** How many regions across and down. The last one in each axis is short when the map is not a
 * whole number of regions wide, which is the common case and not worth forbidding. */
export function regionCount(settings: WorldSettings): { x: number; z: number } {
	return {
		x: Math.max(1, Math.ceil(settings.size.x / settings.regionSize)),
		z: Math.max(1, Math.ceil(settings.size.z / settings.regionSize)),
	};
}

/**
 * The footprint and full y span of one region.
 *
 * Clipped to the map, so an edge region is genuinely narrower rather than a full-width one
 * with a strip of nothing in it — the strip would cost cells, mesh work and a palette entry.
 */
export function regionBox(
	settings: WorldSettings,
	rx: number,
	rz: number,
): { x: number; z: number; w: number; d: number; minY: number; maxY: number } {
	const x = rx * settings.regionSize;
	const z = rz * settings.regionSize;
	return {
		x,
		z,
		w: Math.max(0, Math.min(settings.regionSize, settings.size.x - x)),
		d: Math.max(0, Math.min(settings.regionSize, settings.size.z - z)),
		minY: settings.minY,
		maxY: settings.maxY,
	};
}

/**
 * The y slabs a world's height has to be cut into.
 *
 * A build may be 160 tall and a world may be 257, so the split is arithmetic on the settings
 * rather than a judgement about content: every slab is materialisable, and together they cover
 * the world exactly once. Cutting by content instead would make the *set of regions* depend on
 * what is in them, so raising one hill would renumber somebody else's region.
 */
export function regionSlabs(settings: WorldSettings): Slab[] {
	const out: Slab[] = [];
	for (let minY = settings.minY; minY <= settings.maxY; minY += LIMITS.maxSizeY) {
		out.push({ minY, maxY: Math.min(settings.maxY, minY + LIMITS.maxSizeY - 1) });
	}
	return out;
}

/** Every region of a world, in row-major order with the slabs stacked inside each column. */
export function regionsOf(settings: WorldSettings): Region[] {
	const counts = regionCount(settings);
	const slabs = regionSlabs(settings);
	const out: Region[] = [];

	for (let rz = 0; rz < counts.z; rz++) {
		for (let rx = 0; rx < counts.x; rx++) {
			const box = regionBox(settings, rx, rz);
			if (box.w === 0 || box.d === 0) continue;
			for (let ry = 0; ry < slabs.length; ry++) {
				const slab = slabs[ry]!;
				out.push({
					rx,
					rz,
					ry,
					key: `${rx},${ry},${rz}`,
					x: box.x,
					z: box.z,
					w: box.w,
					d: box.d,
					minY: slab.minY,
					maxY: slab.maxY,
				});
			}
		}
	}

	return out;
}

export interface RegionStats {
	rx: number;
	rz: number;
	/** World position of grid cell (0,0,0) — where to stand the materialised grid. */
	origin: Vec3;
	w: number;
	d: number;
	minY: number;
	maxY: number;
	sizeY: number;
	columns: number;
	cells: number;
	/** Non-air cells in the finished grid. Exact after a materialise, an upper bound before. */
	blocks: number;
	/** Overlay cells that landed in this region, and how many of them were carves. */
	overlayCells: number;
	carves: number;
	/** Placements whose box reaches into this region, and the ones the catalogue could not answer. */
	placements: number;
	unresolved: number;
	/**
	 * True when the content was taller than `LIMITS.maxSizeY` and the bottom was dropped.
	 *
	 * Only reachable by materialising a tall world without naming a slab. Iterating `regionsOf`
	 * never sets it, because those slabs are cut to fit.
	 */
	clippedY: boolean;
	withinSizeCap: boolean;
	withinBlockCap: boolean;
}

/**
 * What a region would come out as, without building it.
 *
 * The block count is an upper bound before a materialise: it counts what the terrain and the
 * overlay lay down and does not subtract the carves that land on solid ground, because knowing
 * that costs the same walk as materialising. It is exact on the way back out of
 * `materializeRegion`, which counts the finished grid. Both are honest about which they are;
 * a stat that silently switches between an estimate and a measurement is worse than either.
 */
export function regionStats(
	doc: WorldDoc,
	rx: number,
	rz: number,
	slab?: Slab,
	catalogue?: ReadonlyMap<string, Prefab>,
): RegionStats {
	const { settings } = doc;
	const box = regionBox(settings, rx, rz);
	const extent = regionExtent(doc, rx, rz, slab, catalogue);
	const sizeY = extent.maxY - extent.minY + 1;

	let blocks = 0;
	for (let lz = 0; lz < box.d; lz++) {
		for (let lx = 0; lx < box.w; lx++) {
			const index = columnIndex(settings, box.x + lx, box.z + lz);
			if (index < 0) continue;
			const height = doc.terrain.height[index] ?? settings.minY - 1;
			const solidTop = Math.min(height, extent.maxY);
			if (solidTop >= extent.minY) blocks += solidTop - extent.minY + 1;
			const waterTop = Math.min(settings.seaLevel, extent.maxY);
			const waterFloor = Math.max(height + 1, extent.minY);
			if (waterTop >= waterFloor) blocks += waterTop - waterFloor + 1;
		}
	}

	const overlay = countOverlay(doc, box, extent);
	blocks += overlay.blocks;

	const placements = countPlacements(doc, box, extent, catalogue);
	blocks += placements.blocks;

	return {
		rx,
		rz,
		origin: [box.x, extent.minY, box.z],
		w: box.w,
		d: box.d,
		minY: extent.minY,
		maxY: extent.maxY,
		sizeY,
		columns: box.w * box.d,
		cells: box.w * box.d * sizeY,
		blocks,
		overlayCells: overlay.cells,
		carves: overlay.carves,
		placements: placements.count,
		unresolved: placements.unresolved,
		clippedY: extent.clipped,
		withinSizeCap: sizeY <= LIMITS.maxSizeY && box.w <= LIMITS.maxSizeX && box.d <= LIMITS.maxSizeZ,
		withinBlockCap: blocks <= LIMITS.maxBlocks,
	};
}

export interface MaterializedRegion {
	grid: VoxelGrid;
	/**
	 * The prefab placements as IR, or null when the region has none.
	 *
	 * A by-product, not the source of truth — the grid is already complete without it. It exists
	 * so a caller can re-expand, refine or export just the *buildings* of a region without the
	 * ground, which is what somebody editing a hub actually wants to work on.
	 */
	program: BuildProgram | null;
	stats: RegionStats;
}

/**
 * Build one region into a grid.
 *
 * `catalogue` maps a placement's `buildId` to the prefab it stands for. A placement the
 * catalogue cannot answer is skipped and counted rather than guessed at: a hub whose library
 * has not finished loading should show ground with holes in it, which is obviously incomplete,
 * rather than ground with plausible wrong buildings on it, which is not.
 */
export function materializeRegion(
	doc: WorldDoc,
	rx: number,
	rz: number,
	catalogue: ReadonlyMap<string, Prefab>,
	slab?: Slab,
): MaterializedRegion {
	const { settings } = doc;
	const box = regionBox(settings, rx, rz);
	const extent = regionExtent(doc, rx, rz, slab, catalogue);
	const sizeY = extent.maxY - extent.minY + 1;
	const size = { x: Math.max(box.w, 1), y: Math.max(sizeY, 1), z: Math.max(box.d, 1) };

	const palette: string[] = [AIR_BLOCK];
	const slotOf = new Map<string, number>([[AIR_BLOCK, 0]]);
	const voxels = new Uint16Array(size.x * size.y * size.z);

	/** Write in *world* coordinates; out-of-region writes are dropped, never wrapped. */
	const set = (wx: number, wy: number, wz: number, ref: string): void => {
		const lx = wx - box.x;
		const ly = wy - extent.minY;
		const lz = wz - box.z;
		if (lx < 0 || ly < 0 || lz < 0 || lx >= box.w || ly >= sizeY || lz >= box.d) return;
		let slot = slotOf.get(ref);
		if (slot === undefined) {
			slot = palette.length;
			palette.push(ref);
			slotOf.set(ref, slot);
		}
		voxels[voxelIndex(size, lx, ly, lz)] = slot;
	};

	// 1. Terrain. Filler up to the subsurface, subsurface up to the surface block, then water
	//    over anything below sea level. An empty column (height < minY) lays down no ground at
	//    all and gets water for its whole flooded depth, which is what a lake bottom bored
	//    through to the void has to look like.
	for (let lz = 0; lz < box.d; lz++) {
		const wz = box.z + lz;
		for (let lx = 0; lx < box.w; lx++) {
			const wx = box.x + lx;
			const index = columnIndex(settings, wx, wz);
			if (index < 0) continue;

			const height = doc.terrain.height[index] ?? settings.minY - 1;
			const profile = profileAt(settings, doc.terrain.strata[index] ?? 0);
			const subsurfaceFloor = height - profile.subsurfaceDepth;

			const top = Math.min(height, extent.maxY);
			for (let y = extent.minY; y <= top; y++) {
				const ref =
					y === height ? profile.surface : y >= subsurfaceFloor ? profile.subsurface : profile.filler;
				set(wx, y, wz, ref);
			}

			const waterTop = Math.min(settings.seaLevel, extent.maxY);
			for (let y = Math.max(height + 1, extent.minY); y <= waterTop; y++) {
				set(wx, y, wz, WORLD_WATER);
			}
		}
	}

	// 2. Overlay. Runs after the ground precisely so a carve can remove it — that tri-state is
	//    the reason caves exist, and it only means anything in this order.
	let overlayCells = 0;
	let carves = 0;
	for (const [key, chunk] of Object.entries(doc.overlay)) {
		const at = parseOverlayChunkKey(key);
		if (!at) continue;
		const chunkBox = overlayChunkBox(at.cx, at.cy, at.cz);
		if (!intersects(chunkBox, box, extent)) continue;

		const cells = decodeOverlayChunk(chunk);
		const y0 = Math.max(chunkBox.minY, extent.minY);
		const y1 = Math.min(chunkBox.maxY, extent.maxY);
		const z0 = Math.max(chunkBox.minZ, box.z);
		const z1 = Math.min(chunkBox.maxZ, box.z + box.d - 1);
		const x0 = Math.max(chunkBox.minX, box.x);
		const x1 = Math.min(chunkBox.maxX, box.x + box.w - 1);

		for (let y = y0; y <= y1; y++) {
			for (let z = z0; z <= z1; z++) {
				for (let x = x0; x <= x1; x++) {
					const value = cells[overlayCellIndex(x, y, z)] ?? OVERLAY_NONE;
					if (value === OVERLAY_NONE) continue;
					overlayCells++;
					if (value === OVERLAY_AIR) {
						carves++;
						set(x, y, z, AIR_BLOCK);
						continue;
					}
					const ref = chunk.palette[value];
					// A cell naming a slot the palette does not have is corrupt data, not a shape
					// question: leave the terrain rather than intern `undefined` into the palette.
					if (ref) set(x, y, z, ref);
				}
			}
		}
	}

	// 3. Placements, last, on top of both.
	const prefabs: Record<string, Prefab> = {};
	const components: BuildProgram['components'] = [];
	let placed = 0;
	let unresolved = 0;

	for (const placement of doc.placements) {
		const prefab = catalogue.get(placement.buildId);
		if (!prefab) {
			if (placementReaches(doc, placement, box, extent, undefined)) unresolved++;
			continue;
		}

		const turns = placement.turns;
		const turnedSize = turnedPrefabSize(prefab.size, turns);
		const shift = turnedPrefabOffset(prefab.size, turns);
		const baseY = anchorY(doc, placement, turnedSize.y);
		if (!boxesTouch(placement.x, placement.z, turnedSize, baseY, box, extent)) continue;

		placed++;
		prefabs[placement.buildId] = prefab;
		components.push({
			type: 'prefab',
			id: placement.id,
			label: placement.name,
			ref: placement.buildId,
			pos: [placement.x - box.x, baseY - extent.minY, placement.z - box.z],
			turns,
		});

		forEachPrefabRun(prefab, (index, length, start) => {
			// Index 0 is the prefab's own air. A placed building is not a carve: skipping it is
			// what lets a house stand in a doorway-shaped hole in a hill instead of bulldozing a
			// box of ground around itself.
			if (index === 0) return;
			const ref = prefab.palette[index];
			if (!ref) return;
			const turnedRef = turns === 0 ? ref : rotate(ref, turns);

			for (let step = 0; step < length; step++) {
				const [dx, dy, dz] = prefabPosition(prefab, start + step);
				const [tx, tz] = turnXZ(dx, dz, turns);
				set(tx + placement.x + shift.x, dy + baseY, tz + placement.z + shift.z, turnedRef);
			}
		});
	}

	let blocks = 0;
	for (let i = 0; i < voxels.length; i++) if (voxels[i] !== 0) blocks++;

	const program: BuildProgram | null = components.length
		? {
			version: 1,
			meta: { name: `${doc.name} — region ${rx},${rz}` },
			size,
			palette: {},
			prefabs,
			components,
		}
		: null;

	return {
		grid: { size, palette, voxels },
		program,
		stats: {
			rx,
			rz,
			origin: [box.x, extent.minY, box.z],
			w: box.w,
			d: box.d,
			minY: extent.minY,
			maxY: extent.maxY,
			sizeY,
			columns: box.w * box.d,
			cells: size.x * size.y * size.z,
			blocks,
			overlayCells,
			carves,
			placements: placed,
			unresolved,
			clippedY: extent.clipped,
			withinSizeCap:
				sizeY <= LIMITS.maxSizeY && box.w <= LIMITS.maxSizeX && box.d <= LIMITS.maxSizeZ,
			withinBlockCap: blocks <= LIMITS.maxBlocks,
		},
	};
}

/**
 * Where a placement's bottom layer sits.
 *
 * `surface` reads the height at the placement's own origin column rather than averaging the
 * footprint: a building has one floor, and picking the corner it is anchored by is the rule a
 * user can predict while dragging it. Averaging would make a house creep up and down as it
 * crosses a slope, which looks like a bug even when it is arguably nicer.
 */
export function anchorY(doc: WorldDoc, placement: WorldPlacement, height: number): number {
	const { settings } = doc;
	if (placement.anchor === 'fixed') return placement.y;

	const index = columnIndex(settings, placement.x, placement.z);
	const ground = index < 0 ? settings.seaLevel : doc.terrain.height[index] ?? settings.seaLevel;
	if (ground < settings.minY) return settings.minY;

	// `buried` puts the build's *top* at ground level; `surface` stands its bottom on top of it.
	return placement.anchor === 'buried' ? ground - height + 1 : ground + 1;
}

/** A quarter-turn clockwise about the origin: (x,z) -> (-z, x), matching `canvas.ts`'s frame. */
function turnXZ(x: number, z: number, turns: number): [number, number] {
	let cx = x;
	let cz = z;
	for (let i = 0; i < ((turns % 4) + 4) % 4; i++) {
		const nx = -cz;
		cz = cx;
		cx = nx;
	}
	return [cx, cz];
}

interface Extent {
	minY: number;
	maxY: number;
	clipped: boolean;
}

interface Box {
	x: number;
	z: number;
	w: number;
	d: number;
}

/**
 * The y range a region actually needs.
 *
 * Computed from content — the highest ground, the highest overlay cell, the top of the tallest
 * building — rather than from the world's own bounds, because a hub sitting at y 60 in a world
 * that runs to 192 would otherwise materialise 130 layers of air per region and pay for them
 * in cells, in mesh work and in every byte that grid is ever sent over.
 *
 * The bottom is the world floor whenever any ground exists, since filler goes all the way
 * down; that is why the clamp when content exceeds 160 drops the *bottom*. The surface is what
 * anyone is looking at, and the deep filler is the part nobody misses.
 */
function regionExtent(
	doc: WorldDoc,
	rx: number,
	rz: number,
	slab: Slab | undefined,
	catalogue: ReadonlyMap<string, Prefab> | undefined,
): Extent {
	const { settings } = doc;
	const box = regionBox(settings, rx, rz);
	const floor = slab ? Math.max(slab.minY, settings.minY) : settings.minY;
	const ceiling = slab ? Math.min(slab.maxY, settings.maxY) : settings.maxY;

	let min = Infinity;
	let max = -Infinity;

	for (let lz = 0; lz < box.d; lz++) {
		for (let lx = 0; lx < box.w; lx++) {
			const index = columnIndex(settings, box.x + lx, box.z + lz);
			if (index < 0) continue;
			const height = doc.terrain.height[index] ?? settings.minY - 1;
			// Ground fills to the world floor and water fills from just above the ground, so a
			// column that exists at all reaches the bottom one way or the other.
			min = settings.minY;
			max = Math.max(max, Math.min(Math.max(height, settings.seaLevel), settings.maxY));
		}
	}

	for (const [key, chunk] of Object.entries(doc.overlay)) {
		const at = parseOverlayChunkKey(key);
		if (!at) continue;
		const chunkBox = overlayChunkBox(at.cx, at.cy, at.cz);
		if (
			chunkBox.maxX < box.x || chunkBox.minX >= box.x + box.w ||
			chunkBox.maxZ < box.z || chunkBox.minZ >= box.z + box.d
		) {
			continue;
		}
		const cells = decodeOverlayChunk(chunk);
		for (let y = chunkBox.minY; y <= chunkBox.maxY; y++) {
			let any = false;
			for (let z = Math.max(chunkBox.minZ, box.z); z <= Math.min(chunkBox.maxZ, box.z + box.d - 1) && !any; z++) {
				for (let x = Math.max(chunkBox.minX, box.x); x <= Math.min(chunkBox.maxX, box.x + box.w - 1); x++) {
					if (cells[overlayCellIndex(x, y, z)] !== OVERLAY_NONE) {
						any = true;
						break;
					}
				}
			}
			if (!any) continue;
			min = Math.min(min, y);
			max = Math.max(max, y);
		}
	}

	for (const placement of doc.placements) {
		const prefab = catalogue?.get(placement.buildId);
		const turnedSize = prefab
			? turnedPrefabSize(prefab.size, placement.turns)
			: turnedPrefabSize({ x: placement.w, y: placement.h, z: placement.d }, placement.turns);
		const baseY = anchorY(doc, placement, turnedSize.y);
		if (!boxesTouch(placement.x, placement.z, turnedSize, baseY, box, { minY: settings.minY, maxY: settings.maxY, clipped: false })) {
			continue;
		}
		min = Math.min(min, baseY);
		max = Math.max(max, baseY + turnedSize.y - 1);
	}

	if (min === Infinity || max === -Infinity) {
		// Nothing at all — an off-map region, or a slab above everything. One layer, so the grid
		// is still a legal grid rather than a zero-sized one every caller has to special-case.
		return { minY: floor, maxY: floor, clipped: false };
	}

	let low = Math.max(floor, Math.min(min, ceiling));
	let high = Math.min(ceiling, Math.max(max, floor));
	if (high < low) high = low;

	// The grid this becomes is a build, and a build may not be taller than `maxSizeY`. Keeping
	// the top is the right half to keep: it is the surface, and the alternative is a region
	// whose ground is present and whose buildings are gone.
	let clipped = false;
	if (high - low + 1 > LIMITS.maxSizeY) {
		low = high - LIMITS.maxSizeY + 1;
		clipped = true;
	}

	return { minY: low, maxY: high, clipped };
}

function intersects(
	chunkBox: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
	box: Box,
	extent: Extent,
): boolean {
	return (
		chunkBox.maxX >= box.x && chunkBox.minX < box.x + box.w &&
		chunkBox.maxZ >= box.z && chunkBox.minZ < box.z + box.d &&
		chunkBox.maxY >= extent.minY && chunkBox.minY <= extent.maxY
	);
}

/**
 * Whether a placement's turned box reaches into a region.
 *
 * Intersection, not containment. A building straddling a boundary has to appear in both
 * regions, clipped — a hub is a grid of regions and the seams are exactly where the walls of
 * the big builds fall.
 */
function boxesTouch(
	x: number,
	z: number,
	turnedSize: { x: number; y: number; z: number },
	baseY: number,
	box: Box,
	extent: Extent,
): boolean {
	return (
		x + turnedSize.x - 1 >= box.x && x < box.x + box.w &&
		z + turnedSize.z - 1 >= box.z && z < box.z + box.d &&
		baseY + turnedSize.y - 1 >= extent.minY && baseY <= extent.maxY
	);
}

function placementReaches(
	doc: WorldDoc,
	placement: WorldPlacement,
	box: Box,
	extent: Extent,
	prefab: Prefab | undefined,
): boolean {
	const turnedSize = prefab
		? turnedPrefabSize(prefab.size, placement.turns)
		: turnedPrefabSize({ x: placement.w, y: placement.h, z: placement.d }, placement.turns);
	return boxesTouch(placement.x, placement.z, turnedSize, anchorY(doc, placement, turnedSize.y), box, extent);
}

function countOverlay(doc: WorldDoc, box: Box, extent: Extent): { cells: number; carves: number; blocks: number } {
	let cells = 0;
	let carves = 0;
	let blocks = 0;

	for (const [key, chunk] of Object.entries(doc.overlay)) {
		const at = parseOverlayChunkKey(key);
		if (!at) continue;
		const chunkBox = overlayChunkBox(at.cx, at.cy, at.cz);
		if (!intersects(chunkBox, box, extent)) continue;

		const decoded = decodeOverlayChunk(chunk);
		for (let y = Math.max(chunkBox.minY, extent.minY); y <= Math.min(chunkBox.maxY, extent.maxY); y++) {
			for (let z = Math.max(chunkBox.minZ, box.z); z <= Math.min(chunkBox.maxZ, box.z + box.d - 1); z++) {
				for (let x = Math.max(chunkBox.minX, box.x); x <= Math.min(chunkBox.maxX, box.x + box.w - 1); x++) {
					const value = decoded[overlayCellIndex(x, y, z)] ?? OVERLAY_NONE;
					if (value === OVERLAY_NONE) continue;
					cells++;
					if (value === OVERLAY_AIR) carves++;
					else blocks++;
				}
			}
		}
	}

	return { cells, carves, blocks };
}

function countPlacements(
	doc: WorldDoc,
	box: Box,
	extent: Extent,
	catalogue: ReadonlyMap<string, Prefab> | undefined,
): { count: number; unresolved: number; blocks: number } {
	let count = 0;
	let unresolved = 0;
	let blocks = 0;

	for (const placement of doc.placements) {
		const prefab = catalogue?.get(placement.buildId);
		if (!placementReaches(doc, placement, box, extent, prefab)) continue;
		count++;
		if (!prefab) {
			unresolved++;
			continue;
		}
		// The clipped share of the box, not the whole prefab: a tower on a seam must not be
		// counted twice over by the two regions that share it.
		const turnedSize = turnedPrefabSize(prefab.size, placement.turns);
		const baseY = anchorY(doc, placement, turnedSize.y);
		const w = overlap(placement.x, placement.x + turnedSize.x - 1, box.x, box.x + box.w - 1);
		const d = overlap(placement.z, placement.z + turnedSize.z - 1, box.z, box.z + box.d - 1);
		const h = overlap(baseY, baseY + turnedSize.y - 1, extent.minY, extent.maxY);
		blocks += w * d * h;
	}

	return { count, unresolved, blocks };
}

function overlap(aMin: number, aMax: number, bMin: number, bMax: number): number {
	return Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin) + 1);
}
