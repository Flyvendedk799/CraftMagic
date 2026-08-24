/**
 * Palette roles and fill patterns.
 *
 * Components never name a block directly; they name a *role* ("wall_primary"), and the
 * program's palette maps roles to blocks. That indirection is what lets a whole structure
 * be re-skinned — swap the palette, keep the geometry.
 */

import type { BlockRef, Fill, WeightedBlockRef } from '../ir/types.js';
import { AIR_BLOCK } from '../ir/types.js';

export class Palette {
	private readonly entries: Map<string, BlockRef | WeightedBlockRef[]>;
	/** Roles a component asked for that the program never defined. */
	readonly missing = new Set<string>();

	constructor(source: Record<string, BlockRef | WeightedBlockRef[]>) {
		this.entries = new Map(Object.entries(source));
	}

	has(role: string): boolean {
		return this.entries.has(role);
	}

	/**
	 * Resolve a role to a concrete block.
	 *
	 * Position is part of the signature because weighted roles must be *deterministic*:
	 * the same program has to expand to the same build every time, or a stored voxel grid
	 * would stop matching its own program and resizing would visibly reshuffle textures.
	 */
	resolve(role: string, x: number, y: number, z: number): BlockRef {
		// A role may name a block outright, which keeps one-off details readable.
		if (!this.entries.has(role)) {
			if (role.includes(':')) return role;
			this.missing.add(role);
			return AIR_BLOCK;
		}

		const entry = this.entries.get(role)!;
		if (typeof entry === 'string') return entry;
		if (entry.length === 0) {
			this.missing.add(role);
			return AIR_BLOCK;
		}

		const total = entry.reduce((sum, e) => sum + Math.max(0, e.weight), 0);
		if (total <= 0) return entry[0]!.block;

		let pick = (hash3(x, y, z, 0) % 100000) / 100000 * total;
		for (const option of entry) {
			pick -= Math.max(0, option.weight);
			if (pick <= 0) return option.block;
		}
		return entry[entry.length - 1]!.block;
	}
}

/** Integer hash. Any stable mixing function works; this one is cheap and well-spread. */
function hash3(x: number, y: number, z: number, seed: number): number {
	let h = seed | 0;
	h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
	h = Math.imul(h ^ (y | 0), 0x85ebca6b);
	h = Math.imul(h ^ (z | 0), 0xc2b2ae35);
	h ^= h >>> 15;
	return h >>> 0;
}

export interface FillContext {
	/** Component-local bounds, so `border` knows which cells are on the edge. */
	min: [number, number, number];
	max: [number, number, number];
}

/** Pick the block a fill produces at one position. */
export function fillAt(
	fill: Fill,
	palette: Palette,
	x: number,
	y: number,
	z: number,
	ctx: FillContext,
): BlockRef {
	switch (fill.type) {
		case 'solid':
			return palette.resolve(fill.role, x, y, z);

		case 'checker': {
			const plane = fill.plane ?? 'xz';
			const parity =
				plane === 'xz' ? (x + z) & 1 : plane === 'xy' ? (x + y) & 1 : (y + z) & 1;
			return palette.resolve(parity === 0 ? fill.a : fill.b, x, y, z);
		}

		case 'stripes': {
			if (fill.roles.length === 0) return AIR_BLOCK;
			const period = Math.max(1, fill.period ?? 1);
			const coord = fill.axis === 'x' ? x : fill.axis === 'y' ? y : z;
			// Floor division keeps stripes continuous across the origin, where a plain
			// modulo would mirror the pattern into negative coordinates.
			const band = Math.floor(coord / period);
			const index = ((band % fill.roles.length) + fill.roles.length) % fill.roles.length;
			return palette.resolve(fill.roles[index]!, x, y, z);
		}

		case 'noise': {
			if (fill.roles.length === 0) return AIR_BLOCK;
			const total = fill.roles.reduce((sum, r) => sum + Math.max(0, r.weight), 0);
			if (total <= 0) return palette.resolve(fill.roles[0]!.role, x, y, z);
			let pick = ((hash3(x, y, z, fill.seed ?? 0) % 100000) / 100000) * total;
			for (const option of fill.roles) {
				pick -= Math.max(0, option.weight);
				if (pick <= 0) return palette.resolve(option.role, x, y, z);
			}
			return palette.resolve(fill.roles[fill.roles.length - 1]!.role, x, y, z);
		}

		case 'border': {
			const onEdge =
				x === ctx.min[0] || x === ctx.max[0] ||
				y === ctx.min[1] || y === ctx.max[1] ||
				z === ctx.min[2] || z === ctx.max[2];
			return palette.resolve(onEdge ? fill.edge : fill.inner, x, y, z);
		}
	}
}

/** Roles a fill references, for validation before anything is drawn. */
export function rolesOf(fill: Fill): string[] {
	switch (fill.type) {
		case 'solid':
			return [fill.role];
		case 'checker':
			return [fill.a, fill.b];
		case 'stripes':
			return fill.roles;
		case 'noise':
			return fill.roles.map((r) => r.role);
		case 'border':
			return [fill.edge, fill.inner];
	}
}
