import { gunzipSync } from 'fflate';
import nbt from 'prismarine-nbt';
import { describe, expect, it } from 'vitest';
import { expand } from '../expand/expander.js';
import { cottage, tower } from '../samples/index.js';
import type { VoxelGrid } from '../ir/types.js';
import { voxelIndex } from '../ir/types.js';
import { DATA_VERSION } from '../registry/registry.js';
import { schematicFilename, writeSchematic } from './write.js';
import { writeVarInt } from './nbt-writer.js';

/**
 * Parse our own output with a third-party NBT reader. Writing and reading with the same
 * hand-rolled code would happily agree on a format nothing else can open.
 */
async function parse(bytes: Uint8Array) {
	const { parsed } = await nbt.parse(Buffer.from(gunzipSync(bytes)));
	return nbt.simplify(parsed) as Record<string, unknown>;
}

function decodeVarInts(data: number[] | Buffer | Uint8Array): number[] {
	const bytes = Uint8Array.from(data as ArrayLike<number>);
	const out: number[] = [];
	let value = 0;
	let shift = 0;
	for (const raw of bytes) {
		// NBT byte arrays are signed; mask back to the unsigned byte we wrote.
		const b = raw & 0xff;
		value |= (b & 0x7f) << shift;
		if ((b & 0x80) === 0) {
			out.push(value >>> 0);
			value = 0;
			shift = 0;
		} else {
			shift += 7;
		}
	}
	return out;
}

const tinyGrid: VoxelGrid = {
	size: { x: 2, y: 2, z: 2 },
	palette: ['minecraft:air', 'minecraft:stone', 'minecraft:oak_planks'],
	voxels: Uint16Array.from([1, 2, 0, 1, 2, 0, 1, 2]),
};

describe('writeSchematic', () => {
	it('produces gzipped NBT a real parser can read', async () => {
		const parsed = await parse(writeSchematic(tinyGrid));
		expect(parsed.Version).toBe(2);
		expect(parsed.DataVersion).toBe(DATA_VERSION);
		expect(parsed.Width).toBe(2);
		expect(parsed.Height).toBe(2);
		expect(parsed.Length).toBe(2);
	});

	it('writes the palette as blockstate string -> index', async () => {
		const parsed = await parse(writeSchematic(tinyGrid));
		expect(parsed.Palette).toEqual({
			'minecraft:air': 0,
			'minecraft:stone': 1,
			'minecraft:oak_planks': 2,
		});
		expect(parsed.PaletteMax).toBe(3);
	});

	it('round-trips block data in the same order the grid stores it', async () => {
		const parsed = await parse(writeSchematic(tinyGrid));
		expect(decodeVarInts(parsed.BlockData as number[])).toEqual(Array.from(tinyGrid.voxels));
	});

	it('carries metadata', async () => {
		const parsed = await parse(writeSchematic(tinyGrid, { name: 'My House', author: 'Tobias' }));
		expect(parsed.Metadata).toMatchObject({ Name: 'My House', Author: 'Tobias' });
	});

	it('refuses dimensions the format cannot express', () => {
		const huge: VoxelGrid = { size: { x: 40000, y: 1, z: 1 }, palette: ['minecraft:air'], voxels: new Uint16Array(1) };
		expect(() => writeSchematic(huge)).toThrow(/exceed/);
	});
});

describe('varint encoding', () => {
	it('encodes single-byte values', () => {
		const out: number[] = [];
		writeVarInt(out, 0);
		writeVarInt(out, 127);
		expect(out).toEqual([0, 127]);
	});

	it('adds a continuation byte past 127 — the boundary naive encoders get wrong', () => {
		const out: number[] = [];
		writeVarInt(out, 128);
		expect(out).toEqual([0x80, 0x01]);
	});

	it('round-trips values spanning one, two and three bytes', () => {
		const values = [0, 1, 127, 128, 255, 300, 16383, 16384, 65535];
		const out: number[] = [];
		for (const v of values) writeVarInt(out, v);
		expect(decodeVarInts(out)).toEqual(values);
	});
});

describe('schematics of real builds', () => {
	it('round-trips the cottage block for block', async () => {
		const { grid } = expand(cottage);
		const parsed = await parse(writeSchematic(grid, { name: cottage.meta.name }));

		expect(parsed.Width).toBe(grid.size.x);
		expect(parsed.Height).toBe(grid.size.y);
		expect(parsed.Length).toBe(grid.size.z);

		const decoded = decodeVarInts(parsed.BlockData as number[]);
		expect(decoded).toHaveLength(grid.voxels.length);
		expect(decoded).toEqual(Array.from(grid.voxels));

		// Spot-check that a stateful block survives the trip via the palette indirection.
		// Located by searching rather than by hardcoded coordinates, so re-arranging the
		// sample cannot turn a real regression into a passing test (or vice versa).
		const palette = parsed.Palette as Record<string, number>;
		const doorEntry = Object.entries(palette).find(([state]) => state.includes('oak_door[') && state.includes('half=lower'));
		expect(doorEntry, 'cottage should contain a door').toBeDefined();
		expect(decoded).toContain(doorEntry![1]);
	});

	it('handles a palette crossing the 128-entry varint boundary', async () => {
		// Synthesise 200 distinct entries so indices need two-byte varints.
		const palette = ['minecraft:air'];
		for (let i = 0; i < 199; i++) palette.push(`minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false,test=${i}]`);
		const voxels = new Uint16Array(200);
		for (let i = 0; i < 200; i++) voxels[i] = i;
		const grid: VoxelGrid = { size: { x: 200, y: 1, z: 1 }, palette, voxels };

		const parsed = await parse(writeSchematic(grid));
		expect(decodeVarInts(parsed.BlockData as number[])).toEqual(Array.from(voxels));
	});

	it('compresses a large build to something worth downloading', () => {
		const { grid } = expand(tower);
		const bytes = writeSchematic(grid);
		// Highly repetitive voxel data; gzip should crush it well below one byte per voxel.
		expect(bytes.length).toBeLessThan(grid.voxels.length);
	});
});

describe('schematicFilename', () => {
	it('slugifies a build name', () => {
		expect(schematicFilename('Oak Cottage')).toBe('oak-cottage.schem');
		expect(schematicFilename('  Tobias’ Tower!  ')).toBe('tobias-tower.schem');
	});

	it('falls back when a name has nothing usable', () => {
		expect(schematicFilename('***')).toBe('build.schem');
	});
});
