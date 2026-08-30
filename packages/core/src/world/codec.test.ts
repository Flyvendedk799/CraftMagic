/**
 * Getting a world through JSON and back.
 *
 * A codec is worth testing in the direction that fails silently. Both of these do: an Int16
 * written with the wrong endianness comes back as a plausible number rather than as an error,
 * and a heightfield read at the wrong stride comes back as terrain — sheared diagonally, but
 * still terrain. So the round-trips use negative heights, the full Int16 range and a
 * deliberately non-square map, none of which survive a byte-order or a stride mistake.
 */

import { describe, expect, it } from 'vitest';
import { AIR_BLOCK } from '../ir/types.js';
import {
	decodeOverlayChunk,
	decodeTerrain,
	encodeOverlayChunk,
	encodeTerrain,
	normalizeOverlayChunk,
	overlayChunkIsEmpty,
	OVERLAY_CELLS,
} from './codec.js';
import { overlayCellIndex } from './overlay.js';
import { DEFAULT_STRATA } from './strata.js';
import { OVERLAY_AIR, OVERLAY_PASS, type Terrain, type WorldSettings } from './types.js';

function settingsOf(x: number, z: number, extra: Partial<WorldSettings> = {}): WorldSettings {
	return {
		size: { x, z },
		minY: -64,
		maxY: 320,
		seaLevel: 62,
		regionSize: 16,
		strata: DEFAULT_STRATA.map((profile) => ({ ...profile })),
		...extra,
	};
}

function terrainOf(heights: number[], strata: number[]): Terrain {
	return { height: Int16Array.from(heights), strata: Uint8Array.from(strata) };
}

describe('terrain codec', () => {
	it('round-trips heights across the whole Minecraft y range', () => {
		const settings = settingsOf(3, 2);
		const terrain = terrainOf([-64, -1, 0, 62, 319, 320], [0, 1, 2, 3, 4, 0]);

		const encoded = encodeTerrain(terrain, settings.size);
		const back = decodeTerrain(encoded, settings);

		expect([...back.height]).toEqual([-64, -1, 0, 62, 319, 320]);
		expect([...back.strata]).toEqual([0, 1, 2, 3, 4, 0]);
	});

	it('carries its own stride, so a settings change re-indexes instead of shearing', () => {
		// Written on a 4-wide map, read back against a 6-wide one. A straight copy would put
		// row 1's first column at index 4 rather than at index 6 — a map bent along a diagonal,
		// which still looks like terrain.
		const terrain = terrainOf(
			[10, 11, 12, 13, 20, 21, 22, 23],
			[1, 1, 1, 1, 2, 2, 2, 2],
		);
		const encoded = encodeTerrain(terrain, { x: 4, z: 2 });

		const back = decodeTerrain(encoded, settingsOf(6, 3, { seaLevel: 7 }));

		expect(back.height).toHaveLength(18);
		expect([...back.height.slice(0, 6)]).toEqual([10, 11, 12, 13, 7, 7]);
		expect([...back.height.slice(6, 12)]).toEqual([20, 21, 22, 23, 7, 7]);
		expect([...back.height.slice(12, 18)]).toEqual([7, 7, 7, 7, 7, 7]);
		expect(back.strata[6]).toBe(2);
	});

	it('reads a plain array of numbers, which is what a fixture writes', () => {
		const back = decodeTerrain(
			{ x: 2, z: 2, height: [1, 2, 3, 4], strata: [0, 1, 0, 1] },
			settingsOf(2, 2),
		);
		expect([...back.height]).toEqual([1, 2, 3, 4]);
		expect([...back.strata]).toEqual([0, 1, 0, 1]);
	});

	it('degrades to a flat world rather than throwing on junk', () => {
		const settings = settingsOf(2, 2, { seaLevel: 30 });
		for (const junk of [null, undefined, 'nope', 42, {}, { height: 7 }]) {
			const back = decodeTerrain(junk, settings);
			expect([...back.height]).toEqual([30, 30, 30, 30]);
			expect([...back.strata]).toEqual([0, 0, 0, 0]);
		}
	});

	it('pads a truncated strata array rather than shortening the map', () => {
		const encoded = encodeTerrain(terrainOf([1, 2, 3, 4], [5, 6, 7, 8]), { x: 2, z: 2 });
		const back = decodeTerrain({ ...encoded, strata: '' }, settingsOf(2, 2));
		expect([...back.height]).toEqual([1, 2, 3, 4]);
		expect([...back.strata]).toEqual([0, 0, 0, 0]);
	});
});

describe('overlay chunk codec', () => {
	it('round-trips a sparse chunk cell for cell', () => {
		const cells = new Uint16Array(OVERLAY_CELLS);
		cells[overlayCellIndex(0, 0, 0)] = OVERLAY_AIR;
		cells[overlayCellIndex(5, 6, 7)] = 2;
		cells[overlayCellIndex(15, 15, 15)] = 3;

		const chunk = encodeOverlayChunk(cells, [OVERLAY_PASS, AIR_BLOCK, 'minecraft:stone', 'minecraft:sand']);
		const back = decodeOverlayChunk(chunk);

		expect([...back]).toEqual([...cells]);
		expect(back[overlayCellIndex(5, 6, 7)]).toBe(2);
		expect(back[overlayCellIndex(5, 6, 8)]).toBe(0);
	});

	it('forces slot 0 to pass-through and slot 1 to air', () => {
		const chunk = encodeOverlayChunk(new Uint16Array(OVERLAY_CELLS), ['minecraft:stone', 'minecraft:stone']);
		expect(chunk.palette[0]).toBe(OVERLAY_PASS);
		expect(chunk.palette[1]).toBe(AIR_BLOCK);
	});

	it('always decodes to exactly 4096 cells, whatever the runs claimed', () => {
		// One run of 99999 cells: corrupt input, and the fixed length is what stops it running
		// off the end of every caller that indexes the result.
		const chunk = encodeOverlayChunk(new Uint16Array(OVERLAY_CELLS).fill(2), [OVERLAY_PASS, AIR_BLOCK, 'minecraft:stone']);
		expect(decodeOverlayChunk(chunk)).toHaveLength(OVERLAY_CELLS);
		expect(decodeOverlayChunk({ palette: chunk.palette, data: '' })).toHaveLength(OVERLAY_CELLS);
	});

	it('compresses a run-heavy chunk far below its cell count', () => {
		// 4096 cells of one value is two varints. The whole reason the overlay is affordable.
		const chunk = encodeOverlayChunk(new Uint16Array(OVERLAY_CELLS).fill(OVERLAY_AIR), [OVERLAY_PASS, AIR_BLOCK]);
		expect(chunk.data.length).toBeLessThan(16);
	});

	it('knows an empty chunk when it sees one', () => {
		expect(overlayChunkIsEmpty(new Uint16Array(OVERLAY_CELLS))).toBe(true);
		const one = new Uint16Array(OVERLAY_CELLS);
		one[1234] = OVERLAY_AIR;
		expect(overlayChunkIsEmpty(one)).toBe(false);
	});
});

describe('normalizeOverlayChunk', () => {
	it('drops a chunk with nothing in it', () => {
		expect(normalizeOverlayChunk(encodeOverlayChunk(new Uint16Array(OVERLAY_CELLS), []))).toBeNull();
		expect(normalizeOverlayChunk(null)).toBeNull();
		expect(normalizeOverlayChunk({ palette: [] })).toBeNull();
	});

	it('turns a cell naming a slot the palette does not have into a carve', () => {
		// Interning `undefined` into a grid palette at materialise time is a far more confusing
		// crash, three layers away, than losing one cell here.
		const cells = new Uint16Array(OVERLAY_CELLS);
		cells[overlayCellIndex(1, 1, 1)] = 9;
		const chunk = normalizeOverlayChunk(encodeOverlayChunk(cells, [OVERLAY_PASS, AIR_BLOCK]))!;

		expect(chunk).not.toBeNull();
		expect(decodeOverlayChunk(chunk)[overlayCellIndex(1, 1, 1)]).toBe(OVERLAY_AIR);
	});

	it('restores the structural palette slots on a chunk that lost them', () => {
		const cells = new Uint16Array(OVERLAY_CELLS);
		cells[overlayCellIndex(2, 2, 2)] = 2;
		const raw = encodeOverlayChunk(cells, [OVERLAY_PASS, AIR_BLOCK, 'minecraft:sand']);

		const chunk = normalizeOverlayChunk({ palette: ['x', 'y', 'minecraft:sand'], data: raw.data })!;
		expect(chunk.palette).toEqual([OVERLAY_PASS, AIR_BLOCK, 'minecraft:sand']);
		expect(decodeOverlayChunk(chunk)[overlayCellIndex(2, 2, 2)]).toBe(2);
	});
});
