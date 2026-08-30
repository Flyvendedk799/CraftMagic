/**
 * Voxels held as 16³ chunks instead of one array covering the whole volume.
 *
 * A flat `Uint16Array` is the right shape for a building: 256×160×256 is 21 MB, it indexes
 * with two multiplies, and every neighbour of every voxel is a fixed stride away. It is the
 * wrong shape for a world. 1024×160×1024 is 320 MB in one contiguous allocation that has to
 * succeed all at once, and a browser that has been open for an hour frequently cannot hand
 * out 320 MB of contiguous address space even when it has the memory.
 *
 * Chunking removes both problems at once. Nothing bigger than 8 KB is ever allocated, and an
 * all-air chunk is simply absent rather than 8 KB of zeroes — which is most of a world, since
 * terrain occupies the bottom fifth of its plot and buildings are hollow. A 1024×160×1024
 * world of ordinary terrain lands around 30 MB here.
 *
 * The cost is neighbour access, and it is paid once per chunk rather than once per voxel:
 * `neighbourhood` gathers the chunk plus one cell of context on every side into a padded 18³
 * block, and the mesher reads that with the same flat indexing it always used. Gathering is
 * 324 typed-array row copies; meshing the same chunk is tens of thousands of face tests, so
 * the gather does not show up.
 *
 * No imports, deliberately: this module is loaded by the meshing worker, and a worker bundle
 * that pulls in the app's dependency graph is a second copy of it.
 */

/** Structurally identical to `VoxelGrid['size']`. */
export interface GridSize {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * 16³, matching Minecraft's own chunk section. The number is a balance: smaller chunks
 * re-mesh faster after an edit but multiply draw calls, and 16 keeps a worst-case chunk
 * (24576 quads) comfortably inside a single buffer upload.
 */
export const CHUNK_SIZE = 16;

const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;

/** Cells in one chunk — the length of every array this store holds. */
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;

/** Edge of the padded gather block: the chunk plus one cell of context on each side. */
export const PAD_SIZE = CHUNK_SIZE + 2;

const PAD_AREA = PAD_SIZE * PAD_SIZE;

/** Cells in one gather block — the size of the scratch buffer a mesher has to hand over. */
export const PAD_VOLUME = PAD_SIZE * PAD_SIZE * PAD_SIZE;

/** The padded block, described as a grid so the mesher can read it as an ordinary source. */
export const PAD_GRID: GridSize = { x: PAD_SIZE, y: PAD_SIZE, z: PAD_SIZE };

/** How many 16³ chunks the grid spans on each axis. */
export function chunkCounts(size: GridSize): GridSize {
  return {
    x: Math.ceil(size.x / CHUNK_SIZE),
    y: Math.ceil(size.y / CHUNK_SIZE),
    z: Math.ceil(size.z / CHUNK_SIZE),
  };
}

/**
 * Chunk coordinates pack into one integer key: numeric Map keys avoid the string churn a
 * `"x,y,z"` key would create on every dirty-set operation during a drag-edit.
 * 10 bits per axis covers 1024 chunks, so 16384 blocks — past any plot this will be asked
 * to hold, and the reason worlds needed no new key format.
 */
export function chunkKey(cx: number, cy: number, cz: number): number {
  return (cx & 1023) | ((cy & 1023) << 10) | ((cz & 1023) << 20);
}

export function unpackKey(key: number): [number, number, number] {
  return [key & 1023, (key >> 10) & 1023, (key >> 20) & 1023];
}

/**
 * The voxels of one grid, chunk by chunk.
 *
 * Reads outside the grid, and reads of chunks that were never stored, answer air. That is the
 * same rule the flat mesher used for out-of-bounds reads, and it is what lets an absent chunk
 * stand in for 8 KB of zeroes everywhere rather than only at the edges.
 */
export class VoxelStore {
  readonly size: GridSize;
  readonly counts: GridSize;

  private readonly chunks = new Map<number, Uint16Array>();

  /** Scratch for `neighbourhood`: the 3×3×3 chunks one gather can touch. Reused, not rebuilt. */
  private readonly near: (Uint16Array | undefined)[] = new Array(27);

  constructor(size: GridSize) {
    this.size = size;
    this.counts = chunkCounts(size);
  }

  /** Chunks actually holding something. Air costs nothing, so this is the memory story. */
  get storedChunks(): number {
    return this.chunks.size;
  }

  /**
   * Adopt a batch of chunk contents.
   *
   * `cells` is one buffer holding `keys.length` chunks back to back, and each chunk is kept
   * as a *view* into it rather than a copy — which is what makes handing a world across to
   * the worker cost one transfer per batch instead of one allocation per chunk.
   */
  putBatch(keys: Int32Array, cells: Uint16Array): void {
    for (let i = 0; i < keys.length; i++) {
      this.chunks.set(keys[i]!, cells.subarray(i * CHUNK_VOLUME, (i + 1) * CHUNK_VOLUME));
    }
  }

  read(x: number, y: number, z: number): number {
    const { x: sx, y: sy, z: sz } = this.size;
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return 0;
    const chunk = this.chunks.get(chunkKey(x >> 4, y >> 4, z >> 4));
    if (!chunk) return 0;
    return chunk[(x & 15) + (z & 15) * CHUNK_SIZE + (y & 15) * CHUNK_AREA]!;
  }

  /**
   * Write one voxel, allocating its chunk if the edit is the first thing in it.
   *
   * Clearing a voxel in a chunk that does not exist stays a no-op rather than allocating
   * 8 KB to store air — otherwise an eraser dragged across empty sky would materialise the
   * whole sky.
   */
  write(x: number, y: number, z: number, value: number): void {
    const { x: sx, y: sy, z: sz } = this.size;
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return;
    const key = chunkKey(x >> 4, y >> 4, z >> 4);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      if (value === 0) return;
      chunk = new Uint16Array(CHUNK_VOLUME);
      this.chunks.set(key, chunk);
    }
    chunk[(x & 15) + (z & 15) * CHUNK_SIZE + (y & 15) * CHUNK_AREA] = value;
  }

  /** The same write, addressed the way an `EditOp` addresses it — a flat grid index. */
  writeIndex(index: number, value: number): void {
    const { x: sx, z: sz } = this.size;
    const layer = sx * sz;
    const y = Math.floor(index / layer);
    const rem = index - y * layer;
    const z = Math.floor(rem / sx);
    this.write(rem - z * sx, y, z, value);
  }

  /**
   * Gather one chunk and a one-cell rind of its neighbours into `pad`, laid out as an 18³
   * grid so the mesher can index it exactly as it indexes a flat build.
   *
   * One cell of context is enough, and that is worth stating: ambient occlusion samples the
   * cell a face looks into offset along the face's two tangents, and since the normal and
   * both tangents are orthogonal unit vectors, no sample is ever more than one cell away on
   * any axis.
   *
   * Returns false when the chunk itself is air, which is the common case in a world and
   * needs no gather at all: faces belong to solid voxels, so a chunk with none emits nothing
   * however solid its neighbours are.
   */
  neighbourhood(cx: number, cy: number, cz: number, pad: Uint16Array): boolean {
    if (!this.chunks.get(chunkKey(cx, cy, cz))) return false;

    // The 3×3×3 block of chunks the pad can touch, resolved once. Doing it per row instead
    // would be 972 map lookups for a gather that only ever reads 27 chunks.
    const near = this.near;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          const nz = cz + dz;
          const inside =
            nx >= 0 && ny >= 0 && nz >= 0 &&
            nx < this.counts.x && ny < this.counts.y && nz < this.counts.z;
          near[(dy + 1) * 9 + (dz + 1) * 3 + (dx + 1)] = inside
            ? this.chunks.get(chunkKey(nx, ny, nz))
            : undefined;
        }
      }
    }

    pad.fill(0);

    const { x: sx, y: sy, z: sz } = this.size;
    const x0 = cx * CHUNK_SIZE;
    const y0 = cy * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    const width = Math.min(CHUNK_SIZE, sx - x0);

    for (let py = 0; py < PAD_SIZE; py++) {
      const wy = y0 - 1 + py;
      if (wy < 0 || wy >= sy) continue;
      const dy = (wy >> 4) - cy;
      const ly = wy & 15;

      for (let pz = 0; pz < PAD_SIZE; pz++) {
        const wz = z0 - 1 + pz;
        if (wz < 0 || wz >= sz) continue;
        const dz = (wz >> 4) - cz;
        const lz = wz & 15;

        const row = ly * CHUNK_AREA + lz * CHUNK_SIZE;
        const out = py * PAD_AREA + pz * PAD_SIZE;
        const base = (dy + 1) * 9 + (dz + 1) * 3 + 1;

        // Three runs along x: the context cell to the left, the chunk's own row, and the
        // context cell to the right. Splitting on the chunk boundary is what lets the middle
        // run be a single typed-array copy.
        if (x0 > 0) {
          const left = near[base - 1];
          if (left) pad[out] = left[row + CHUNK_SIZE - 1]!;
        }
        const middle = near[base];
        if (middle) pad.set(middle.subarray(row, row + width), out + 1);
        if (x0 + CHUNK_SIZE < sx) {
          const right = near[base + 1];
          if (right) pad[out + CHUNK_SIZE + 1] = right[row]!;
        }
      }
    }

    return true;
  }
}

/**
 * Copy one chunk out of a flat grid, reporting whether it holds anything at all.
 *
 * Kept beside the store rather than inside it because it is the *bridge* between the two
 * representations: it belongs to whoever still has a flat grid in hand, and the store itself
 * never needs to know that shape exists.
 */
export function sliceChunk(
  voxels: Uint16Array,
  size: GridSize,
  cx: number,
  cy: number,
  cz: number,
  dest: Uint16Array,
  at: number,
): boolean {
  const layer = size.x * size.z;
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const width = Math.min(CHUNK_SIZE, size.x - x0);
  const height = Math.min(CHUNK_SIZE, size.y - y0);
  const depth = Math.min(CHUNK_SIZE, size.z - z0);

  // An edge chunk leaves part of its slot unwritten, and the slot is reused by whichever
  // chunk is packed there next. Without this, a grid whose size is not a multiple of 16
  // grows a fringe of the previous chunk's blocks along its far faces.
  if (width < CHUNK_SIZE || height < CHUNK_SIZE || depth < CHUNK_SIZE) {
    dest.fill(0, at, at + CHUNK_VOLUME);
  }

  let solid = false;
  for (let ly = 0; ly < height; ly++) {
    for (let lz = 0; lz < depth; lz++) {
      const from = x0 + (z0 + lz) * size.x + (y0 + ly) * layer;
      const row = voxels.subarray(from, from + width);
      if (!solid) {
        for (let i = 0; i < width; i++) {
          if (row[i] !== 0) {
            solid = true;
            break;
          }
        }
      }
      dest.set(row, at + ly * CHUNK_AREA + lz * CHUNK_SIZE);
    }
  }
  return solid;
}
