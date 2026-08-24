/**
 * Roofs.
 *
 * This is where "the expander computes blockstates, not the model" earns its keep. A stair
 * block's `facing` names the side its *tall* half sits on, so a slope ascending north needs
 * `facing=north`. Language models get this backwards constantly; here it is derived from
 * the geometry and therefore always right.
 */

import type { Face } from '../../ir/types.js';
import type { Brush } from '../canvas.js';
import type { Palette } from '../fills.js';
import { supportsState, withState } from '../../registry/registry.js';

export type RoofStyle = 'stairs' | 'slabs' | 'full';

/**
 * Place one sloping roof block.
 *
 * `ascendToward` is the direction the roof climbs. The stair's tall half must sit on that
 * side so the next step up meets it flush, which means `facing` equals `ascendToward`.
 */
function placeSlopeBlock(
	brush: Brush,
	palette: Palette,
	x: number,
	y: number,
	z: number,
	role: string,
	style: RoofStyle,
	ascendToward: Face,
): void {
	const ref = palette.resolve(role, x, y, z);
	if (style === 'stairs' && supportsState(ref, 'facing', ascendToward)) {
		brush.set(x, y, z, withState(ref, { facing: ascendToward, half: 'bottom', shape: 'straight' }));
		return;
	}
	if (style === 'slabs' && supportsState(ref, 'type')) {
		brush.set(x, y, z, withState(ref, { type: 'bottom' }));
		return;
	}
	brush.set(x, y, z, ref);
}

/**
 * Place an outer-corner roof block, where two slopes meet and the surface falls away
 * diagonally.
 *
 * Derived from the vanilla model rather than guessed: `outer_stairs` raises its quarter in
 * the **south-east** at y=0, and the blockstate's `y` rotation turns that clockwise
 * (90 -> SW, 180 -> NW, 270 -> NE). Reading the rotations back out of `oak_stairs.json`
 * gives the mapping below, where the raised quarter must point at the ridge.
 *
 * A plain straight stair here would leave a visible notch on every corner of every hip roof.
 */
function placeCornerBlock(
	brush: Brush,
	palette: Palette,
	x: number,
	y: number,
	z: number,
	role: string,
	style: RoofStyle,
	raisedSouth: boolean,
	raisedEast: boolean,
): void {
	const ref = palette.resolve(role, x, y, z);
	if (style !== 'stairs' || !supportsState(ref, 'shape', 'outer_left')) {
		brush.set(x, y, z, ref);
		return;
	}

	const facing: Face = raisedSouth ? 'south' : 'north';
	// south+east and north+west land on outer_left; the other diagonal on outer_right.
	const shape = raisedSouth === raisedEast ? 'outer_left' : 'outer_right';
	brush.set(x, y, z, withState(ref, { facing, half: 'bottom', shape }));
}

export interface RoofRegion {
	pos: [number, number, number];
	size: [number, number, number];
}

/**
 * A gable roof: two slopes meeting at a ridge line.
 *
 * The ridge runs along `ridgeAxis`, so the slopes descend along the other horizontal axis.
 * Height is however tall the slopes need to be to meet, capped by the region's height —
 * so a shallow region yields a truncated roof rather than one that overshoots the build.
 */
export function buildGableRoof(
	brush: Brush,
	palette: Palette,
	region: RoofRegion,
	ridgeAxis: 'x' | 'z',
	overhang: number,
	style: RoofStyle,
	roofRole: string,
	trimRole: string | undefined,
): void {
	// Overhang widens the footprint on all four sides, the way real eaves project.
	const pos: [number, number, number] = [
		region.pos[0] - overhang,
		region.pos[1],
		region.pos[2] - overhang,
	];
	const size: [number, number, number] = [
		region.size[0] + overhang * 2,
		region.size[1],
		region.size[2] + overhang * 2,
	];

	// The span the slopes climb across, and the run they extend along.
	const spanLength = ridgeAxis === 'x' ? size[2] : size[0];
	const runLength = ridgeAxis === 'x' ? size[0] : size[2];
	const spanOrigin = ridgeAxis === 'x' ? pos[2] : pos[0];
	const runOrigin = ridgeAxis === 'x' ? pos[0] : pos[2];

	const maxHeight = Math.min(size[1], Math.ceil(spanLength / 2));

	for (let level = 0; level < maxHeight; level++) {
		const y = pos[1] + level;
		const lowIndex = level;
		const highIndex = spanLength - 1 - level;
		if (lowIndex > highIndex) break;

		// If `size.y` stops the roof before the slopes meet, close it off flat rather than
		// leaving the build open to the sky.
		const truncated = level + 1 >= maxHeight && highIndex - lowIndex > 1;

		for (let run = 0; run < runLength; run++) {
			const runCoord = runOrigin + run;

			if (truncated) {
				for (let span = lowIndex; span <= highIndex; span++) {
					const spanCoord = spanOrigin + span;
					const [cx, cz] = ridgeAxis === 'x' ? [runCoord, spanCoord] : [spanCoord, runCoord];
					brush.set(cx, y, cz, palette.resolve(trimRole ?? roofRole, cx, y, cz));
				}
				continue;
			}

			if (lowIndex === highIndex) {
				// Odd span: the two slopes converge on a single ridge column. A stair here
				// would leave a notch, so cap it with the plain block.
				const spanCoord = spanOrigin + lowIndex;
				const [x, z] = ridgeAxis === 'x' ? [runCoord, spanCoord] : [spanCoord, runCoord];
				brush.set(x, y, z, palette.resolve(trimRole ?? roofRole, x, y, z));
				continue;
			}

			// The low-index side sits at smaller coordinates, so it climbs toward larger
			// ones: south (+Z) for an X ridge, east (+X) for a Z ridge.
			const lowSpan = spanOrigin + lowIndex;
			const highSpan = spanOrigin + highIndex;
			const lowAscend: Face = ridgeAxis === 'x' ? 'south' : 'east';
			const highAscend: Face = ridgeAxis === 'x' ? 'north' : 'west';

			const [lx, lz] = ridgeAxis === 'x' ? [runCoord, lowSpan] : [lowSpan, runCoord];
			const [hx, hz] = ridgeAxis === 'x' ? [runCoord, highSpan] : [highSpan, runCoord];

			placeSlopeBlock(brush, palette, lx, y, lz, roofRole, style, lowAscend);
			placeSlopeBlock(brush, palette, hx, y, hz, roofRole, style, highAscend);
		}
	}
}

/**
 * A hip roof: all four sides slope inward, so each level insets on every edge.
 *
 * Corners get a plain block rather than a stair — two stairs meeting at 90° leave a visible
 * gap, and vanilla's `outer_*` shapes only look right when the surrounding blocks agree.
 */
export function buildHipRoof(
	brush: Brush,
	palette: Palette,
	region: RoofRegion,
	overhang: number,
	style: RoofStyle,
	roofRole: string,
): void {
	const pos: [number, number, number] = [
		region.pos[0] - overhang,
		region.pos[1],
		region.pos[2] - overhang,
	];
	const size: [number, number, number] = [
		region.size[0] + overhang * 2,
		region.size[1],
		region.size[2] + overhang * 2,
	];

	const maxHeight = Math.min(size[1], Math.ceil(Math.min(size[0], size[2]) / 2));

	for (let level = 0; level < maxHeight; level++) {
		const y = pos[1] + level;
		const x0 = pos[0] + level;
		const x1 = pos[0] + size[0] - 1 - level;
		const z0 = pos[2] + level;
		const z1 = pos[2] + size[2] - 1 - level;
		if (x0 > x1 || z0 > z1) break;

		// Whether anything is drawn above this tier. If not, this one is the cap and its
		// interior must be filled — otherwise the roof is left with an open hole on top,
		// either because the tiers converged to a 3x3 or because `size.y` ran out first.
		const isCap = level + 1 >= maxHeight || x0 + 1 > x1 - 1 || z0 + 1 > z1 - 1;

		for (let z = z0; z <= z1; z++) {
			for (let x = x0; x <= x1; x++) {
				const onWestEdge = x === x0;
				const onEastEdge = x === x1;
				const onNorthEdge = z === z0;
				const onSouthEdge = z === z1;
				if (!onWestEdge && !onEastEdge && !onNorthEdge && !onSouthEdge) {
					if (isCap) brush.set(x, y, z, palette.resolve(roofRole, x, y, z));
					continue;
				}

				const edges = Number(onWestEdge) + Number(onEastEdge) + Number(onNorthEdge) + Number(onSouthEdge);

				if (x0 === x1 || z0 === z1) {
					// The tier has collapsed to a ridge line; cap it flat.
					brush.set(x, y, z, palette.resolve(roofRole, x, y, z));
					continue;
				}

				if (edges > 1) {
					// A corner: the roof rises toward the middle on both of its axes.
					placeCornerBlock(
						brush,
						palette,
						x,
						y,
						z,
						roofRole,
						style,
						onNorthEdge,
						onWestEdge,
					);
					continue;
				}

				// Each face climbs toward the middle of the roof.
				const ascend: Face = onWestEdge ? 'east' : onEastEdge ? 'west' : onNorthEdge ? 'south' : 'north';
				placeSlopeBlock(brush, palette, x, y, z, roofRole, style, ascend);
			}
		}
	}
}

/**
 * A run of stairs climbing one block per step in `direction`.
 *
 * Unlike a roof slope, a staircase's tall half faces the way you are *walking*, so `facing`
 * is the travel direction.
 */
export function buildStairsRun(
	brush: Brush,
	palette: Palette,
	pos: [number, number, number],
	direction: Face,
	width: number,
	steps: number,
	role: string,
	style: 'stairs' | 'blocks',
): void {
	const forward: Record<Face, [number, number]> = {
		north: [0, -1],
		south: [0, 1],
		east: [1, 0],
		west: [-1, 0],
	};
	const [fx, fz] = forward[direction];
	// Width runs perpendicular to travel.
	const [wx, wz] = fz === 0 ? [0, 1] : [1, 0];

	for (let step = 0; step < steps; step++) {
		for (let w = 0; w < width; w++) {
			const x = pos[0] + fx * step + wx * w;
			const y = pos[1] + step;
			const z = pos[2] + fz * step + wz * w;
			const ref = palette.resolve(role, x, y, z);

			if (style === 'stairs' && supportsState(ref, 'facing', direction)) {
				brush.set(x, y, z, withState(ref, { facing: direction, half: 'bottom', shape: 'straight' }));
			} else {
				brush.set(x, y, z, ref);
			}
		}
	}
}
