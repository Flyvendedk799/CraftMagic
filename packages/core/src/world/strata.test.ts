/**
 * The ground palette.
 *
 * The assertion that matters is that every block a stratum can lay down is one the registry
 * knows. A profile naming a block nobody has heard of does not fail: it materialises into a
 * palette slot the mesher colours grey and the schem writer exports as a hole, once per region
 * and silently. Water is the one deliberate exception, and it is named as one.
 */

import { describe, expect, it } from 'vitest';
import { isKnownBlock, colorOf } from '../registry/registry.js';
import {
	DEFAULT_STRATA,
	FALLBACK_PROFILE,
	findProfile,
	profileAt,
	profileBlocks,
	profileColor,
	strataIndexOf,
	WORLD_WATER,
} from './strata.js';
import type { WorldSettings } from './types.js';

const settings: WorldSettings = {
	size: { x: 16, z: 16 },
	minY: 0,
	maxY: 64,
	seaLevel: 8,
	regionSize: 16,
	strata: DEFAULT_STRATA.map((profile) => ({ ...profile })),
};

describe('DEFAULT_STRATA', () => {
	it('names only blocks the registry knows', () => {
		for (const profile of DEFAULT_STRATA) {
			for (const block of profileBlocks(profile)) {
				expect(isKnownBlock(block), `${profile.id}: ${block}`).toBe(true);
			}
		}
	});

	it('has the five grounds the painter offers, grass first', () => {
		expect(DEFAULT_STRATA.map((profile) => profile.id)).toEqual([
			'grass', 'sand', 'stone', 'snow', 'path',
		]);
		// `createTerrain` fills the stratum array with zeroes, so index 0 is what a new world is
		// made of — a field, not whatever happened to sort first.
		expect(DEFAULT_STRATA[0]!.id).toBe('grass');
	});

	it('gives every profile a subsurface deep enough to be visible', () => {
		for (const profile of DEFAULT_STRATA) {
			expect(profile.subsurfaceDepth).toBeGreaterThan(0);
		}
	});

	it('is the one block a stratum can lay that the registry does not carry', () => {
		// Water is a fluid, and the registry is derived from block textures. Named here so the
		// grey swatch it produces reads as a known debt rather than as a typo.
		expect(isKnownBlock(WORLD_WATER)).toBe(false);
		expect(WORLD_WATER).toBe('minecraft:water');
	});
});

describe('lookups', () => {
	it('resolves a stratum byte that has fallen off the end', () => {
		// A world saved with six strata and reopened after one was deleted. Every column that
		// pointed at the missing one still has to materialise into something.
		expect(profileAt(settings, 0).id).toBe('grass');
		expect(profileAt(settings, 4).id).toBe('path');
		expect(profileAt(settings, 99).id).toBe('grass');
		expect(profileAt({ ...settings, strata: [] }, 0)).toBe(FALLBACK_PROFILE);
	});

	it('finds a profile by id, and says so when it cannot', () => {
		expect(strataIndexOf(settings, 'snow')).toBe(3);
		expect(strataIndexOf(settings, 'lava')).toBe(-1);
		expect(findProfile(settings, 'sand')?.surface).toBe('minecraft:sand');
		expect(findProfile(settings, 'lava')).toBeUndefined();
	});
});

describe('profileColor', () => {
	it('follows the surface block unless the profile overrides it', () => {
		const grass = DEFAULT_STRATA[0]!;
		expect(profileColor(grass)).toEqual(colorOf(grass.surface));
		expect(profileColor({ ...grass, color: [1, 2, 3] })).toEqual([1, 2, 3]);
	});
});
