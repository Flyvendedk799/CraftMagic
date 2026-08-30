import { describe, expect, it } from 'vitest';
import {
  CHUNK_VOLUME,
  PAD_VOLUME,
  VoxelStore,
  chunkCounts,
  chunkKey,
  sliceChunk,
  type GridSize,
} from './voxelStore.js';
import { FLAG_EMISSIVE, FLAG_TRANSPARENT, meshChunk, meshStoredChunk } from './mesher.js';

const paletteColors = Uint8Array.of(0, 0, 0, 200, 180, 140, 180, 220, 240, 255, 240, 190);
const paletteFlags = Uint8Array.of(0, 0, FLAG_TRANSPARENT, FLAG_EMISSIVE);

/**
 * A grid with every case the mesher distinguishes in it — solid, glass against solid, glass
 * against the same glass, emissive, holes, and a surface that reaches all six faces of the
 * volume — on a size that is a multiple of 16 on no axis, so the edge chunks are partial.
 */
function scene(): { size: GridSize; voxels: Uint16Array } {
  const size = { x: 53, y: 45, z: 39 };
  const voxels = new Uint16Array(size.x * size.y * size.z);
  const at = (x: number, y: number, z: number) => x + z * size.x + y * size.x * size.z;

  let seed = 20260830;
  const next = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed >>> 16;
  };

  for (let z = 0; z < size.z; z++) {
    for (let x = 0; x < size.x; x++) {
      // Ground that touches y=0 and rolls back and forth across a chunk seam on the way up.
      // The seam is the case a padded gather can get wrong and a flat one cannot: the
      // surface a viewer actually looks at runs straight through where two chunks meet.
      const height = 14 + Math.round(6 * Math.sin(x / 5) + 5 * Math.cos(z / 4));
      for (let y = 0; y < height; y++) voxels[at(x, y, z)] = 1;
    }
  }

  // A hollow box standing clear of the ground, with glass in two walls: one pane against
  // stone, one pane against a pane.
  for (let y = 26; y < 40; y++) {
    for (let z = 4; z < 16; z++) {
      for (let x = 4; x < 26; x++) {
        const shell = y === 26 || y === 39 || z === 4 || z === 15 || x === 4 || x === 25;
        if (shell) voxels[at(x, y, z)] = 1;
      }
    }
  }
  for (let y = 30; y < 35; y++) for (let x = 8; x < 20; x++) voxels[at(x, y, 4)] = 2;
  for (let y = 30; y < 35; y++) for (let x = 8; x < 20; x++) voxels[at(x, y, 5)] = 2;
  for (let x = 10; x < 14; x++) voxels[at(x, 27, 8)] = 3;

  // Scattered blocks up near the far corner, so the last chunk on every axis is not empty.
  for (let i = 0; i < 400; i++) {
    const x = size.x - 1 - (next() % 6);
    const y = size.y - 1 - (next() % 6);
    const z = size.z - 1 - (next() % 6);
    voxels[at(x, y, z)] = 1 + (next() % 3);
  }

  return { size, voxels };
}

/** Pack a whole grid into a store the way `VoxelWorld` packs one for the worker. */
function store(size: GridSize, voxels: Uint16Array): VoxelStore {
  const counts = chunkCounts(size);
  const built = new VoxelStore(size);
  const cells = new Uint16Array(CHUNK_VOLUME);
  for (let cy = 0; cy < counts.y; cy++) {
    for (let cz = 0; cz < counts.z; cz++) {
      for (let cx = 0; cx < counts.x; cx++) {
        if (!sliceChunk(voxels, size, cx, cy, cz, cells, 0)) continue;
        built.putBatch(Int32Array.of(chunkKey(cx, cy, cz)), cells.slice());
      }
    }
  }
  return built;
}

describe('chunked voxel storage', () => {
  it('reads back every voxel of a grid whose size is a multiple of nothing', () => {
    const { size, voxels } = scene();
    const built = store(size, voxels);

    let wrong = 0;
    for (let y = 0; y < size.y; y++) {
      for (let z = 0; z < size.z; z++) {
        for (let x = 0; x < size.x; x++) {
          if (built.read(x, y, z) !== voxels[x + z * size.x + y * size.x * size.z]) wrong++;
        }
      }
    }
    expect(wrong).toBe(0);
  });

  it('answers air outside the grid rather than wrapping to the far side of it', () => {
    const { size, voxels } = scene();
    const built = store(size, voxels);
    expect(built.read(-1, 0, 0)).toBe(0);
    expect(built.read(size.x, 0, 0)).toBe(0);
    expect(built.read(0, size.y, 0)).toBe(0);
    expect(built.read(0, 0, -1)).toBe(0);
  });

  it('spends nothing on air, which is what makes a world fit', () => {
    const size = { x: 128, y: 160, z: 128 };
    const voxels = new Uint16Array(size.x * size.y * size.z);
    for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) voxels[x + z * size.x] = 1;

    const built = store(size, voxels);
    // One layer of ground under 159 of sky: the bottom plane of chunks and nothing above it,
    // where a flat array would have allocated all 80 planes.
    expect(built.storedChunks).toBe(8 * 8);
  });

  it('allocates a chunk for an edit that lands in air, and not for one that clears it', () => {
    const built = new VoxelStore({ x: 64, y: 64, z: 64 });
    built.write(20, 20, 20, 0);
    expect(built.storedChunks).toBe(0);

    built.write(20, 20, 20, 1);
    expect(built.storedChunks).toBe(1);
    expect(built.read(20, 20, 20)).toBe(1);

    built.writeIndex(21 + 20 * 64 + 20 * 64 * 64, 2);
    expect(built.read(21, 20, 20)).toBe(2);
  });
});

/**
 * First difference between two buffers, as something a failure message can print.
 *
 * A hand-rolled comparison rather than `expect(Array.from(a)).toEqual(Array.from(b))`,
 * because these run to hundreds of thousands of entries per chunk and letting the matcher
 * build and diff two boxed arrays of that size turned this file into a twenty-second test.
 */
function firstDifference(
  label: string,
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
): string | null {
  if (actual.length !== expected.length) {
    return `${label}: ${actual.length} entries vs ${expected.length}`;
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) return `${label}[${i}]: ${actual[i]} vs ${expected[i]}`;
  }
  return null;
}

describe('meshing from a store', () => {
  it('produces exactly the geometry the flat mesher produces, chunk for chunk', () => {
    const { size, voxels } = scene();
    const flat = { size, voxels, paletteColors, paletteFlags };
    const built = store(size, voxels);
    const counts = chunkCounts(size);
    const pad = new Uint16Array(PAD_VOLUME);

    let compared = 0;
    const differences: string[] = [];
    for (let cy = 0; cy < counts.y; cy++) {
      for (let cz = 0; cz < counts.z; cz++) {
        for (let cx = 0; cx < counts.x; cx++) {
          const expected = meshChunk(flat, cx, cy, cz);
          const actual = meshStoredChunk(built, paletteColors, paletteFlags, cx, cy, cz, pad);

          for (const layer of ['opaque', 'transparent'] as const) {
            const a = expected[layer];
            const b = actual[layer];
            const at = `chunk ${cx},${cy},${cz} ${layer}`;
            if (a === null || b === null) {
              if (a !== b) differences.push(`${at}: one path emitted geometry and the other did not`);
              continue;
            }
            // Byte for byte, not "roughly the same shape": ambient occlusion lives in the
            // colours, so a padded gather that got one context cell wrong would still mesh
            // the right faces and shade them differently.
            for (const difference of [
              firstDifference(`${at} positions`, b.positions, a.positions),
              firstDifference(`${at} colors`, b.colors, a.colors),
              firstDifference(`${at} indices`, b.indices, a.indices),
            ]) {
              if (difference) differences.push(difference);
            }
            compared++;
          }
        }
      }
    }

    expect(differences).toEqual([]);
    // Guards the guard: an empty comparison would pass every assertion above.
    expect(compared).toBeGreaterThan(15);
  });

  it('meshes nothing for a chunk of pure air, however solid its neighbours are', () => {
    const size = { x: 48, y: 48, z: 48 };
    const voxels = new Uint16Array(size.x * size.y * size.z);
    for (let y = 0; y < 16; y++)
      for (let z = 0; z < 48; z++)
        for (let x = 0; x < 48; x++) voxels[x + z * size.x + y * size.x * size.z] = 1;

    const built = store(size, voxels);
    const pad = new Uint16Array(PAD_VOLUME);
    const above = meshStoredChunk(built, paletteColors, paletteFlags, 1, 1, 1, pad);
    expect(above.opaque).toBeNull();
    expect(above.transparent).toBeNull();
  });
});
