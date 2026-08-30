/**
 * The sparse overlay.
 *
 * Everything here is about the tri-state holding. "Nothing said" and "air" are different
 * answers, and the moment they collapse into one the layer stops being able to describe a cave
 * — a carve either fills back in or takes the whole chunk of terrain with it. So the states are
 * asserted as three distinct results, not as truthiness.
 *
 * The other trap is negative coordinates. `%` on a negative number is negative in JavaScript,
 * so an un-floored chunk index or cell index writes into a neighbouring chunk. That is only
 * ever reachable at the west and north edges of a map, which is exactly where nobody tests.
 */

import { describe, expect, it } from 'vitest';
import { AIR_BLOCK } from '../ir/types.js';
import { decodeOverlayChunk, OVERLAY_CELLS } from './codec.js';
import {
	emptyOverlayChunk,
	overlayCellCount,
	overlayCellIndex,
	overlayChunkBox,
	overlayChunkFor,
	overlayChunkKey,
	OverlayEditor,
	overlayGet,
	overlaySet,
	parseOverlayChunkKey,
} from './overlay.js';
import { OVERLAY_AIR, OVERLAY_CHUNK, OVERLAY_NONE, OVERLAY_PASS, type Overlay } from './types.js';

describe('overlay addressing', () => {
	it('floors, so a coordinate west of the origin goes to chunk -1', () => {
		expect(overlayChunkFor(0, 0, 0)).toEqual({ cx: 0, cy: 0, cz: 0 });
		expect(overlayChunkFor(15, 15, 15)).toEqual({ cx: 0, cy: 0, cz: 0 });
		expect(overlayChunkFor(16, 16, 16)).toEqual({ cx: 1, cy: 1, cz: 1 });
		expect(overlayChunkFor(-1, -1, -1)).toEqual({ cx: -1, cy: -1, cz: -1 });
		expect(overlayChunkFor(-16, -17, -33)).toEqual({ cx: -1, cy: -2, cz: -3 });
	});

	it('indexes cells YZX, the same order as a grid and a prefab', () => {
		// x + z*16 + y*256, spelled out.
		expect(overlayCellIndex(0, 0, 0)).toBe(0);
		expect(overlayCellIndex(1, 0, 0)).toBe(1);
		expect(overlayCellIndex(0, 0, 1)).toBe(16);
		expect(overlayCellIndex(0, 1, 0)).toBe(256);
		expect(overlayCellIndex(1, 2, 3)).toBe(1 + 3 * 16 + 2 * 256);
		expect(overlayCellIndex(15, 15, 15)).toBe(OVERLAY_CELLS - 1);
	});

	it('wraps a negative coordinate into its own chunk, not out of it', () => {
		// -1 is the last cell of chunk -1, not index -1 of chunk 0.
		expect(overlayCellIndex(-1, 0, 0)).toBe(15);
		expect(overlayCellIndex(-16, 0, 0)).toBe(0);
		expect(overlayCellIndex(0, -1, 0)).toBe(15 * 256);
	});

	it('round-trips a key', () => {
		expect(overlayChunkKey(1, -2, 3)).toBe('1,-2,3');
		expect(parseOverlayChunkKey('1,-2,3')).toEqual({ cx: 1, cy: -2, cz: 3 });
		expect(parseOverlayChunkKey('1,2')).toBeNull();
		expect(parseOverlayChunkKey('a,b,c')).toBeNull();
		expect(parseOverlayChunkKey('1,2.5,3')).toBeNull();
	});

	it('reports a chunk box in inclusive world blocks', () => {
		expect(overlayChunkBox(0, 0, 0)).toEqual({
			minX: 0, minY: 0, minZ: 0, maxX: 15, maxY: 15, maxZ: 15,
		});
		expect(overlayChunkBox(-1, 2, 3)).toEqual({
			minX: -16, minY: 32, minZ: 48, maxX: -1, maxY: 47, maxZ: 63,
		});
	});
});

describe('the tri-state', () => {
	it('tells "nothing said" from "air" from "a block"', () => {
		const overlay: Overlay = {};

		expect(overlayGet(overlay, 3, 4, 5)).toBeNull();

		overlaySet(overlay, 3, 4, 5, AIR_BLOCK);
		expect(overlayGet(overlay, 3, 4, 5)).toBe(AIR_BLOCK);
		// The neighbour is still pass-through: a carve is one cell, not a chunk.
		expect(overlayGet(overlay, 4, 4, 5)).toBeNull();

		overlaySet(overlay, 4, 4, 5, 'minecraft:stone');
		expect(overlayGet(overlay, 4, 4, 5)).toBe('minecraft:stone');
		expect(overlayGet(overlay, 3, 4, 5)).toBe(AIR_BLOCK);
	});

	it('keeps the two structural slots at 0 and 1', () => {
		const overlay: Overlay = {};
		overlaySet(overlay, 1, 1, 1, 'minecraft:bricks');
		const chunk = overlay[overlayChunkKey(0, 0, 0)]!;

		expect(chunk.palette[0]).toBe(OVERLAY_PASS);
		expect(chunk.palette[1]).toBe(AIR_BLOCK);
		expect(chunk.palette[2]).toBe('minecraft:bricks');

		const cells = decodeOverlayChunk(chunk);
		expect(cells[overlayCellIndex(1, 1, 1)]).toBe(2);
		expect(cells[overlayCellIndex(2, 1, 1)]).toBe(OVERLAY_NONE);
	});

	it('drops a chunk that has been cleared back to nothing', () => {
		const overlay: Overlay = {};
		overlaySet(overlay, 2, 2, 2, AIR_BLOCK);
		expect(Object.keys(overlay)).toEqual(['0,0,0']);

		overlaySet(overlay, 2, 2, 2, null);
		// An empty chunk is not stored: sparsity is what makes the layer affordable, and a
		// carve that was undone must not leave a permanent 4096-cell hole in the record.
		expect(Object.keys(overlay)).toEqual([]);
		expect(overlayGet(overlay, 2, 2, 2)).toBeNull();
	});

	it('carves at a negative coordinate without touching the chunk next door', () => {
		const overlay: Overlay = {};
		overlaySet(overlay, -1, 5, -1, AIR_BLOCK);

		expect(Object.keys(overlay)).toEqual(['-1,0,-1']);
		expect(overlayGet(overlay, -1, 5, -1)).toBe(AIR_BLOCK);
		expect(overlayGet(overlay, 15, 5, 15)).toBeNull();
		expect(overlayGet(overlay, 0, 5, 0)).toBeNull();
	});
});

describe('OverlayEditor', () => {
	it('leaves the source alone until commit', () => {
		const source: Overlay = {};
		const editor = new OverlayEditor(source);
		editor.carve(1, 1, 1);

		expect(Object.keys(source)).toEqual([]);
		expect(editor.get(1, 1, 1)).toBe(AIR_BLOCK);

		const committed = editor.commit();
		expect(Object.keys(source)).toEqual([]);
		expect(overlayGet(committed, 1, 1, 1)).toBe(AIR_BLOCK);
	});

	it('opens each chunk once however many cells of it are written', () => {
		const editor = new OverlayEditor();
		// A box spanning x 14..17 crosses one chunk boundary: two chunks, 4x1x1 cells.
		const written = editor.fill({ x: 14, y: 1, z: 1 }, { x: 17, y: 1, z: 1 }, AIR_BLOCK);

		expect(written).toBe(4);
		expect(editor.touched).toBe(2);

		const overlay = editor.commit();
		expect(Object.keys(overlay).sort()).toEqual(['0,0,0', '1,0,0']);
		for (const x of [14, 15, 16, 17]) expect(overlayGet(overlay, x, 1, 1)).toBe(AIR_BLOCK);
		expect(overlayGet(overlay, 18, 1, 1)).toBeNull();
	});

	it('reads through to the source for chunks it has not opened', () => {
		const source: Overlay = {};
		overlaySet(source, 40, 1, 1, 'minecraft:sand');

		const editor = new OverlayEditor(source);
		editor.carve(1, 1, 1);

		expect(editor.get(40, 1, 1)).toBe('minecraft:sand');
		expect(editor.commit()[overlayChunkKey(2, 0, 0)]).toBeDefined();
	});

	it('interns a block once however often it is written', () => {
		const editor = new OverlayEditor();
		editor.fill({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, 'minecraft:stone');
		editor.set(5, 0, 0, 'minecraft:sand');
		editor.set(6, 0, 0, 'minecraft:stone');

		const chunk = editor.commit()[overlayChunkKey(0, 0, 0)]!;
		expect(chunk.palette).toEqual([OVERLAY_PASS, AIR_BLOCK, 'minecraft:stone', 'minecraft:sand']);
	});

	it('repairs a stored chunk whose structural slots were lost', () => {
		// A hand-edited document, or an older writer: slot 1 is not air, so every carve in the
		// chunk would otherwise resolve to a real block the next time it was read.
		const source: Overlay = {
			'0,0,0': { palette: ['minecraft:stone', 'minecraft:stone'], data: emptyOverlayChunk().data },
		};
		const editor = new OverlayEditor(source);
		editor.carve(0, 0, 0);

		expect(editor.get(0, 0, 0)).toBe(AIR_BLOCK);
		const chunk = editor.commit()[overlayChunkKey(0, 0, 0)]!;
		expect(chunk.palette[0]).toBe(OVERLAY_PASS);
		expect(chunk.palette[1]).toBe(AIR_BLOCK);
	});
});

describe('overlayCellCount', () => {
	it('counts every cell that says something, carves included', () => {
		const editor = new OverlayEditor();
		editor.fill({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, AIR_BLOCK);
		editor.set(20, 0, 0, 'minecraft:stone');

		expect(overlayCellCount(editor.commit())).toBe(4);
	});
});

describe('an empty chunk', () => {
	it('decodes to 4096 pass-through cells', () => {
		const cells = decodeOverlayChunk(emptyOverlayChunk());
		expect(cells).toHaveLength(OVERLAY_CHUNK ** 3);
		expect(cells.every((value) => value === OVERLAY_NONE)).toBe(true);
		expect(OVERLAY_AIR).toBe(1);
	});
});
