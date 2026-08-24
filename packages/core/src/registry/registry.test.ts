import { describe, expect, it } from 'vitest';
import {
	AIR,
	canonical,
	colorOf,
	displayName,
	familySwap,
	getBlock,
	isKnownBlock,
	isTransparent,
	mirror,
	paletteColors,
	paletteFlags,
	parseBlockRef,
	rotate,
	validateBlockRef,
	withState,
	PALETTE_FLAG_TRANSPARENT,
} from './registry.js';

describe('parseBlockRef', () => {
	it('parses a bare id and defaults the namespace', () => {
		expect(parseBlockRef('minecraft:stone')).toEqual({ id: 'minecraft:stone', states: {} });
		expect(parseBlockRef('stone')).toEqual({ id: 'minecraft:stone', states: {} });
	});

	it('parses states', () => {
		expect(parseBlockRef('minecraft:oak_stairs[facing=north,half=top]')).toEqual({
			id: 'minecraft:oak_stairs',
			states: { facing: 'north', half: 'top' },
		});
	});

	it('rejects malformed state syntax', () => {
		expect(() => parseBlockRef('minecraft:oak_stairs[facing=north')).toThrow(/closing/);
		expect(() => parseBlockRef('minecraft:oak_stairs[facing]')).toThrow(/key=value/);
	});
});

describe('validateBlockRef', () => {
	it('accepts air and known blocks', () => {
		expect(validateBlockRef(AIR)).toBeNull();
		expect(validateBlockRef('minecraft:stone_bricks')).toBeNull();
		expect(validateBlockRef('minecraft:oak_stairs[facing=east,half=bottom]')).toBeNull();
	});

	it('rejects unknown blocks with a suggestion when one is close', () => {
		const problem = validateBlockRef('minecraft:oak_stair');
		expect(problem?.code).toBe('UNKNOWN_BLOCK');
		expect(problem?.message).toMatch(/oak_stairs/);
	});

	it('rejects unknown properties and bad values, listing what is allowed', () => {
		expect(validateBlockRef('minecraft:oak_stairs[wibble=1]')?.message).toMatch(/facing/);
		expect(validateBlockRef('minecraft:oak_stairs[facing=up]')?.message).toMatch(/allowed:/);
	});
});

describe('canonical', () => {
	it('fills defaults so equivalent refs collapse to one palette entry', () => {
		// A bare stair and a fully-specified identical stair must produce the same string,
		// or the .schem palette gains duplicate entries for the same block.
		const bare = canonical('minecraft:oak_stairs');
		const explicit = canonical(
			'minecraft:oak_stairs[shape=straight,waterlogged=false,half=bottom,facing=north]',
		);
		expect(bare).toBe(explicit);
	});

	it('sorts properties so key order cannot create duplicates', () => {
		expect(canonical('minecraft:oak_stairs[half=top,facing=north]')).toBe(
			canonical('minecraft:oak_stairs[facing=north,half=top]'),
		);
	});

	it('leaves propertyless blocks bare', () => {
		expect(canonical('minecraft:stone_bricks')).toBe('minecraft:stone_bricks');
	});

	it('passes air through', () => {
		expect(canonical(AIR)).toBe(AIR);
	});
});

describe('rotate', () => {
	it('turns facing clockwise', () => {
		expect(rotate('minecraft:oak_stairs[facing=north]', 1)).toContain('facing=east');
		expect(rotate('minecraft:oak_stairs[facing=east]', 1)).toContain('facing=south');
		expect(rotate('minecraft:oak_stairs[facing=south]', 1)).toContain('facing=west');
		expect(rotate('minecraft:oak_stairs[facing=west]', 1)).toContain('facing=north');
	});

	it('is the identity after four quarter turns', () => {
		const start = canonical('minecraft:oak_stairs[facing=north,half=top]');
		expect(rotate(start, 4)).toBe(start);
	});

	it('swaps x and z for axis blocks, leaving y alone', () => {
		expect(rotate('minecraft:oak_log[axis=x]', 1)).toContain('axis=z');
		expect(rotate('minecraft:oak_log[axis=y]', 1)).toContain('axis=y');
	});

	it('normalises negative and oversized turn counts', () => {
		expect(rotate('minecraft:oak_stairs[facing=north]', -1)).toContain('facing=west');
		expect(rotate('minecraft:oak_stairs[facing=north]', 5)).toContain('facing=east');
	});
});

describe('mirror', () => {
	it('flips east/west across x and leaves north/south', () => {
		expect(mirror('minecraft:oak_stairs[facing=east]', 'x')).toContain('facing=west');
		expect(mirror('minecraft:oak_stairs[facing=north]', 'x')).toContain('facing=north');
	});

	it('flips north/south across z', () => {
		expect(mirror('minecraft:oak_stairs[facing=north]', 'z')).toContain('facing=south');
	});

	it('flips corner stair shapes, which is what makes mirrored roofs meet correctly', () => {
		expect(mirror('minecraft:oak_stairs[shape=inner_left]', 'x')).toContain('shape=inner_right');
		expect(mirror('minecraft:oak_stairs[shape=straight]', 'x')).toContain('shape=straight');
	});

	it('flips door hinges', () => {
		expect(mirror('minecraft:oak_door[hinge=left]', 'x')).toContain('hinge=right');
	});
});

describe('withState', () => {
	it('sets a supported property', () => {
		expect(withState('minecraft:oak_stairs', { half: 'top' })).toContain('half=top');
	});

	it('ignores properties the block does not have, so generic builders stay simple', () => {
		// A roof builder sets half=top without knowing if it got stairs or a solid block.
		expect(withState('minecraft:stone_bricks', { half: 'top' })).toBe('minecraft:stone_bricks');
	});

	it('ignores values outside the allowed set', () => {
		expect(withState('minecraft:oak_stairs', { facing: 'up' })).toContain('facing=north');
	});
});

describe('familySwap', () => {
	it('re-skins a block into another wood family, keeping its shape and states', () => {
		const swapped = familySwap('minecraft:oak_stairs[facing=east]', 'spruce');
		expect(swapped).toContain('minecraft:spruce_stairs');
		expect(swapped).toContain('facing=east');
	});

	it('returns the original when the target family has no equivalent', () => {
		expect(familySwap('minecraft:oak_stairs', 'nonexistent_family')).toBe(
			canonical('minecraft:oak_stairs'),
		);
	});
});

describe('registry data', () => {
	it('knows air and common build blocks', () => {
		expect(isKnownBlock(AIR)).toBe(true);
		for (const id of ['minecraft:stone_bricks', 'minecraft:oak_planks', 'minecraft:glass']) {
			expect(isKnownBlock(id)).toBe(true);
		}
	});

	it('classifies orientation from the real property set', () => {
		expect(getBlock('minecraft:oak_stairs')?.rotation).toBe('facing');
		expect(getBlock('minecraft:oak_log')?.rotation).toBe('axis');
		expect(getBlock('minecraft:stone_bricks')?.rotation).toBe('none');
	});

	it('detects transparency from texture alpha rather than a hand-written list', () => {
		expect(isTransparent('minecraft:glass')).toBe(true);
		expect(isTransparent('minecraft:oak_leaves')).toBe(true);
		expect(isTransparent('minecraft:stone_bricks')).toBe(false);
	});

	it('has plausible colours', () => {
		const [r, g, b] = colorOf('minecraft:red_wool');
		expect(r).toBeGreaterThan(g + 40);
		expect(r).toBeGreaterThan(b + 40);
	});

	it('names blocks readably for the bill of materials', () => {
		expect(displayName('minecraft:oak_stairs[facing=north]')).toBe('Oak Stairs');
	});
});

describe('palette flattening for the renderer', () => {
	const palette = [AIR, 'minecraft:stone_bricks', 'minecraft:glass'];

	it('emits three colour bytes per entry', () => {
		expect(paletteColors(palette)).toHaveLength(palette.length * 3);
	});

	it('flags transparent entries', () => {
		const flags = paletteFlags(palette);
		expect(flags[2]! & PALETTE_FLAG_TRANSPARENT).toBeTruthy();
		expect(flags[1]! & PALETTE_FLAG_TRANSPARENT).toBeFalsy();
	});
});
