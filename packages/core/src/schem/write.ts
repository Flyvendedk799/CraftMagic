/**
 * Sponge Schematic v2 export.
 *
 * v2 rather than v3 because it is the format every tool in the ecosystem reads — WorldEdit,
 * Litematica converters, Axiom — and it is simple enough to write by hand with confidence.
 *
 * The conversion is almost free, and deliberately so: `VoxelGrid` already stores blocks in
 * YZX order with canonical blockstate strings, which is exactly Sponge's `BlockData` layout
 * and palette format. That choice was made in `ir/types.ts` precisely to make this a
 * straight varint encode instead of a transposition.
 */

import { gzipSync } from 'fflate';
import type { VoxelGrid } from '../ir/types.js';
import { DATA_VERSION } from '../registry/registry.js';
import { NbtWriter, varIntBytes } from './nbt-writer.js';

export interface SchemOptions {
	name?: string;
	author?: string;
	/**
	 * Minecraft data version to stamp. Defaults to the registry's (26.2 / 4903). Set this
	 * only when deliberately targeting another version — it does not convert any blocks.
	 */
	dataVersion?: number;
}

/** Largest dimension Sponge can express, since Width/Height/Length are signed shorts. */
const MAX_DIMENSION = 32767;

export function writeSchematic(grid: VoxelGrid, options: SchemOptions = {}): Uint8Array {
	const { x: width, y: height, z: length } = grid.size;
	if (width > MAX_DIMENSION || height > MAX_DIMENSION || length > MAX_DIMENSION) {
		throw new Error(
			`schematic dimensions ${width}x${height}x${length} exceed the format limit of ${MAX_DIMENSION}`,
		);
	}
	if (grid.palette.length === 0) {
		throw new Error('cannot export a grid with an empty palette');
	}

	const writer = new NbtWriter(grid.voxels.length + 2048);

	// Root is a compound named "Schematic"; v2 keeps every field flat inside it.
	writer.beginCompound('Schematic');

	writer.namedInt('Version', 2);
	writer.namedInt('DataVersion', options.dataVersion ?? DATA_VERSION);
	writer.namedShort('Width', width);
	writer.namedShort('Height', height);
	writer.namedShort('Length', length);
	writer.namedIntArray('Offset', [0, 0, 0]);

	writer.beginCompound('Palette');
	for (let i = 0; i < grid.palette.length; i++) {
		writer.namedInt(grid.palette[i]!, i);
	}
	writer.endCompound();

	writer.namedInt('PaletteMax', grid.palette.length);
	writer.namedByteArray('BlockData', varIntBytes(grid.voxels));

	writer.beginCompound('Metadata');
	writer.namedString('Name', options.name ?? 'CraftMagic build');
	writer.namedString('Author', options.author ?? 'CraftMagic');
	writer.endCompound();

	writer.endCompound(); // Schematic

	// Schematics are gzipped on disk; WorldEdit will not read a plain NBT stream.
	return gzipSync(writer.finish());
}

/** Filename-safe version of a build name, for the download. */
export function schematicFilename(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return `${slug || 'build'}.schem`;
}
