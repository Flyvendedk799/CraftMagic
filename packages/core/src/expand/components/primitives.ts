/**
 * Solid-geometry components: box, hollow_box, cylinder, sphere, pyramid, line.
 *
 * Every builder receives already-resolved integer coordinates. Coordinate expressions are
 * evaluated once, in the expander, so a component never has to think about `"max-1"`.
 */

import type { Fill } from '../../ir/types.js';
import type { Brush } from '../canvas.js';
import { fillAt, type Palette } from '../fills.js';

export interface Region {
	pos: [number, number, number];
	size: [number, number, number];
}

/** Inclusive max corner. Sizes are lengths, so a size of 1 spans exactly one block. */
function maxCorner(region: Region): [number, number, number] {
	return [
		region.pos[0] + region.size[0] - 1,
		region.pos[1] + region.size[1] - 1,
		region.pos[2] + region.size[2] - 1,
	];
}

function paint(
	brush: Brush,
	palette: Palette,
	fill: Fill,
	region: Region,
	predicate?: (x: number, y: number, z: number) => boolean,
): void {
	const max = maxCorner(region);
	const ctx = { min: region.pos, max };
	for (let y = region.pos[1]; y <= max[1]; y++) {
		for (let z = region.pos[2]; z <= max[2]; z++) {
			for (let x = region.pos[0]; x <= max[0]; x++) {
				if (predicate && !predicate(x, y, z)) continue;
				brush.set(x, y, z, fillAt(fill, palette, x, y, z, ctx));
			}
		}
	}
}

export function buildBox(brush: Brush, palette: Palette, region: Region, fill: Fill): void {
	paint(brush, palette, fill, region);
}

export function buildHollowBox(
	brush: Brush,
	palette: Palette,
	region: Region,
	fill: Fill,
	options: { wallThickness?: number; floor?: boolean; ceiling?: boolean },
): void {
	const thickness = Math.max(1, options.wallThickness ?? 1);
	const withFloor = options.floor ?? true;
	const withCeiling = options.ceiling ?? false;
	const [minX, minY, minZ] = region.pos;
	const [maxX, maxY, maxZ] = maxCorner(region);

	paint(brush, palette, fill, region, (x, y, z) => {
		const nearWall =
			x - minX < thickness || maxX - x < thickness || z - minZ < thickness || maxZ - z < thickness;
		if (nearWall) return true;
		if (withFloor && y - minY < thickness) return true;
		if (withCeiling && maxY - y < thickness) return true;
		return false;
	});
}

export function buildCylinder(
	brush: Brush,
	palette: Palette,
	base: [number, number, number],
	radius: number,
	height: number,
	axis: 'x' | 'y' | 'z',
	hollow: boolean,
	fill: Fill,
): void {
	if (radius < 0 || height <= 0) return;

	// Test against (r + 0.5)^2 so the rim lands where a player would draw it by hand;
	// testing against r^2 alone produces circles that read one block too small.
	const outer = (radius + 0.5) ** 2;
	const inner = (radius - 0.5) ** 2;

	const min: [number, number, number] = [
		base[0] - (axis === 'x' ? 0 : radius),
		base[1] - (axis === 'y' ? 0 : radius),
		base[2] - (axis === 'z' ? 0 : radius),
	];
	const size: [number, number, number] = [
		axis === 'x' ? height : radius * 2 + 1,
		axis === 'y' ? height : radius * 2 + 1,
		axis === 'z' ? height : radius * 2 + 1,
	];
	const region: Region = { pos: min, size };
	const ctx = { min, max: maxCorner(region) };

	for (let i = 0; i < height; i++) {
		for (let a = -radius; a <= radius; a++) {
			for (let b = -radius; b <= radius; b++) {
				const distance = a * a + b * b;
				if (distance > outer) continue;
				if (hollow && distance < inner) continue;

				// `i` runs along the axis; `a` and `b` span the circular cross-section on the
				// other two axes, in x,y,z order.
				let x: number;
				let y: number;
				let z: number;
				if (axis === 'y') {
					x = base[0] + a;
					y = base[1] + i;
					z = base[2] + b;
				} else if (axis === 'x') {
					x = base[0] + i;
					y = base[1] + a;
					z = base[2] + b;
				} else {
					x = base[0] + a;
					y = base[1] + b;
					z = base[2] + i;
				}
				brush.set(x, y, z, fillAt(fill, palette, x, y, z, ctx));
			}
		}
	}
}

export function buildSphere(
	brush: Brush,
	palette: Palette,
	center: [number, number, number],
	radius: number,
	hollow: boolean,
	cap: 'full' | 'top_half' | 'bottom_half',
	fill: Fill,
): void {
	if (radius < 0) return;

	const outer = (radius + 0.5) ** 2;
	const inner = (radius - 0.5) ** 2;
	const min: [number, number, number] = [center[0] - radius, center[1] - radius, center[2] - radius];
	const region: Region = { pos: min, size: [radius * 2 + 1, radius * 2 + 1, radius * 2 + 1] };
	const ctx = { min, max: maxCorner(region) };

	const loY = cap === 'top_half' ? 0 : -radius;
	const hiY = cap === 'bottom_half' ? 0 : radius;

	for (let dy = loY; dy <= hiY; dy++) {
		for (let dz = -radius; dz <= radius; dz++) {
			for (let dx = -radius; dx <= radius; dx++) {
				const distance = dx * dx + dy * dy + dz * dz;
				if (distance > outer) continue;
				if (hollow && distance < inner) continue;
				const x = center[0] + dx;
				const y = center[1] + dy;
				const z = center[2] + dz;
				brush.set(x, y, z, fillAt(fill, palette, x, y, z, ctx));
			}
		}
	}
}

export function buildPyramid(
	brush: Brush,
	palette: Palette,
	pos: [number, number, number],
	baseSize: [number, number],
	step: number,
	hollow: boolean,
	fill: Fill,
): void {
	const inset = Math.max(1, step);
	const region: Region = { pos, size: [baseSize[0], 1, baseSize[1]] };
	const ctx = { min: pos, max: maxCorner(region) };

	for (let level = 0; ; level++) {
		const shrink = level * inset;
		const width = baseSize[0] - shrink * 2;
		const depth = baseSize[1] - shrink * 2;
		if (width <= 0 || depth <= 0) break;

		const x0 = pos[0] + shrink;
		const z0 = pos[2] + shrink;
		const y = pos[1] + level;

		for (let z = z0; z < z0 + depth; z++) {
			for (let x = x0; x < x0 + width; x++) {
				// A hollow pyramid keeps only its outer ring per tier, which is what makes it
				// a shell rather than a solid mass — but the apex must stay filled or the
				// top few tiers vanish.
				if (hollow && width > 2 && depth > 2) {
					const onRing = x === x0 || x === x0 + width - 1 || z === z0 || z === z0 + depth - 1;
					if (!onRing) continue;
				}
				brush.set(x, y, z, fillAt(fill, palette, x, y, z, ctx));
			}
		}
	}
}

/**
 * A thick 3D line, stepped along its dominant axis so it stays connected — the naive
 * float-rounding version leaves diagonal gaps a player could see through.
 */
export function buildLine(
	brush: Brush,
	palette: Palette,
	from: [number, number, number],
	to: [number, number, number],
	thickness: number,
	fill: Fill,
): void {
	const radius = Math.max(0, Math.floor((Math.max(1, thickness) - 1) / 2));
	const delta = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
	const steps = Math.max(Math.abs(delta[0]!), Math.abs(delta[1]!), Math.abs(delta[2]!));

	const min: [number, number, number] = [
		Math.min(from[0], to[0]) - radius,
		Math.min(from[1], to[1]) - radius,
		Math.min(from[2], to[2]) - radius,
	];
	const max: [number, number, number] = [
		Math.max(from[0], to[0]) + radius,
		Math.max(from[1], to[1]) + radius,
		Math.max(from[2], to[2]) + radius,
	];
	const ctx = { min, max };

	for (let i = 0; i <= steps; i++) {
		const t = steps === 0 ? 0 : i / steps;
		const cx = Math.round(from[0] + delta[0]! * t);
		const cy = Math.round(from[1] + delta[1]! * t);
		const cz = Math.round(from[2] + delta[2]! * t);

		for (let dy = -radius; dy <= radius; dy++) {
			for (let dz = -radius; dz <= radius; dz++) {
				for (let dx = -radius; dx <= radius; dx++) {
					const x = cx + dx;
					const y = cy + dy;
					const z = cz + dz;
					brush.set(x, y, z, fillAt(fill, palette, x, y, z, ctx));
				}
			}
		}
	}
}
