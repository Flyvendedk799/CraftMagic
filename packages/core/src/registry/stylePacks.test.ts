import { describe, expect, it } from 'vitest';
import { expand } from '../expand/expander.js';
import { samples } from '../samples/index.js';
import { isKnownBlock, parseBlockRef, validateBlockRef } from './registry.js';
import { applyStylePack, STYLE_PACKS, stylePackById } from './stylePacks.js';

describe('style packs', () => {
	it('every block in every pack exists in the registry', () => {
		// This is the test that catches a typo'd block id before a user ever sees a purple
		// UNKNOWN_BLOCK error — the packs are hand-written data, and data rots.
		for (const pack of STYLE_PACKS) {
			for (const [role, style] of Object.entries(pack.roles)) {
				const refs = [
					...(Array.isArray(style.block) ? style.block.map((entry) => entry.block) : [style.block]),
					style.stairs,
					style.slab,
					style.door,
					style.log,
				].filter((ref): ref is string => ref !== undefined);

				for (const ref of refs) {
					expect(validateBlockRef(ref), `${pack.id}/${role}: ${ref}`).toBeNull();
					expect(isKnownBlock(parseBlockRef(ref).id), `${pack.id}/${role}: ${ref}`).toBe(true);
				}
			}
		}
	});

	it('pack ids are unique and resolvable', () => {
		const ids = STYLE_PACKS.map((pack) => pack.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(stylePackById(id)?.id).toBe(id);
		expect(stylePackById('no-such-pack')).toBeNull();
		expect(stylePackById(null)).toBeNull();
	});

	it('keeps stairs as stairs, so pitched roofs stay pitched', () => {
		// The cottage's roof_primary is dark_oak_stairs; a pack must not flatten it.
		const cottage = samples.cottage!;
		for (const pack of STYLE_PACKS) {
			const styled = applyStylePack(cottage, pack);
			const roof = styled.palette['roof_primary'];
			expect(typeof roof).toBe('string');
			expect(roof as string, pack.id).toMatch(/stairs/);
		}
	});

	it('touches only the palette', () => {
		const cottage = samples.cottage!;
		const styled = applyStylePack(cottage, STYLE_PACKS[0]!);
		expect(styled.components).toBe(cottage.components);
		expect(styled.params).toBe(cottage.params);
		expect(styled.size).toBe(cottage.size);
		expect(styled.palette).not.toBe(cottage.palette);
	});

	it('leaves roles the pack does not name untouched', () => {
		const program = {
			version: 1 as const,
			meta: { name: 'test' },
			size: { x: 4, y: 4, z: 4 },
			palette: { mystery_role: 'minecraft:sponge' },
			components: [],
		};
		const styled = applyStylePack(program, STYLE_PACKS[0]!);
		expect(styled.palette['mystery_role']).toBe('minecraft:sponge');
	});

	it('every sample still expands cleanly under every pack', () => {
		for (const [name, program] of Object.entries(samples)) {
			const before = expand(program).blockCount;
			for (const pack of STYLE_PACKS) {
				const result = expand(applyStylePack(program, pack));
				expect(result.errors, `${name} in ${pack.id}: ${JSON.stringify(result.errors)}`).toEqual([]);
				// A restyle changes materials, never geometry.
				expect(result.blockCount, `${name} in ${pack.id}`).toBe(before);
			}
		}
	});
});
