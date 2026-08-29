import { describe, expect, it } from 'vitest';
import { expand } from '../expand/expander.js';
import { samples } from '../samples/index.js';
import { voxelIndex, type EditOp, type VoxelGrid } from '../ir/types.js';
import { EditOverlay } from './editLayer.js';

function opFor(grid: VoxelGrid, cells: [number, number, number, number][]): EditOp {
	return {
		indices: Uint32Array.from(cells.map(([x, y, z]) => voxelIndex(grid.size, x, y, z))),
		before: Uint16Array.from(cells.map(([x, y, z]) => grid.voxels[voxelIndex(grid.size, x, y, z)]!)),
		after: Uint16Array.from(cells.map(([, , , v]) => v)),
	};
}

describe('EditOverlay', () => {
	it('survives a re-expansion: same edits, fresh grid', () => {
		const first = expand(samples.cottage!);
		const overlay = new EditOverlay();

		// Place a glowstone (grows the palette) and carve a wall block out.
		first.grid.palette.push('minecraft:glowstone');
		const glow = first.grid.palette.length - 1;
		const op = opFor(first.grid, [
			[2, 3, 2, glow],
			[0, 1, 0, 0],
		]);
		overlay.recordOp(first.grid, op);

		// A brand-new expansion of the same program — different arrays, same shape.
		const second = expand(samples.cottage!);
		const result = overlay.composite(second.grid);

		expect(result.applied).toBe(2);
		expect(result.outside).toBe(0);
		expect(result.paletteGrew).toBe(true);
		const placed = second.grid.palette[second.grid.voxels[voxelIndex(second.grid.size, 2, 3, 2)]!];
		expect(placed).toBe('minecraft:glowstone');
		expect(second.grid.voxels[voxelIndex(second.grid.size, 0, 1, 0)]).toBe(0);
	});

	it('keeps one entry per cell no matter how often it is repainted', () => {
		const { grid } = expand(samples.cottage!);
		const overlay = new EditOverlay();
		for (let i = 0; i < 5; i++) overlay.recordOp(grid, opFor(grid, [[1, 1, 1, 0]]));
		expect(overlay.size).toBe(1);
	});

	it('deletes an entry that lands back on the pristine value', () => {
		const { grid } = expand(samples.cottage!);
		const pristine = grid.voxels.slice();
		const solid = findSolid(grid);
		const original = grid.voxels[voxelIndex(grid.size, ...solid)]!;
		const overlay = new EditOverlay();

		// Carve it, then undo the carve: no edit should remain.
		overlay.recordOp(grid, opFor(grid, [[...solid, 0]]), pristine);
		expect(overlay.size).toBe(1);
		overlay.recordRevert(grid, opFor(grid, [[...solid, 0]]), pristine);
		expect(overlay.size).toBe(0);

		// Painting the original block back by hand is also not an edit.
		overlay.recordOp(grid, opFor(grid, [[...solid, original]]), pristine);
		expect(overlay.size).toBe(0);
	});

	it('counts entries outside a smaller grid instead of dropping them', () => {
		const { grid } = expand(samples.cottage!);
		grid.palette.push('minecraft:glowstone');
		const glow = grid.palette.length - 1;
		const overlay = new EditOverlay();
		overlay.recordOp(
			grid,
			opFor(grid, [
				[1, 1, 1, glow],
				[grid.size.x - 1, 1, 1, glow],
			]),
		);

		const smaller: VoxelGrid = {
			size: { x: 4, y: grid.size.y, z: grid.size.z },
			palette: ['minecraft:air'],
			voxels: new Uint16Array(4 * grid.size.y * grid.size.z),
		};
		const result = overlay.composite(smaller);
		expect(result.applied).toBe(1);
		expect(result.outside).toBe(1);
		expect(overlay.size).toBe(2);
		expect(overlay.countOutside(smaller.size)).toBe(1);
	});

	it('round-trips through JSON', () => {
		const { grid } = expand(samples.cottage!);
		grid.palette.push('minecraft:glowstone');
		const glow = grid.palette.length - 1;
		const overlay = new EditOverlay();
		overlay.recordOp(
			grid,
			opFor(grid, [
				[2, 3, 2, glow],
				[0, 1, 0, 0],
			]),
		);

		const restored = EditOverlay.fromJSON(JSON.parse(JSON.stringify(overlay.toJSON())));
		expect(restored.size).toBe(2);

		const fresh = expand(samples.cottage!);
		restored.composite(fresh.grid);
		const placed = fresh.grid.palette[fresh.grid.voxels[voxelIndex(fresh.grid.size, 2, 3, 2)]!];
		expect(placed).toBe('minecraft:glowstone');
		expect(fresh.grid.voxels[voxelIndex(fresh.grid.size, 0, 1, 0)]).toBe(0);
	});

	it('yields an empty overlay for junk instead of throwing', () => {
		expect(EditOverlay.fromJSON(null).size).toBe(0);
		expect(EditOverlay.fromJSON('nonsense').size).toBe(0);
		expect(EditOverlay.fromJSON({ version: 2, palette: [], positions: [], blocks: [] }).size).toBe(0);
		expect(
			EditOverlay.fromJSON({ version: 1, palette: ['minecraft:air'], positions: [1, 2], blocks: [0] }).size,
		).toBe(0);
	});

	it('recovers the layer from an old detached save via diff', () => {
		// The lazy migration: an old save is (program, edited voxels). Expand the program,
		// diff, and the edits come back as a layer.
		const pristine = expand(samples.cottage!);
		const edited = expand(samples.cottage!);
		edited.grid.palette.push('minecraft:glowstone');
		const glow = edited.grid.palette.length - 1;
		const air = findAir(edited.grid);
		const solid = findSolid(edited.grid);
		edited.grid.voxels[voxelIndex(edited.grid.size, air[0], air[1], air[2])] = glow;
		edited.grid.voxels[voxelIndex(edited.grid.size, solid[0], solid[1], solid[2])] = 0;

		const overlay = EditOverlay.fromDiff(pristine.grid, edited.grid);
		expect(overlay).not.toBeNull();
		expect(overlay!.size).toBe(2);

		const fresh = expand(samples.cottage!);
		const result = overlay!.composite(fresh.grid);
		expect(result.applied).toBe(2);
		expect(fresh.grid.voxels).toEqual(edited.grid.voxels.subarray(0, fresh.grid.voxels.length));
	});

	it('refuses a diff across different sizes', () => {
		const a = expand(samples.cottage!);
		const smaller: VoxelGrid = {
			size: { x: 4, y: 4, z: 4 },
			palette: ['minecraft:air'],
			voxels: new Uint16Array(64),
		};
		expect(EditOverlay.fromDiff(a.grid, smaller)).toBeNull();
	});

	it('tracks the block-count delta through place and carve', () => {
		const { grid, blockCount } = expand(samples.cottage!);
		grid.palette.push('minecraft:glowstone');
		const glow = grid.palette.length - 1;
		const overlay = new EditOverlay();
		// One placement into air, one carve of an existing block.
		const air = findAir(grid);
		const solid = findSolid(grid);
		overlay.recordOp(grid, opFor(grid, [[air[0], air[1], air[2], glow]]));
		overlay.recordOp(grid, opFor(grid, [[solid[0], solid[1], solid[2], 0]]));

		const fresh = expand(samples.cottage!);
		const result = overlay.composite(fresh.grid);
		expect(result.delta).toBe(0); // +1 placed, -1 carved
		let count = 0;
		for (const v of fresh.grid.voxels) if (v !== 0) count++;
		expect(count).toBe(blockCount + result.delta);
	});
});

function findAir(grid: VoxelGrid): [number, number, number] {
	for (let y = 0; y < grid.size.y; y++) {
		for (let z = 0; z < grid.size.z; z++) {
			for (let x = 0; x < grid.size.x; x++) {
				if (grid.voxels[voxelIndex(grid.size, x, y, z)] === 0) return [x, y, z];
			}
		}
	}
	throw new Error('no air found');
}

function findSolid(grid: VoxelGrid): [number, number, number] {
	for (let y = 0; y < grid.size.y; y++) {
		for (let z = 0; z < grid.size.z; z++) {
			for (let x = 0; x < grid.size.x; x++) {
				if (grid.voxels[voxelIndex(grid.size, x, y, z)] !== 0) return [x, y, z];
			}
		}
	}
	throw new Error('no block found');
}
