/**
 * Generates `packages/core/src/registry/blocks.gen.json`.
 *
 * Two authoritative inputs, neither of which is redistributed:
 *  - Mojang's own data generator report (`work/generated/reports/blocks.json`) for block
 *    ids, state properties and defaults. Guessing these is how mods break on update.
 *  - The locally installed client jar's textures, from which we compute one average RGB
 *    per block. Only the derived colour goes into the output — no Mojang art is copied.
 *
 * Run: see run.md. This is a dev tool; it never ships and the game files it reads are
 * gitignored under `work/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { candidateIds, categoryOf, familyOf, LIGHT_LEVELS } from './curated.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(here, 'work');
const ASSETS = path.join(WORK, 'assets', 'assets', 'minecraft');
const REPORT = path.join(WORK, 'generated', 'reports', 'blocks.json');
const OUT = path.resolve(here, '../../packages/core/src/registry/blocks.gen.json');

const DATA_VERSION = 4903; // Minecraft 26.2
const MC_VERSION = '26.2';

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** `minecraft:block/oak_planks` -> `<assets>/models/block/oak_planks.json` */
function modelPath(ref) {
	const bare = ref.replace(/^minecraft:/, '');
	return path.join(ASSETS, 'models', `${bare}.json`);
}

function texturePath(ref) {
	const bare = ref.replace(/^minecraft:/, '');
	return path.join(ASSETS, 'textures', `${bare}.png`);
}

/**
 * Walk a model's parent chain, merging texture maps with the child winning. Vanilla
 * models are shallow (2-3 levels), but the depth cap guards against a cycle turning a
 * build-time tool into a hang.
 */
function resolveModelTextures(modelRef, depth = 0) {
	if (depth > 8) return {};
	const file = modelPath(modelRef);
	if (!fs.existsSync(file)) return {};

	let model;
	try {
		model = readJson(file);
	} catch {
		return {};
	}

	const inherited = model.parent ? resolveModelTextures(model.parent, depth + 1) : {};
	return { ...inherited, ...(model.textures ?? {}) };
}

/**
 * Pick the texture that best represents a block as a single colour.
 *
 * Order matters: `all` beats `top` for full cubes, but `top` beats `side` for things like
 * grass blocks and logs where the side is bark. `particle` is the last resort because
 * Mojang sets it on every model as the break-particle source.
 */
const TEXTURE_KEYS = ['all', 'top', 'texture', 'side', 'end', 'north', 'front', 'cross', 'pane', 'bottom', 'particle', '0'];

function pickTexture(textures) {
	const resolve = (value, depth = 0) => {
		if (depth > 6) return null;
		// Newer models wrap a texture as { sprite, force_translucent } instead of a bare
		// string — glass and every stained pane use this form.
		if (value && typeof value === 'object' && 'sprite' in value) return resolve(value.sprite, depth + 1);
		if (typeof value !== 'string') return null;
		// Models reference sibling keys as "#side".
		if (value.startsWith('#')) return resolve(textures[value.slice(1)], depth + 1);
		return value;
	};

	for (const key of TEXTURE_KEYS) {
		if (key in textures) {
			const resolved = resolve(textures[key]);
			if (resolved && fs.existsSync(texturePath(resolved))) return resolved;
		}
	}
	for (const value of Object.values(textures)) {
		const resolved = resolve(value);
		if (resolved && fs.existsSync(texturePath(resolved))) return resolved;
	}
	return null;
}

/** Find the model a block shows in its default state. */
function modelForBlock(name, defaultState) {
	const file = path.join(ASSETS, 'blockstates', `${name}.json`);
	if (!fs.existsSync(file)) return null;

	let states;
	try {
		states = readJson(file);
	} catch {
		return null;
	}

	if (states.variants) {
		const entries = Object.entries(states.variants);
		// Prefer the variant matching the default state; a stair's "straight" model is far
		// more representative than whichever key happens to be first.
		const match = entries.find(([key]) => {
			if (key === '') return true;
			return key.split(',').every((pair) => {
				const [prop, value] = pair.split('=');
				return defaultState[prop] === value;
			});
		});
		const chosen = (match ?? entries[0])?.[1];
		const variant = Array.isArray(chosen) ? chosen[0] : chosen;
		return variant?.model ?? null;
	}

	if (states.multipart) {
		for (const part of states.multipart) {
			const apply = Array.isArray(part.apply) ? part.apply[0] : part.apply;
			if (apply?.model) return apply.model;
		}
	}
	return null;
}

/**
 * Average colour of a texture, weighted by alpha and ignoring fully transparent pixels
 * (otherwise every pane and ladder averages toward black).
 *
 * Returns whether any pixel was translucent, which is how `transparent` is determined —
 * far more reliable than maintaining a hand-written list of see-through blocks.
 */
function averageColor(file) {
	const png = PNG.sync.read(fs.readFileSync(file));
	// Animated textures stack their frames vertically; only the first frame is the block.
	const frameHeight = png.height > png.width && png.height % png.width === 0 ? png.width : png.height;

	let r = 0;
	let g = 0;
	let b = 0;
	let weight = 0;
	let hasAlpha = false;

	for (let y = 0; y < frameHeight; y++) {
		for (let x = 0; x < png.width; x++) {
			const i = (png.width * y + x) << 2;
			const a = png.data[i + 3];
			if (a < 250) hasAlpha = true;
			if (a === 0) continue;
			const w = a / 255;
			r += png.data[i] * w;
			g += png.data[i + 1] * w;
			b += png.data[i + 2] * w;
			weight += w;
		}
	}

	if (weight === 0) return null;
	return {
		color: [Math.round(r / weight), Math.round(g / weight), Math.round(b / weight)],
		transparent: hasAlpha,
	};
}

/**
 * Some textures are greyscale masks that the game tints at runtime. Averaging them yields
 * a washed-out grey, so the biome/foliage tint is applied here instead.
 */
const TINTS = {
	'minecraft:grass_block': [0x7c, 0xbd, 0x6b],
	'minecraft:oak_leaves': [0x59, 0xae, 0x30],
	'minecraft:spruce_leaves': [0x61, 0x9d, 0x61],
	'minecraft:birch_leaves': [0x80, 0xa7, 0x55],
	'minecraft:jungle_leaves': [0x30, 0xbb, 0x0b],
	'minecraft:acacia_leaves': [0x59, 0xae, 0x30],
	'minecraft:dark_oak_leaves': [0x59, 0xae, 0x30],
	'minecraft:mangrove_leaves': [0x59, 0xae, 0x30],
	'minecraft:vine': [0x59, 0xae, 0x30],
};

function applyTint(id, color) {
	const tint = TINTS[id];
	if (!tint) return color;
	// Multiply blend, matching how the game tints these textures.
	return color.map((c, i) => Math.round((c * tint[i]) / 255));
}

// --- main ---------------------------------------------------------------

if (!fs.existsSync(REPORT)) {
	console.error(`Missing ${REPORT}. Run the data generator first — see run.md.`);
	process.exit(1);
}
if (!fs.existsSync(path.join(ASSETS, 'blockstates'))) {
	console.error(`Missing extracted client assets at ${ASSETS}. See run.md.`);
	process.exit(1);
}

const report = readJson(REPORT);
const candidates = candidateIds();

const blocks = [];
const skippedMissing = [];
const skippedNoTexture = [];

for (const id of candidates.sort()) {
	const entry = report[id];
	if (!entry) {
		skippedMissing.push(id);
		continue;
	}

	const name = id.replace('minecraft:', '');
	const defaultStateEntry = entry.states.find((s) => s.default) ?? entry.states[0];
	const defaultState = defaultStateEntry?.properties ?? {};

	const modelRef = modelForBlock(name, defaultState);
	const textures = modelRef ? resolveModelTextures(modelRef) : {};
	const textureRef = pickTexture(textures);

	if (!textureRef) {
		skippedNoTexture.push(id);
		continue;
	}

	const sampled = averageColor(texturePath(textureRef));
	if (!sampled) {
		skippedNoTexture.push(id);
		continue;
	}

	const properties = entry.properties ?? {};
	const rotation = 'facing' in properties ? 'facing' : 'axis' in properties ? 'axis' : 'none';

	const block = {
		id,
		category: categoryOf(id),
		family: familyOf(id),
		color: applyTint(id, sampled.color),
		rotation,
		properties,
		defaultState,
	};
	if (sampled.transparent) block.transparent = true;
	if (id in LIGHT_LEVELS) block.light = LIGHT_LEVELS[id];

	blocks.push(block);
}

const output = {
	mcVersion: MC_VERSION,
	dataVersion: DATA_VERSION,
	generatedBy: 'tools/registry-gen/generate.mjs',
	blocks,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(output, null, '\t')}\n`, 'utf8');

const byCategory = {};
for (const b of blocks) byCategory[b.category] = (byCategory[b.category] ?? 0) + 1;

console.log(`wrote ${blocks.length} blocks -> ${path.relative(process.cwd(), OUT)}`);
console.log('by category:', Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
console.log(`skipped ${skippedMissing.length} non-existent candidates, ${skippedNoTexture.length} without a usable texture`);
if (skippedNoTexture.length) console.log('  no texture:', skippedNoTexture.slice(0, 20).join(', '));
