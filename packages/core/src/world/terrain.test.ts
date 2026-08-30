/**
 * The heightfield.
 *
 * Two things here are silent when they are wrong, and both get pinned by hand-computed
 * numbers rather than by comparison with the code that produced them.
 *
 * The first is the index order. Terrain is row-major and the grids it feeds are YZX, and a
 * transposed index produces a world that looks entirely plausible and is mirrored — so the
 * tests use a deliberately non-square map, where `columnIndex(x, z)` and a transposed
 * `columnIndex(z, x)` cannot coincide.
 *
 * The second is the brush's clipping. A disc dragged off the west edge has to paint half a
 * disc; one that wrapped would paint the far side of the map, and nobody would find that until
 * a player stood in the crater.
 */

import { describe, expect, it } from 'vitest';
import {
	columnAt,
	columnIndex,
	columnPosition,
	createTerrain,
	heightRange,
	isEmptyColumn,
	levelDisc,
	paintDisc,
	raiseDisc,
	reindexTerrain,
	setHeight,
	stampDisc,
} from './terrain.js';
import { DEFAULT_STRATA } from './strata.js';
import type { WorldSettings } from './types.js';

function settingsOf(x: number, z: number, extra: Partial<WorldSettings> = {}): WorldSettings {
	return {
		size: { x, z },
		minY: 0,
		maxY: 64,
		seaLevel: 8,
		regionSize: 16,
		strata: DEFAULT_STRATA.map((profile) => ({ ...profile })),
		...extra,
	};
}

describe('columnIndex', () => {
	it('is row-major, and a transposed read lands somewhere else', () => {
		const settings = settingsOf(5, 3);

		// i = z * size.x + x. Written out rather than derived, so a change of convention fails
		// here rather than everywhere at once.
		expect(columnIndex(settings, 0, 0)).toBe(0);
		expect(columnIndex(settings, 4, 0)).toBe(4);
		expect(columnIndex(settings, 0, 1)).toBe(5);
		expect(columnIndex(settings, 2, 1)).toBe(7);
		expect(columnIndex(settings, 4, 2)).toBe(14);

		// The pair that catches a transpose: on a 5x3 map these two must differ.
		expect(columnIndex(settings, 1, 0)).not.toBe(columnIndex(settings, 0, 1));
	});

	it('clips rather than wrapping', () => {
		const settings = settingsOf(5, 3);
		expect(columnIndex(settings, -1, 0)).toBe(-1);
		expect(columnIndex(settings, 5, 0)).toBe(-1);
		expect(columnIndex(settings, 0, 3)).toBe(-1);
		expect(columnIndex(settings, 0, -1)).toBe(-1);
	});

	it('round-trips through columnPosition', () => {
		const settings = settingsOf(7, 4);
		expect(columnPosition(settings, 0)).toEqual({ x: 0, z: 0 });
		expect(columnPosition(settings, 9)).toEqual({ x: 2, z: 1 });
		expect(columnPosition(settings, 27)).toEqual({ x: 6, z: 3 });
	});
});

describe('createTerrain', () => {
	it('is flat at sea level in the first stratum', () => {
		const settings = settingsOf(4, 3, { seaLevel: 11 });
		const terrain = createTerrain(settings);

		expect(terrain.height).toHaveLength(12);
		expect(terrain.strata).toHaveLength(12);
		expect([...terrain.height]).toEqual(Array(12).fill(11));
		expect([...terrain.strata]).toEqual(Array(12).fill(0));
	});

	it('holds heights below zero, which a Uint16 could not', () => {
		const settings = settingsOf(2, 2, { minY: -64, maxY: 320, seaLevel: -20 });
		const terrain = createTerrain(settings);
		setHeight(terrain, settings, 0, -64);
		setHeight(terrain, settings, 1, 320);

		expect(terrain.height[0]).toBe(-64);
		expect(terrain.height[1]).toBe(320);
	});

	it('clamps a height into the world rather than letting Int16 wrap it', () => {
		const settings = settingsOf(2, 2, { minY: 0, maxY: 64 });
		const terrain = createTerrain(settings);

		setHeight(terrain, settings, 0, 999_999);
		setHeight(terrain, settings, 1, -999_999);

		expect(terrain.height[0]).toBe(64);
		// One below the floor is the empty-column sentinel, and the lowest legal value.
		expect(terrain.height[1]).toBe(-1);
		expect(isEmptyColumn(settings, terrain.height[1]!)).toBe(true);
	});
});

describe('stampDisc', () => {
	it('covers exactly the columns inside the radius', () => {
		const settings = settingsOf(16, 16);
		const terrain = createTerrain(settings);
		const seen: string[] = [];

		const touched = stampDisc(
			terrain,
			settings,
			5,
			5,
			{ radius: 2, strength: 1, falloff: 'flat' },
			(column) => seen.push(`${column.x},${column.z}`),
		);

		// dx² + dz² <= 4 over the integers: the centre, four at 1, four at √2, four at 2.
		expect(touched).toBe(13);
		expect(seen).toContain('5,5');
		expect(seen).toContain('3,5');
		expect(seen).toContain('7,5');
		expect(seen).toContain('6,6');
		// (2,1) is √5 away — outside a radius of 2.
		expect(seen).not.toContain('7,6');
	});

	it('clips at the edge instead of wrapping to the far side', () => {
		const settings = settingsOf(16, 16);
		const terrain = createTerrain(settings);
		const seen: string[] = [];

		const touched = stampDisc(
			terrain,
			settings,
			0,
			0,
			{ radius: 2, strength: 1, falloff: 'flat' },
			(column) => seen.push(`${column.x},${column.z}`),
		);

		// A quarter of the same disc: (0,0) (1,0) (2,0) (0,1) (1,1) (0,2).
		expect(touched).toBe(6);
		expect(seen).not.toContain('15,15');
		expect(seen.every((key) => !key.includes('15'))).toBe(true);
	});

	it('still touches one column at radius zero', () => {
		const settings = settingsOf(8, 8);
		const terrain = createTerrain(settings);
		let touched = 0;
		stampDisc(terrain, settings, 3, 4, { radius: 0, strength: 1, falloff: 'smooth' }, (column) => {
			touched++;
			expect(column.index).toBe(4 * 8 + 3);
		});
		expect(touched).toBe(1);
	});

	it('weights a smooth brush by cos² of the normalised distance', () => {
		const settings = settingsOf(16, 16);
		const terrain = createTerrain(settings);
		const weights = new Map<string, number>();

		stampDisc(
			terrain,
			settings,
			8,
			8,
			{ radius: 4, strength: 1, falloff: 'smooth' },
			(column, weight) => weights.set(`${column.x},${column.z}`, weight),
		);

		// cos(0)² = 1 at the centre; cos(π/4)² = 0.5 at half the radius.
		expect(weights.get('8,8')).toBeCloseTo(1, 10);
		expect(weights.get('10,8')).toBeCloseTo(0.5, 10);
		// cos(π/2)² = 0 at the rim, and a zero-weight column is not visited at all.
		expect(weights.has('12,8')).toBe(false);
	});

	it('gives a flat brush the same weight everywhere inside it', () => {
		const settings = settingsOf(16, 16);
		const terrain = createTerrain(settings);
		const weights: number[] = [];
		stampDisc(terrain, settings, 8, 8, { radius: 3, strength: 2, falloff: 'flat' }, (_, weight) =>
			weights.push(weight),
		);
		expect(new Set(weights)).toEqual(new Set([2]));
	});
});

describe('the brushes built on stampDisc', () => {
	it('raises by the weight and lowers with a negative strength', () => {
		const settings = settingsOf(16, 16, { seaLevel: 10 });
		const terrain = createTerrain(settings);

		raiseDisc(terrain, settings, 8, 8, { radius: 1, strength: 3, falloff: 'flat' });
		expect(columnAt(terrain, settings, 8, 8)?.height).toBe(13);
		expect(columnAt(terrain, settings, 9, 8)?.height).toBe(13);
		expect(columnAt(terrain, settings, 10, 8)?.height).toBe(10);

		raiseDisc(terrain, settings, 8, 8, { radius: 1, strength: -5, falloff: 'flat' });
		expect(columnAt(terrain, settings, 8, 8)?.height).toBe(8);
	});

	it('levels towards a target, feathering the edge with a smooth falloff', () => {
		const settings = settingsOf(16, 16, { seaLevel: 10 });
		const terrain = createTerrain(settings);

		levelDisc(terrain, settings, 8, 8, { radius: 4, strength: 1, falloff: 'smooth' }, 20);

		// Full weight at the centre: 10 + (20-10)*1.
		expect(columnAt(terrain, settings, 8, 8)?.height).toBe(20);
		// Half weight at half the radius: 10 + (20-10)*0.5.
		expect(columnAt(terrain, settings, 10, 8)?.height).toBe(15);
		// Outside the brush entirely.
		expect(columnAt(terrain, settings, 13, 8)?.height).toBe(10);
	});

	it('paints a stratum only where the brush is more than half on', () => {
		const settings = settingsOf(16, 16);
		const terrain = createTerrain(settings);

		paintDisc(terrain, settings, 8, 8, { radius: 4, strength: 1, falloff: 'smooth' }, 2);

		expect(columnAt(terrain, settings, 8, 8)?.stratum).toBe(2);
		// cos²(π/4) is exactly 0.5 — the threshold is inclusive, so this one paints.
		expect(columnAt(terrain, settings, 10, 8)?.stratum).toBe(2);
		// cos²(3π/8) ≈ 0.146 — below the threshold, so the ground keeps its old stratum.
		expect(columnAt(terrain, settings, 11, 8)?.stratum).toBe(0);
	});

	it('refuses a stratum the settings do not have', () => {
		const settings = settingsOf(8, 8);
		const terrain = createTerrain(settings);
		paintDisc(terrain, settings, 4, 4, { radius: 1, strength: 1, falloff: 'flat' }, 99);
		expect(columnAt(terrain, settings, 4, 4)?.stratum).toBe(0);
	});
});

describe('reindexTerrain', () => {
	it('keeps every column that still exists when the stride changes', () => {
		const from = { x: 4, z: 3 };
		const height = Int16Array.from([
			10, 11, 12, 13,
			20, 21, 22, 23,
			30, 31, 32, 33,
		]);
		const strata = Uint8Array.from([
			1, 1, 1, 1,
			2, 2, 2, 2,
			3, 3, 3, 3,
		]);

		const grown = reindexTerrain({ height, strata }, from, { x: 6, z: 4 }, { height: 7, stratum: 0 });

		// Row 1 starts at index 6 now, not 4. A straight copy would put 20 at index 4.
		expect(grown.height[0]).toBe(10);
		expect(grown.height[3]).toBe(13);
		expect(grown.height[4]).toBe(7);
		expect(grown.height[6]).toBe(20);
		expect(grown.height[12]).toBe(30);
		expect(grown.height[18]).toBe(7);
		expect(grown.strata[6]).toBe(2);
		expect(grown.strata[4]).toBe(0);
	});

	it('drops what no longer fits when the map shrinks', () => {
		const from = { x: 4, z: 3 };
		const height = Int16Array.from([
			10, 11, 12, 13,
			20, 21, 22, 23,
			30, 31, 32, 33,
		]);
		const strata = new Uint8Array(12);

		const shrunk = reindexTerrain({ height, strata }, from, { x: 2, z: 2 }, { height: 7, stratum: 0 });

		expect([...shrunk.height]).toEqual([10, 11, 20, 21]);
	});
});

describe('heightRange', () => {
	it('ignores empty columns and reports null when they are all empty', () => {
		const settings = settingsOf(4, 4, { minY: 0, seaLevel: 5 });
		const terrain = createTerrain(settings);
		setHeight(terrain, settings, columnIndex(settings, 1, 1), 9);
		setHeight(terrain, settings, columnIndex(settings, 2, 1), -1);

		expect(heightRange(terrain, settings, 0, 0, 4, 4)).toEqual({ min: 5, max: 9 });
		expect(heightRange(terrain, settings, 2, 1, 1, 1)).toBeNull();
	});
});
