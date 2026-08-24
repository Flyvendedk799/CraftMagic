/**
 * The block registry: the single source of truth for which blocks exist, what states they
 * accept, how those states transform, and what colour to draw them.
 *
 * Data comes from `blocks.gen.json`, produced by `tools/registry-gen` from Mojang's own
 * data generator plus texture averages. Never hand-edit that file.
 */

import type { BlockRef, Face } from '../ir/types.js';
import generated from './blocks.gen.json' with { type: 'json' };

export interface RegistryBlock {
	id: string;
	category: string;
	family: string;
	color: [number, number, number];
	rotation: 'facing' | 'axis' | 'none';
	properties: Record<string, string[]>;
	defaultState: Record<string, string>;
	transparent?: boolean;
	light?: number;
}

export interface ParsedBlock {
	id: string;
	states: Record<string, string>;
}

const BLOCKS: RegistryBlock[] = generated.blocks as RegistryBlock[];

const BY_ID = new Map<string, RegistryBlock>(BLOCKS.map((b) => [b.id, b]));

const BY_FAMILY_CATEGORY = new Map<string, RegistryBlock>(
	BLOCKS.map((b) => [`${b.family}/${b.category}`, b]),
);

export const MC_VERSION: string = generated.mcVersion;
export const DATA_VERSION: number = generated.dataVersion;

/** Air is not in the generated data — it has no texture — but every palette needs it. */
export const AIR = 'minecraft:air';

export function allBlocks(): readonly RegistryBlock[] {
	return BLOCKS;
}

export function getBlock(id: string): RegistryBlock | undefined {
	return BY_ID.get(normalizeId(id));
}

export function isKnownBlock(id: string): boolean {
	const normalized = normalizeId(id);
	return normalized === AIR || BY_ID.has(normalized);
}

function normalizeId(id: string): string {
	return id.includes(':') ? id : `minecraft:${id}`;
}

/**
 * Parse `"minecraft:oak_stairs[facing=north,half=top]"`.
 * Throws only on syntactically broken input; unknown ids and bad property values are
 * reported by {@link validateBlockRef} so the caller can attach a path for the repair loop.
 */
export function parseBlockRef(ref: BlockRef): ParsedBlock {
	const trimmed = ref.trim();
	const open = trimmed.indexOf('[');
	if (open === -1) return { id: normalizeId(trimmed), states: {} };

	if (!trimmed.endsWith(']')) {
		throw new Error(`unterminated block state in "${ref}" — expected a closing "]"`);
	}

	const id = normalizeId(trimmed.slice(0, open).trim());
	const body = trimmed.slice(open + 1, -1).trim();
	const states: Record<string, string> = {};
	if (body === '') return { id, states };

	for (const pair of body.split(',')) {
		const eq = pair.indexOf('=');
		if (eq === -1) {
			throw new Error(`bad block state "${pair.trim()}" in "${ref}" — expected key=value`);
		}
		states[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
	}
	return { id, states };
}

export interface BlockRefProblem {
	code: 'UNKNOWN_BLOCK' | 'BAD_STATE';
	message: string;
}

/** Validate a reference against the registry. Returns null when it is usable. */
export function validateBlockRef(ref: BlockRef): BlockRefProblem | null {
	let parsed: ParsedBlock;
	try {
		parsed = parseBlockRef(ref);
	} catch (err) {
		return { code: 'BAD_STATE', message: (err as Error).message };
	}

	if (parsed.id === AIR) return null;

	const block = BY_ID.get(parsed.id);
	if (!block) {
		return {
			code: 'UNKNOWN_BLOCK',
			message: `"${parsed.id}" is not in the ImagineCraft block palette${suggest(parsed.id)}`,
		};
	}

	for (const [key, value] of Object.entries(parsed.states)) {
		const allowed = block.properties[key];
		if (!allowed) {
			const known = Object.keys(block.properties);
			return {
				code: 'BAD_STATE',
				message: known.length
					? `"${parsed.id}" has no property "${key}" — it accepts ${known.join(', ')}`
					: `"${parsed.id}" has no block state properties, but "${key}" was given`,
			};
		}
		if (!allowed.includes(value)) {
			return {
				code: 'BAD_STATE',
				message: `"${key}=${value}" is invalid for "${parsed.id}" — allowed: ${allowed.join(', ')}`,
			};
		}
	}
	return null;
}

/** Cheap nearest-name hint, so a repair round gets something actionable. */
function suggest(id: string): string {
	const bare = id.replace('minecraft:', '');
	const near = BLOCKS.filter((b) => {
		const n = b.id.replace('minecraft:', '');
		return n.includes(bare) || bare.includes(n);
	}).slice(0, 3);
	return near.length ? `. Did you mean ${near.map((b) => b.id).join(', ')}?` : '';
}

/**
 * Canonical string form: properties sorted, defaults filled in.
 *
 * Both halves matter. Sorting means `[half=top,facing=north]` and `[facing=north,half=top]`
 * collapse to one palette entry instead of two. Filling defaults means a bare
 * `minecraft:oak_stairs` and a fully-specified identical state also collapse — and the
 * Sponge schematic palette needs complete states anyway.
 */
export function canonical(ref: BlockRef): string {
	const parsed = parseBlockRef(ref);
	if (parsed.id === AIR) return AIR;

	const block = BY_ID.get(parsed.id);
	if (!block) {
		// Unknown blocks still canonicalise so callers can dedupe before validation runs.
		const keys = Object.keys(parsed.states).sort();
		return keys.length
			? `${parsed.id}[${keys.map((k) => `${k}=${parsed.states[k]}`).join(',')}]`
			: parsed.id;
	}

	const merged: Record<string, string> = { ...block.defaultState, ...parsed.states };
	const keys = Object.keys(merged).sort();
	if (keys.length === 0) return parsed.id;
	return `${parsed.id}[${keys.map((k) => `${k}=${merged[k]}`).join(',')}]`;
}

// --- transforms ---------------------------------------------------------

const FACING_CW: Record<string, string> = {
	north: 'east',
	east: 'south',
	south: 'west',
	west: 'north',
	// Vertical facings are unaffected by rotation around Y.
	up: 'up',
	down: 'down',
};

const AXIS_CW: Record<string, string> = { x: 'z', z: 'x', y: 'y' };

const MIRROR_X: Record<string, string> = { east: 'west', west: 'east', north: 'north', south: 'south', up: 'up', down: 'down' };
const MIRROR_Z: Record<string, string> = { north: 'south', south: 'north', east: 'east', west: 'west', up: 'up', down: 'down' };

/** Mirroring swaps a stair's left/right corner shapes and a door's hinge side. */
const SHAPE_FLIP: Record<string, string> = {
	inner_left: 'inner_right',
	inner_right: 'inner_left',
	outer_left: 'outer_right',
	outer_right: 'outer_left',
	straight: 'straight',
};

const HINGE_FLIP: Record<string, string> = { left: 'right', right: 'left' };

/** Rotate a block 90° clockwise around Y, `times` times. Returns a canonical ref. */
export function rotate(ref: BlockRef, times: number): string {
	const steps = ((times % 4) + 4) % 4;
	if (steps === 0) return canonical(ref);

	const parsed = parseBlockRef(ref);
	const block = BY_ID.get(parsed.id);
	if (!block) return canonical(ref);

	const states: Record<string, string> = { ...block.defaultState, ...parsed.states };
	for (let i = 0; i < steps; i++) {
		if (states.facing !== undefined) states.facing = FACING_CW[states.facing] ?? states.facing;
		if (states.axis !== undefined) states.axis = AXIS_CW[states.axis] ?? states.axis;
	}
	return canonical(formatRef(parsed.id, states));
}

/** Mirror across the plane perpendicular to `axis`. */
export function mirror(ref: BlockRef, axis: 'x' | 'z'): string {
	const parsed = parseBlockRef(ref);
	const block = BY_ID.get(parsed.id);
	if (!block) return canonical(ref);

	const states: Record<string, string> = { ...block.defaultState, ...parsed.states };
	const table = axis === 'x' ? MIRROR_X : MIRROR_Z;
	if (states.facing !== undefined) states.facing = table[states.facing] ?? states.facing;
	if (states.shape !== undefined) states.shape = SHAPE_FLIP[states.shape] ?? states.shape;
	if (states.hinge !== undefined) states.hinge = HINGE_FLIP[states.hinge] ?? states.hinge;
	return canonical(formatRef(parsed.id, states));
}

export function formatRef(id: string, states: Record<string, string>): string {
	const keys = Object.keys(states).sort();
	if (keys.length === 0) return id;
	return `${id}[${keys.map((k) => `${k}=${states[k]}`).join(',')}]`;
}

/** Set a property, keeping the result canonical. Used by the geometry builders. */
export function withState(ref: BlockRef, states: Record<string, string>): string {
	const parsed = parseBlockRef(ref);
	const block = BY_ID.get(parsed.id);
	if (!block) return canonical(ref);

	const merged: Record<string, string> = { ...parsed.states };
	for (const [key, value] of Object.entries(states)) {
		// Silently ignore properties this block does not have, so a generic roof builder can
		// ask for `half=top` without knowing whether it was handed stairs or a solid block.
		if (block.properties[key]?.includes(value)) merged[key] = value;
	}
	return canonical(formatRef(parsed.id, merged));
}

export function supportsState(ref: BlockRef, key: string, value?: string): boolean {
	const block = BY_ID.get(parseBlockRef(ref).id);
	const allowed = block?.properties[key];
	if (!allowed) return false;
	return value === undefined || allowed.includes(value);
}

/** Swap a block for its equivalent in another family: oak stairs -> spruce stairs. */
export function familySwap(ref: BlockRef, targetFamily: string): string {
	const parsed = parseBlockRef(ref);
	const block = BY_ID.get(parsed.id);
	if (!block) return canonical(ref);

	const replacement = BY_FAMILY_CATEGORY.get(`${targetFamily}/${block.category}`);
	if (!replacement) return canonical(ref);
	return canonical(formatRef(replacement.id, parsed.states));
}

// --- display ------------------------------------------------------------

const DEFAULT_COLOR: [number, number, number] = [136, 136, 136];

export function colorOf(ref: BlockRef): [number, number, number] {
	if (ref === AIR) return [0, 0, 0];
	return BY_ID.get(parseBlockRef(ref).id)?.color ?? DEFAULT_COLOR;
}

export function isTransparent(ref: BlockRef): boolean {
	if (ref === AIR) return true;
	return BY_ID.get(parseBlockRef(ref).id)?.transparent === true;
}

export function lightOf(ref: BlockRef): number {
	return BY_ID.get(parseBlockRef(ref).id)?.light ?? 0;
}

/** Human-readable name for the bill of materials: `minecraft:oak_stairs` -> `Oak Stairs`. */
export function displayName(ref: BlockRef): string {
	return parseBlockRef(ref)
		.id.replace('minecraft:', '')
		.split('_')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

/**
 * Flatten a voxel palette into the two flat arrays the mesher needs.
 *
 * The renderer deliberately knows nothing about Minecraft blocks — it only ever sees
 * colours and flags indexed by palette slot — which keeps the meshing code independent of
 * the game data and cheap to transfer into a worker.
 */
export const PALETTE_FLAG_TRANSPARENT = 1;
export const PALETTE_FLAG_EMISSIVE = 2;

export function paletteColors(palette: readonly string[]): Uint8Array {
	const out = new Uint8Array(palette.length * 3);
	for (let i = 0; i < palette.length; i++) {
		const [r, g, b] = colorOf(palette[i]!);
		out[i * 3] = r;
		out[i * 3 + 1] = g;
		out[i * 3 + 2] = b;
	}
	return out;
}

export function paletteFlags(palette: readonly string[]): Uint8Array {
	const out = new Uint8Array(palette.length);
	for (let i = 0; i < palette.length; i++) {
		const ref = palette[i]!;
		let flags = 0;
		if (isTransparent(ref)) flags |= PALETTE_FLAG_TRANSPARENT;
		if (lightOf(ref) > 0) flags |= PALETTE_FLAG_EMISSIVE;
		out[i] = flags;
	}
	return out;
}
