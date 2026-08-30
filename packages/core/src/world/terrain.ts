/**
 * The heightfield, and the one brush that writes to it.
 *
 * Two things live here and they are both about not repeating themselves. `columnIndex` is the
 * only place in the world module that knows terrain is row-major — the grids it materialises
 * into are YZX, and a single transposed index produces a world that looks entirely plausible
 * and is silently mirrored, which is the kind of bug that survives review and gets noticed a
 * week later by someone standing in it.
 *
 * `stampDisc` is the shared primitive. The Leveler flattens a disc to a target height and the
 * Terrainer raises or lowers one, and those are the same walk over the same cells with the
 * same falloff — the only difference is what they do once they are there. Written twice they
 * drift, and the drift shows up as a Leveler whose edge feathers differently from the
 * Terrainer's, in a tool where the whole point is that the two are used alternately on the
 * same ground.
 */

import type { Terrain, WorldSettings } from './types.js';

/**
 * Row-major index of a column, or -1 when it is off the map.
 *
 * -1 rather than a throw: brushes are dragged past the edge constantly and clipping is the
 * expected behaviour, not an error worth unwinding a stroke for.
 */
export function columnIndex(settings: WorldSettings, x: number, z: number): number {
	if (x < 0 || z < 0 || x >= settings.size.x || z >= settings.size.z) return -1;
	return z * settings.size.x + x;
}

/** Column position from a row-major index. The inverse of `columnIndex`. */
export function columnPosition(settings: WorldSettings, index: number): { x: number; z: number } {
	const z = Math.floor(index / settings.size.x);
	return { x: index - z * settings.size.x, z };
}

export interface Column {
	index: number;
	x: number;
	z: number;
	/** Y of the topmost solid block. `settings.minY - 1` when the column is empty. */
	height: number;
	/** Index into `settings.strata`. */
	stratum: number;
}

/** The column at a position, or null off the map. */
export function columnAt(
	terrain: Terrain,
	settings: WorldSettings,
	x: number,
	z: number,
): Column | null {
	const index = columnIndex(settings, x, z);
	if (index < 0) return null;
	return {
		index,
		x,
		z,
		height: terrain.height[index] ?? settings.minY - 1,
		stratum: terrain.strata[index] ?? 0,
	};
}

/** Whether a column has no solid block at all — the sentinel, spelled out once. */
export function isEmptyColumn(settings: WorldSettings, height: number): boolean {
	return height < settings.minY;
}

/**
 * A flat world at sea level, in the first stratum.
 *
 * Flat rather than noisy on purpose: this is a *building* tool, and a new project should open
 * as a surface you can put something on, not as terrain you first have to fight.
 */
export function createTerrain(settings: WorldSettings): Terrain {
	const columns = settings.size.x * settings.size.z;
	const height = new Int16Array(columns);
	height.fill(settings.seaLevel);
	return { height, strata: new Uint8Array(columns) };
}

/**
 * How a stamp fades from its centre.
 *
 * `flat` is the hard-edged one — the Leveler's default, because a plaza wants an edge. `smooth`
 * is cos² of the normalised distance, which reaches zero *at* the radius with zero slope, so
 * repeated strokes pile into a hill instead of a cone with a visible seam ring.
 */
export interface TerrainBrush {
	radius: number;
	strength: number;
	falloff: 'flat' | 'smooth';
}

/**
 * What a stamp does at one column. Weight is in `[0, brush.strength]`.
 *
 * The callback owns the write, which is the whole point: `stampDisc` decides *which* columns
 * and *how much*, and stays out of the argument about what raising ground means.
 */
export type StampVisit = (column: Column, weight: number) => void;

/**
 * Walk the columns of a disc, handing each one its weight.
 *
 * Clipped, never wrapped. A brush half off the west edge paints half a disc; a brush that
 * wrapped would paint the far side of the map, which is the sort of thing nobody notices until
 * a player finds a mysterious crater 900 blocks away.
 *
 * Returns how many columns were actually touched, so a stroke that landed entirely off the map
 * can be dropped from the undo stack rather than pushed as a no-op the user then has to undo.
 */
export function stampDisc(
	terrain: Terrain,
	settings: WorldSettings,
	cx: number,
	cz: number,
	brush: TerrainBrush,
	apply: StampVisit,
): number {
	const radius = Math.max(0, brush.radius);
	// A zero radius is still one column: a click has to do something, and the alternative is a
	// brush whose smallest setting is silently inert.
	const span = Math.floor(radius);
	const minX = Math.max(0, Math.ceil(cx - span));
	const maxX = Math.min(settings.size.x - 1, Math.floor(cx + span));
	const minZ = Math.max(0, Math.ceil(cz - span));
	const maxZ = Math.min(settings.size.z - 1, Math.floor(cz + span));

	// Compared squared, so the disc costs no square roots until a column is known to be inside.
	const limit = radius * radius;
	let touched = 0;

	for (let z = minZ; z <= maxZ; z++) {
		for (let x = minX; x <= maxX; x++) {
			const dx = x - cx;
			const dz = z - cz;
			const distanceSquared = dx * dx + dz * dz;
			if (radius > 0 && distanceSquared > limit) continue;

			const weight = brush.strength * falloffAt(distanceSquared, radius, brush.falloff);
			if (weight === 0) continue;

			const index = z * settings.size.x + x;
			apply(
				{
					index,
					x,
					z,
					height: terrain.height[index] ?? settings.minY - 1,
					stratum: terrain.strata[index] ?? 0,
				},
				weight,
			);
			touched++;
		}
	}

	return touched;
}

function falloffAt(distanceSquared: number, radius: number, kind: 'flat' | 'smooth'): number {
	if (kind === 'flat' || radius <= 0) return 1;
	const t = Math.sqrt(distanceSquared) / radius;
	if (t >= 1) return 0;
	const c = Math.cos((t * Math.PI) / 2);
	return c * c;
}

/**
 * Write a height back, clamped into the world.
 *
 * Every height that reaches the array goes through here. `Int16Array` truncates silently, so a
 * brush that ran a column past 32767 would not error — it would wrap it to the bottom of the
 * world, and the hill would come out as a pit.
 */
export function setHeight(
	terrain: Terrain,
	settings: WorldSettings,
	index: number,
	y: number,
): void {
	if (index < 0 || index >= terrain.height.length) return;
	const rounded = Math.round(y);
	if (!Number.isFinite(rounded)) return;
	terrain.height[index] = Math.max(settings.minY - 1, Math.min(settings.maxY, rounded));
}

/** Write a stratum back. Out-of-range indices are ignored rather than stored and resolved later. */
export function setStratum(
	terrain: Terrain,
	settings: WorldSettings,
	index: number,
	stratum: number,
): void {
	if (index < 0 || index >= terrain.strata.length) return;
	if (stratum < 0 || stratum >= settings.strata.length) return;
	terrain.strata[index] = stratum;
}

/**
 * Raise or lower a disc — the Terrainer, in terms of the shared primitive.
 *
 * `weight` is signed through `strength`, so lowering is the same call with a negative
 * strength rather than a second code path with its own rounding.
 */
export function raiseDisc(
	terrain: Terrain,
	settings: WorldSettings,
	cx: number,
	cz: number,
	brush: TerrainBrush,
): number {
	return stampDisc(terrain, settings, cx, cz, brush, (column, weight) => {
		const from = isEmptyColumn(settings, column.height) ? settings.minY : column.height;
		setHeight(terrain, settings, column.index, from + weight);
	});
}

/**
 * Flatten a disc towards a height — the Leveler.
 *
 * Interpolates towards the target by the weight rather than assigning it, so a smooth falloff
 * blends the edge of a plaza into the ground around it instead of cutting a cliff at the
 * radius. A `flat` brush at strength 1 is the plain "make it this height" the name promises.
 */
export function levelDisc(
	terrain: Terrain,
	settings: WorldSettings,
	cx: number,
	cz: number,
	brush: TerrainBrush,
	target: number,
): number {
	return stampDisc(terrain, settings, cx, cz, brush, (column, weight) => {
		const from = isEmptyColumn(settings, column.height) ? settings.minY : column.height;
		const blend = Math.max(0, Math.min(1, weight));
		setHeight(terrain, settings, column.index, from + (target - from) * blend);
	});
}

/**
 * Paint a stratum over a disc — the ground painter.
 *
 * Thresholded rather than blended: a column is one stratum, so the only honest thing a
 * partial weight can mean at the edge of the brush is "not yet".
 */
export function paintDisc(
	terrain: Terrain,
	settings: WorldSettings,
	cx: number,
	cz: number,
	brush: TerrainBrush,
	stratum: number,
): number {
	return stampDisc(terrain, settings, cx, cz, brush, (column, weight) => {
		if (weight < 0.5) return;
		setStratum(terrain, settings, column.index, stratum);
	});
}

/**
 * Move a heightfield onto a different stride, keeping every column that still exists.
 *
 * The one operation a resize and a decode both need, and the one that is silently wrong if
 * you copy the arrays straight across. Column `i` means `(i % x, floor(i / x))`, so the same
 * flat array read at a different `x` is the same map sheared diagonally — a mangling that
 * still looks like terrain, which is exactly why it has to be written once and tested rather
 * than open-coded at each call site.
 *
 * Columns outside the old map get `fill`; columns outside the new one are dropped, which is
 * the only thing a smaller array can do and the reason `resizeWorld` warns before shrinking.
 */
export function reindexTerrain(
	terrain: Terrain,
	from: { x: number; z: number },
	to: { x: number; z: number },
	fill: { height: number; stratum: number },
): Terrain {
	const height = new Int16Array(to.x * to.z);
	const strata = new Uint8Array(to.x * to.z);
	height.fill(fill.height);
	if (fill.stratum !== 0) strata.fill(fill.stratum);

	const rows = Math.min(from.z, to.z);
	const cols = Math.min(from.x, to.x);
	for (let z = 0; z < rows; z++) {
		const source = z * from.x;
		const target = z * to.x;
		for (let x = 0; x < cols; x++) {
			height[target + x] = terrain.height[source + x] ?? fill.height;
			strata[target + x] = terrain.strata[source + x] ?? fill.stratum;
		}
	}

	return { height, strata };
}

/** Lowest and highest solid block over a rectangle of columns, or null when it is all empty. */
export function heightRange(
	terrain: Terrain,
	settings: WorldSettings,
	x0: number,
	z0: number,
	w: number,
	d: number,
): { min: number; max: number } | null {
	let min = Infinity;
	let max = -Infinity;

	for (let z = z0; z < z0 + d; z++) {
		for (let x = x0; x < x0 + w; x++) {
			const index = columnIndex(settings, x, z);
			if (index < 0) continue;
			const height = terrain.height[index] ?? settings.minY - 1;
			if (isEmptyColumn(settings, height)) continue;
			if (height < min) min = height;
			if (height > max) max = height;
		}
	}

	return min === Infinity ? null : { min, max };
}
