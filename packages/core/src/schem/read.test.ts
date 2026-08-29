import { describe, expect, it } from 'vitest';
import { expand } from '../expand/expander.js';
import { samples } from '../samples/index.js';
import { readSchematic } from './read.js';
import { writeSchematic } from './write.js';

describe('readSchematic', () => {
	it('round-trips the cottage through write and read', () => {
		const { grid } = expand(samples.cottage!);
		const back = readSchematic(writeSchematic(grid, { name: 'Cottage' }));

		expect(back.size).toEqual(grid.size);
		expect(back.palette).toEqual(grid.palette);
		expect(back.voxels).toEqual(grid.voxels);
	});

	it('round-trips a grid whose palette needs more than one varint byte', () => {
		// 200 distinct palette entries pushes ids past 127, exercising multi-byte varints.
		const palette = ['minecraft:air'];
		for (let i = 1; i < 200; i++) palette.push(`minecraft:test_block_${i}`);
		const size = { x: 20, y: 1, z: 10 };
		const voxels = new Uint16Array(200);
		for (let i = 0; i < 200; i++) voxels[i] = i % palette.length;
		const back = readSchematic(writeSchematic({ size, palette, voxels }));

		expect(back.voxels).toEqual(voxels);
		expect(back.palette[199]).toBe('minecraft:test_block_199');
	});

	it('moves air to slot 0 when a foreign schematic numbers it elsewhere', () => {
		// Write a grid where slot 0 is stone and air is slot 1 — legal Sponge, illegal for
		// our editor, whose every tool assumes voxel 0 is air.
		const size = { x: 2, y: 1, z: 1 };
		const foreign = writeSchematic({
			size,
			palette: ['minecraft:stone', 'minecraft:air'],
			voxels: Uint16Array.from([0, 1]),
		});
		const back = readSchematic(foreign);

		expect(back.palette[0]).toBe('minecraft:air');
		const stoneAt = back.voxels[0]!;
		expect(back.palette[stoneAt]).toBe('minecraft:stone');
		expect(back.voxels[1]).toBe(0);
	});

	it('refuses junk with a message, not a hang', () => {
		expect(() => readSchematic(new Uint8Array([1, 2, 3]))).toThrow();
		expect(() => readSchematic(new Uint8Array(0))).toThrow();
	});
});
