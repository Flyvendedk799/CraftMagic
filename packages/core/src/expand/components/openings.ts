/**
 * Openings cut into walls: arches, window grids and doors.
 *
 * These run *after* the walls they perforate, relying on the painter's-order rule — they
 * carve air first, then place frames and glazing into the hole.
 */

import type { Face, Fill } from '../../ir/types.js';
import type { Brush } from '../canvas.js';
import { fillAt, type Palette } from '../fills.js';
import { supportsState, withState } from '../../registry/registry.js';

/** Unit vector pointing out of a wall with the given facing. */
const OUTWARD: Record<Face, [number, number]> = {
	north: [0, -1],
	south: [0, 1],
	east: [1, 0],
	west: [-1, 0],
};

/**
 * An arch: a rectangular opening with a curved head.
 *
 * `axis` is the wall's run — the direction the opening's width spans — so an arch in a
 * north-facing wall has axis 'x'.
 */
export function buildArch(
	brush: Brush,
	palette: Palette,
	pos: [number, number, number],
	width: number,
	height: number,
	depth: number,
	axis: 'x' | 'z',
	style: 'round' | 'pointed',
	fill: Fill,
	carve: boolean,
): void {
	if (width <= 0 || height <= 0 || depth <= 0) return;

	const min: [number, number, number] = pos;
	const max: [number, number, number] = [
		pos[0] + (axis === 'x' ? width : depth) - 1,
		pos[1] + height - 1,
		pos[2] + (axis === 'x' ? depth : width) - 1,
	];
	const ctx = { min, max };

	const radius = (width - 1) / 2;
	const centre = radius;
	// The curve occupies the top; below it the opening has straight jambs.
	const archHeight = Math.min(Math.ceil(radius), height - 1);
	const straightHeight = height - archHeight;

	for (let d = 0; d < depth; d++) {
		for (let w = 0; w < width; w++) {
			for (let h = 0; h < height; h++) {
				const offset = w - centre;
				let inside: boolean;

				if (h < straightHeight) {
					inside = true;
				} else {
					const up = h - straightHeight;
					inside =
						style === 'round'
							? // Ellipse: full width at the springing, narrowing to the crown.
								(offset / (radius + 0.5)) ** 2 + (up / (archHeight + 0.5)) ** 2 <= 1
							: // Pointed: two straight chamfers meeting at the apex.
								Math.abs(offset) <= radius * (1 - up / (archHeight + 1)) + 0.5;
				}

				if (!inside) continue;

				const x = pos[0] + (axis === 'x' ? w : d);
				const y = pos[1] + h;
				const z = pos[2] + (axis === 'x' ? d : w);

				if (carve) brush.clear(x, y, z);
				else brush.set(x, y, z, fillAt(fill, palette, x, y, z, ctx));
			}
		}
	}
}

export interface WindowGridSpec {
	face: Face;
	region: { pos: [number, number, number]; size: [number, number, number] };
	rows: number;
	cols: number;
	windowSize: [number, number];
	margin: number;
	role: string;
	sill: boolean;
}

/**
 * How much of the leftover space sits before gap `index` of `slots`.
 *
 * Whole blocks, handed out from a running total rather than by rounding a fraction per window,
 * and the far half is measured back from the far end so it mirrors the near half exactly. That
 * is what keeps a facade symmetric: with a plain `round(gap * n)` the block a wall has left
 * over when the windows do not divide evenly always fell on the same side, so a resize that
 * changed the remainder slid the whole row a block off centre.
 */
function spacing(index: number, slots: number, free: number): number {
	if (slots <= 0) return 0;
	if (2 * index <= slots) return Math.round((free * index) / slots);
	return free - Math.round((free * (slots - index)) / slots);
}

/**
 * Evenly distributed windows across a wall region.
 *
 * Spacing is computed from the leftover space rather than taken as a parameter, so the same
 * component still looks deliberate after a resize — the windows spread out instead of
 * bunching at one end.
 */
export function buildWindowGrid(brush: Brush, palette: Palette, spec: WindowGridSpec): void {
	const { region, rows, cols, windowSize, margin, role, sill } = spec;
	if (rows <= 0 || cols <= 0) return;

	const [windowW, windowH] = windowSize;
	if (windowW <= 0 || windowH <= 0) return;

	// Which axis the wall runs along: a north/south wall spans X, an east/west wall spans Z.
	const horizontal: 'x' | 'z' = spec.face === 'north' || spec.face === 'south' ? 'x' : 'z';
	const spanLength = (horizontal === 'x' ? region.size[0] : region.size[2]) - margin * 2;
	const spanOrigin = (horizontal === 'x' ? region.pos[0] : region.pos[2]) + margin;
	// Margin insets horizontally only — it means "keep clear of the corners". Applying it
	// vertically too would silently cancel the whole grid whenever the region is exactly as
	// tall as its windows, which is the common case for a single band of windows.
	const heightLength = region.size[1];
	const heightOrigin = region.pos[1];

	// Wall thickness is whatever the region is deep on the other axis.
	const depth = horizontal === 'x' ? region.size[2] : region.size[0];
	const depthOrigin = horizontal === 'x' ? region.pos[2] : region.pos[0];

	const freeSpan = spanLength - cols * windowW;
	const freeHeight = heightLength - rows * windowH;
	if (freeSpan < 0 || freeHeight < 0) return; // Windows do not fit; better none than a mangled wall.

	for (let col = 0; col < cols; col++) {
		const startSpan = spanOrigin + spacing(col + 1, cols + 1, freeSpan) + windowW * col;
		for (let row = 0; row < rows; row++) {
			const startHeight = heightOrigin + spacing(row + 1, rows + 1, freeHeight) + windowH * row;

			for (let w = 0; w < windowW; w++) {
				for (let h = 0; h < windowH; h++) {
					for (let d = 0; d < depth; d++) {
						const span = startSpan + w;
						const y = startHeight + h;
						const depthCoord = depthOrigin + d;
						const x = horizontal === 'x' ? span : depthCoord;
						const z = horizontal === 'x' ? depthCoord : span;
						brush.set(x, y, z, palette.resolve(role, x, y, z));
					}
				}
				if (!sill) continue;
				// A one-block ledge under each window, which reads as trim from outside.
				const span = startSpan + w;
				const sillY = startHeight - 1;
				const [ox, oz] = OUTWARD[spec.face];
				const x = (horizontal === 'x' ? span : depthOrigin) + ox;
				const z = (horizontal === 'x' ? depthOrigin : span) + oz;
				brush.set(x, sillY, z, palette.resolve(role, x, sillY, z));
			}
		}
	}
}

/**
 * A doorway: an opening carved through the wall with a door hung in it.
 *
 * Vanilla doors are two blocks tall and store their halves separately; getting `half` or
 * `hinge` wrong yields a door that renders inside-out, so both are derived here.
 */
export function buildDoor(
	brush: Brush,
	palette: Palette,
	face: Face,
	at: [number, number, number],
	width: 1 | 2,
	height: number,
	role: string,
): void {
	const horizontal: 'x' | 'z' = face === 'north' || face === 'south' ? 'x' : 'z';

	for (let w = 0; w < width; w++) {
		const x = at[0] + (horizontal === 'x' ? w : 0);
		const z = at[2] + (horizontal === 'z' ? w : 0);

		// Clear the full opening first so the door is never embedded in wall blocks.
		for (let h = 0; h < height; h++) brush.clear(x, at[1] + h, z);

		const ref = palette.resolve(role, x, at[1], z);
		if (!supportsState(ref, 'half', 'lower')) {
			// Not an actual door block — treat the role as decorative infill.
			for (let h = 0; h < height; h++) brush.set(x, at[1] + h, z, ref);
			continue;
		}

		// A double door's leaves mirror each other, so the second one hinges the other way.
		const hinge = w === 0 ? 'left' : 'right';
		brush.set(x, at[1], z, withState(ref, { half: 'lower', facing: face, hinge }));
		brush.set(x, at[1] + 1, z, withState(ref, { half: 'upper', facing: face, hinge }));
	}
}
