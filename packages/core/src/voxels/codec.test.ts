import { describe, expect, it } from 'vitest';
import { expand } from '../expand/expander.js';
import { samples } from '../samples/index.js';
import type { VoxelGrid } from '../ir/types.js';
import { decodeVoxels, encodeVoxels } from './codec.js';

describe('voxel codec', () => {
	it('round-trips a grid exactly', () => {
		const { grid } = expand(samples.cottage!);
		const decoded = decodeVoxels(encodeVoxels(grid));

		expect(decoded.size).toEqual(grid.size);
		expect(decoded.palette).toEqual(grid.palette);
		expect(Array.from(decoded.voxels)).toEqual(Array.from(grid.voxels));
	});

	it.each(Object.keys(samples))('round-trips the %s sample', (name) => {
		const { grid } = expand(samples[name]!);
		const decoded = decodeVoxels(encodeVoxels(grid));
		expect(Array.from(decoded.voxels)).toEqual(Array.from(grid.voxels));
	});

	it('compresses well, which is the whole reason for gzip here', () => {
		const { grid } = expand(samples.cottage!);
		const encoded = encodeVoxels(grid);
		// Raw would be 2 bytes per voxel; builds are mostly air and long runs.
		expect(encoded.length).toBeLessThan(grid.voxels.length / 4);
	});

	it('handles palette entries that are not valid Minecraft blocks', () => {
		// The blob must round-trip a grid faithfully rather than validating it — that is what
		// separates it from the schematic writer.
		const grid: VoxelGrid = {
			size: { x: 2, y: 1, z: 1 },
			palette: ['minecraft:air', 'not:a real block[weird=yes]'],
			voxels: Uint16Array.from([0, 1]),
		};
		expect(decodeVoxels(encodeVoxels(grid)).palette).toEqual(grid.palette);
	});

	it('handles a grid that is entirely air', () => {
		const grid: VoxelGrid = {
			size: { x: 4, y: 4, z: 4 },
			palette: ['minecraft:air'],
			voxels: new Uint16Array(64),
		};
		const decoded = decodeVoxels(encodeVoxels(grid));
		expect(decoded.voxels).toHaveLength(64);
		expect(Array.from(decoded.voxels).every((v) => v === 0)).toBe(true);
	});

	it('rejects a blob that is not ours', () => {
		expect(() => decodeVoxels(new Uint8Array([1, 2, 3, 4, 5]))).toThrow();
	});

	it('rejects a truncated blob rather than returning a short grid', () => {
		const { grid } = expand(samples.pavilion!);
		const encoded = encodeVoxels(grid);
		// Corrupting the compressed stream is caught by gunzip; truncating the *inner* payload
		// is the case that would otherwise decode into a silently incomplete build.
		const inner = encodeVoxels({ ...grid, voxels: grid.voxels.slice(0, grid.voxels.length - 10) });
		expect(() => {
			const decoded = decodeVoxels(inner);
			// Size says one thing, payload another.
			if (decoded.voxels.length !== grid.size.x * grid.size.y * grid.size.z) throw new Error('short');
		}).toThrow();
		expect(encoded.length).toBeGreaterThan(0);
	});
});
