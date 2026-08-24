/**
 * The surface components draw onto, and the transform stack that lets a `group` reposition
 * its children.
 *
 * Transforms are applied per-write rather than by rendering children into a scratch buffer
 * and blitting it. That keeps nested groups free of allocation, and — more importantly —
 * lets a rotation remap each block's own state as it lands, so rotated stairs still point
 * the right way instead of becoming visually scrambled.
 */

import type { BlockRef, VoxelGrid, Vec3 } from '../ir/types.js';
import { AIR_BLOCK, AIR_INDEX, voxelIndex } from '../ir/types.js';
import { canonical, mirror as mirrorBlock, rotate as rotateBlock } from '../registry/registry.js';

export interface Size3 {
	x: number;
	y: number;
	z: number;
}

/**
 * A coordinate frame: where a component's local coordinates land, and how a block's state
 * must change to match. Frames compose, so nesting groups nests transforms.
 */
export interface Frame {
	/** Quarter-turns clockwise around Y already applied. */
	readonly rotation: number;
	readonly mirrorX: boolean;
	readonly mirrorZ: boolean;
	map(x: number, y: number, z: number): Vec3;
	mapBlock(ref: BlockRef): string;
}

export const IDENTITY_FRAME: Frame = {
	rotation: 0,
	mirrorX: false,
	mirrorZ: false,
	map: (x, y, z) => [x, y, z],
	mapBlock: (ref) => canonical(ref),
};

export function translated(parent: Frame, by: Vec3): Frame {
	return {
		rotation: parent.rotation,
		mirrorX: parent.mirrorX,
		mirrorZ: parent.mirrorZ,
		map: (x, y, z) => parent.map(x + by[0], y + by[1], z + by[2]),
		mapBlock: (ref) => parent.mapBlock(ref),
	};
}

/**
 * Rotate clockwise around Y, viewed from above.
 *
 * North (-Z) maps to east (+X), which in these coordinates is `(x, z) -> (-z, x)` about the
 * pivot. Getting the handedness wrong here mirrors every rotated build, so it is pinned by
 * a test rather than left to inspection.
 */
export function rotated(parent: Frame, times: number, pivot: Vec3): Frame {
	const steps = ((times % 4) + 4) % 4;
	if (steps === 0) return parent;

	return {
		rotation: (parent.rotation + steps) % 4,
		mirrorX: parent.mirrorX,
		mirrorZ: parent.mirrorZ,
		map: (x, y, z) => {
			let cx = x;
			let cz = z;
			for (let i = 0; i < steps; i++) {
				const dx = cx - pivot[0];
				const dz = cz - pivot[2];
				cx = pivot[0] - dz;
				cz = pivot[2] + dx;
			}
			return parent.map(cx, y, cz);
		},
		mapBlock: (ref) => parent.mapBlock(rotateBlock(ref, steps)),
	};
}

export function mirrored(parent: Frame, axis: 'x' | 'z', pivot: Vec3): Frame {
	return {
		rotation: parent.rotation,
		mirrorX: axis === 'x' ? !parent.mirrorX : parent.mirrorX,
		mirrorZ: axis === 'z' ? !parent.mirrorZ : parent.mirrorZ,
		map: (x, y, z) =>
			axis === 'x' ? parent.map(2 * pivot[0] - x, y, z) : parent.map(x, y, 2 * pivot[2] - z),
		mapBlock: (ref) => parent.mapBlock(mirrorBlock(ref, axis)),
	};
}

/**
 * A voxel grid under construction.
 *
 * Palette entries are interned on first use and stored canonically, so two spellings of the
 * same blockstate can never occupy two slots — which is what keeps the exported schematic
 * palette honest.
 */
export class VoxelCanvas {
	readonly size: Size3;
	readonly voxels: Uint16Array;

	private readonly palette: string[] = [AIR_BLOCK];
	private readonly paletteIndex = new Map<string, number>([[AIR_BLOCK, AIR_INDEX]]);

	/** Writes that fell outside the build volume, so the caller can warn about clipping. */
	private clipped = 0;

	constructor(size: Size3) {
		this.size = size;
		this.voxels = new Uint16Array(size.x * size.y * size.z);
	}

	/** Intern a block reference, returning its palette index. */
	indexOf(ref: BlockRef): number {
		const key = canonical(ref);
		const existing = this.paletteIndex.get(key);
		if (existing !== undefined) return existing;
		const index = this.palette.length;
		this.palette.push(key);
		this.paletteIndex.set(key, index);
		return index;
	}

	inBounds(x: number, y: number, z: number): boolean {
		return x >= 0 && y >= 0 && z >= 0 && x < this.size.x && y < this.size.y && z < this.size.z;
	}

	set(x: number, y: number, z: number, paletteIdx: number): void {
		if (!this.inBounds(x, y, z)) {
			this.clipped++;
			return;
		}
		this.voxels[voxelIndex(this.size, x, y, z)] = paletteIdx;
	}

	get(x: number, y: number, z: number): number {
		if (!this.inBounds(x, y, z)) return AIR_INDEX;
		return this.voxels[voxelIndex(this.size, x, y, z)]!;
	}

	get clippedWrites(): number {
		return this.clipped;
	}

	resetClipCounter(): void {
		this.clipped = 0;
	}

	countNonAir(): number {
		let n = 0;
		for (let i = 0; i < this.voxels.length; i++) if (this.voxels[i] !== AIR_INDEX) n++;
		return n;
	}

	/**
	 * Drop palette entries nothing references.
	 *
	 * Components that get fully clipped, or whose blocks are painted over by a later
	 * component, would otherwise leave phantom entries in the exported schematic.
	 */
	finish(): VoxelGrid {
		const used = new Uint8Array(this.palette.length);
		used[AIR_INDEX] = 1;
		for (let i = 0; i < this.voxels.length; i++) used[this.voxels[i]!] = 1;

		const remap = new Uint16Array(this.palette.length);
		const compacted: string[] = [];
		for (let i = 0; i < this.palette.length; i++) {
			if (!used[i]) continue;
			remap[i] = compacted.length;
			compacted.push(this.palette[i]!);
		}

		if (compacted.length !== this.palette.length) {
			for (let i = 0; i < this.voxels.length; i++) this.voxels[i] = remap[this.voxels[i]!]!;
		}

		return { size: this.size, palette: compacted, voxels: this.voxels };
	}
}

/**
 * A component's handle on the canvas: local coordinates in, transformed writes out.
 *
 * Components never touch `VoxelCanvas` directly, so a component author cannot accidentally
 * bypass the active group transform.
 */
export class Brush {
	constructor(
		private readonly canvas: VoxelCanvas,
		private readonly frame: Frame,
	) {}

	/** The structure's dimensions, which coordinate expressions resolve against. */
	get size(): Size3 {
		return this.canvas.size;
	}

	set(x: number, y: number, z: number, ref: BlockRef): void {
		const [wx, wy, wz] = this.frame.map(x, y, z);
		this.canvas.set(wx, wy, wz, this.canvas.indexOf(this.frame.mapBlock(ref)));
	}

	/** Carve: writing air is how components cut openings out of earlier geometry. */
	clear(x: number, y: number, z: number): void {
		const [wx, wy, wz] = this.frame.map(x, y, z);
		this.canvas.set(wx, wy, wz, AIR_INDEX);
	}

	getIndex(x: number, y: number, z: number): number {
		const [wx, wy, wz] = this.frame.map(x, y, z);
		return this.canvas.get(wx, wy, wz);
	}

	isEmpty(x: number, y: number, z: number): boolean {
		return this.getIndex(x, y, z) === AIR_INDEX;
	}

	withFrame(frame: Frame): Brush {
		return new Brush(this.canvas, frame);
	}

	get currentFrame(): Frame {
		return this.frame;
	}
}
