/**
 * Culled chunk meshing with per-vertex ambient occlusion.
 *
 * Culled, not greedy. Greedy meshing merges coplanar faces into big quads, which is a
 * large triangle win — but AO is a *per-vertex* value, so two neighbouring faces can only
 * merge when all four of their AO corners agree. Enforcing that either kills most of the
 * merging or bleeds one voxel's occlusion across the merged quad. Culled meshing keeps AO
 * exact, and at CraftMagic's scale (a 500k-block cap, so a few hundred thousand quads
 * worst case) the triangle count is never the bottleneck — the per-frame draw call count
 * is, and chunking already bounds that.
 *
 * This module knows nothing about Minecraft. The caller flattens its block registry into
 * two parallel arrays indexed by palette slot, so the renderer stays usable for any voxel
 * source and the worker bundle never pulls in block data.
 */

/** Structurally identical to `VoxelGrid['size']`, restated so this file has no imports. */
export interface GridSize {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Bit 0 of a `paletteFlags` byte: see-through (glass, leaves) — meshed separately. */
export const FLAG_TRANSPARENT = 1;
/** Bit 1: full-bright. Skips face shading and AO, since the material is unlit. */
export const FLAG_EMISSIVE = 2;

/**
 * 16³, matching Minecraft's own chunk section. The number is a balance: smaller chunks
 * re-mesh faster after an edit but multiply draw calls, and 16 keeps a worst-case chunk
 * (24576 quads) comfortably inside a single buffer upload.
 */
export const CHUNK_SIZE = 16;

export interface MeshSource {
  size: GridSize;
  voxels: Uint16Array;
  /** 3 bytes (r,g,b) per palette index. */
  paletteColors: Uint8Array;
  /** 1 byte per palette index — see `FLAG_*`. */
  paletteFlags: Uint8Array;
}

/**
 * Indexed geometry. Indices are always Uint32 because a saturated chunk reaches 98304
 * vertices; WebGL2 has 32-bit indices in core so there is no reason to branch on size.
 * Normals are omitted — the material is unlit and all shading is baked into `colors`.
 */
export interface MeshBuffers {
  positions: Float32Array;
  /** Normalized bytes: bind with `new THREE.BufferAttribute(colors, 3, true)`. */
  colors: Uint8Array;
  indices: Uint32Array;
}

export interface ChunkMesh {
  cx: number;
  cy: number;
  cz: number;
  opaque: MeshBuffers | null;
  transparent: MeshBuffers | null;
}

interface FaceSpec {
  /** The cell this face looks into. */
  readonly n: readonly [number, number, number];
  /** Quad origin inside the voxel's unit cube. */
  readonly o: readonly [number, number, number];
  /** Tangents, chosen so `u × v === n` and the default winding faces outward. */
  readonly u: readonly [number, number, number];
  readonly v: readonly [number, number, number];
  /** Fake directional light, baked in because the material has none. */
  readonly shade: number;
}

const FACES: readonly FaceSpec[] = [
  // up
  { n: [0, 1, 0], o: [0, 1, 1], u: [1, 0, 0], v: [0, 0, -1], shade: 1.0 },
  // down
  { n: [0, -1, 0], o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], shade: 0.5 },
  // north (-Z)
  { n: [0, 0, -1], o: [1, 0, 0], u: [-1, 0, 0], v: [0, 1, 0], shade: 0.8 },
  // south (+Z)
  { n: [0, 0, 1], o: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], shade: 0.8 },
  // east (+X)
  { n: [1, 0, 0], o: [1, 0, 1], u: [0, 0, -1], v: [0, 1, 0], shade: 0.6 },
  // west (-X)
  { n: [-1, 0, 0], o: [0, 0, 0], u: [0, 0, 1], v: [0, 1, 0], shade: 0.6 },
];

/** Occlusion level 0..3 → brightness multiplier. The classic Minecraft-ish ramp. */
const AO_FACTOR = [0.5, 0.65, 0.8, 1.0] as const;

/** Corner order (u,v): (0,0) (1,0) (1,1) (0,1) — counter-clockwise seen from outside. */
const CORNER_U = [0, 1, 1, 0] as const;
const CORNER_V = [0, 0, 1, 1] as const;

/** How many 16³ chunks the grid spans on each axis. */
export function chunkCounts(size: GridSize): GridSize {
  return {
    x: Math.ceil(size.x / CHUNK_SIZE),
    y: Math.ceil(size.y / CHUNK_SIZE),
    z: Math.ceil(size.z / CHUNK_SIZE),
  };
}

/**
 * Mesh one chunk, reading neighbours straight out of the shared grid.
 *
 * Deliberately no per-chunk padding copy: at 1300 chunks a padded 18³ copy would cost more
 * in memcpy and allocation than the bounds check saves, and padding would have to be
 * rebuilt on every edit that lands near a seam.
 */
export function meshChunk(src: MeshSource, cx: number, cy: number, cz: number): ChunkMesh {
  const { size, voxels, paletteColors, paletteFlags } = src;
  const sx = size.x;
  const sy = size.y;
  const sz = size.z;
  const layer = sx * sz;

  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const x1 = Math.min(x0 + CHUNK_SIZE, sx);
  const y1 = Math.min(y0 + CHUNK_SIZE, sy);
  const z1 = Math.min(z0 + CHUNK_SIZE, sz);

  const opaque = new QuadSink();
  const transparent = new QuadSink();

  // Out of bounds reads as air so the outside of the structure keeps its faces.
  const at = (x: number, y: number, z: number): number =>
    x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz ? 0 : voxels[x + z * sx + y * layer]!;

  // Glass does not cast AO; only fully opaque blocks occlude.
  const occludes = (x: number, y: number, z: number): boolean => {
    const v = at(x, y, z);
    return v !== 0 && (paletteFlags[v]! & FLAG_TRANSPARENT) === 0;
  };

  const pos = new Float32Array(12);
  const col = new Uint8Array(12);
  const ao = new Float32Array(4);

  for (let y = y0; y < y1; y++) {
    for (let z = z0; z < z1; z++) {
      const rowBase = z * sx + y * layer;
      for (let x = x0; x < x1; x++) {
        const self = voxels[rowBase + x]!;
        if (self === 0) continue;

        const flags = paletteFlags[self]!;
        const selfTransparent = (flags & FLAG_TRANSPARENT) !== 0;
        const emissive = (flags & FLAG_EMISSIVE) !== 0;
        const sink = selfTransparent ? transparent : opaque;

        const cBase = self * 3;
        const baseR = paletteColors[cBase]!;
        const baseG = paletteColors[cBase + 1]!;
        const baseB = paletteColors[cBase + 2]!;

        for (let fi = 0; fi < FACES.length; fi++) {
          const f = FACES[fi]!;
          const nx = x + f.n[0];
          const ny = y + f.n[1];
          const nz = z + f.n[2];

          const neighbour = at(nx, ny, nz);
          if (neighbour !== 0) {
            if ((paletteFlags[neighbour]! & FLAG_TRANSPARENT) === 0) continue;
            // Two panes of the *same* glass fuse the way Minecraft fuses them; two
            // different see-through blocks keep both faces, because the seam is visible.
            if (selfTransparent && neighbour === self) continue;
          }

          const shade = emissive ? 1 : f.shade;
          const litR = baseR * shade;
          const litG = baseG * shade;
          const litB = baseB * shade;

          for (let k = 0; k < 4; k++) {
            const cu = CORNER_U[k]!;
            const cv = CORNER_V[k]!;
            const p = k * 3;
            pos[p] = x + f.o[0] + f.u[0] * cu + f.v[0] * cv;
            pos[p + 1] = y + f.o[1] + f.u[1] * cu + f.v[1] * cv;
            pos[p + 2] = z + f.o[2] + f.u[2] * cu + f.v[2] * cv;

            let factor = 1;
            if (!emissive) {
              // Occluders live in the layer of air the face looks into, offset along the
              // two tangents towards the corner being lit.
              const du = cu * 2 - 1;
              const dv = cv * 2 - 1;
              const s1 = occludes(nx + f.u[0] * du, ny + f.u[1] * du, nz + f.u[2] * du);
              const s2 = occludes(nx + f.v[0] * dv, ny + f.v[1] * dv, nz + f.v[2] * dv);
              // A corner wedged between two occluders is fully dark regardless of the
              // diagonal — checking it would let light leak through a closed inside corner.
              const level = s1 && s2 ? 0 : 3 - (+s1 + +s2 + +occludes(
                nx + f.u[0] * du + f.v[0] * dv,
                ny + f.u[1] * du + f.v[1] * dv,
                nz + f.u[2] * du + f.v[2] * dv,
              ));
              factor = AO_FACTOR[level]!;
            }
            ao[k] = factor;

            // +0.5 rounds: storing into a Uint8Array truncates, and the inputs can never
            // reach 255.5 because base ≤ 255 and both multipliers are ≤ 1.
            col[p] = litR * factor + 0.5;
            col[p + 1] = litG * factor + 0.5;
            col[p + 2] = litB * factor + 0.5;
          }

          // Flip the split so the diagonal runs between the two *brighter* corners.
          // Without this, a quad with one dark corner shows the notorious AO seam: the
          // gradient bends along the fixed diagonal instead of towards the dark corner.
          sink.push(pos, col, ao[0]! + ao[2]! > ao[1]! + ao[3]!);
        }
      }
    }
  }

  return { cx, cy, cz, opaque: opaque.take(), transparent: transparent.take() };
}

/** Push every buffer of a mesh onto a transfer list, so postMessage moves rather than copies. */
export function collectTransferables(mesh: ChunkMesh, into: ArrayBuffer[]): ArrayBuffer[] {
  for (const buffers of [mesh.opaque, mesh.transparent]) {
    if (!buffers) continue;
    into.push(buffers.positions.buffer as ArrayBuffer);
    into.push(buffers.colors.buffer as ArrayBuffer);
    into.push(buffers.indices.buffer as ArrayBuffer);
  }
  return into;
}

/** Growable quad accumulator. Doubling beats a `number[]` — no boxing, no final copy pass. */
class QuadSink {
  private capacity: number;
  private quads = 0;
  private positions: Float32Array;
  private colors: Uint8Array;
  private indices: Uint32Array;

  constructor(capacity = 512) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 12);
    this.colors = new Uint8Array(capacity * 12);
    this.indices = new Uint32Array(capacity * 6);
  }

  push(pos: Float32Array, col: Uint8Array, flip: boolean): void {
    if (this.quads === this.capacity) this.grow();

    const q = this.quads++;
    this.positions.set(pos, q * 12);
    this.colors.set(col, q * 12);

    const base = q * 4;
    const o = q * 6;
    const idx = this.indices;
    if (flip) {
      idx[o] = base + 1;
      idx[o + 1] = base + 2;
      idx[o + 2] = base + 3;
      idx[o + 3] = base + 1;
      idx[o + 4] = base + 3;
      idx[o + 5] = base;
    } else {
      idx[o] = base;
      idx[o + 1] = base + 1;
      idx[o + 2] = base + 2;
      idx[o + 3] = base;
      idx[o + 4] = base + 2;
      idx[o + 5] = base + 3;
    }
  }

  /** Exact-sized copies, so each buffer can be transferred and handed straight to the GPU. */
  take(): MeshBuffers | null {
    if (this.quads === 0) return null;
    return {
      positions: this.positions.slice(0, this.quads * 12),
      colors: this.colors.slice(0, this.quads * 12),
      indices: this.indices.slice(0, this.quads * 6),
    };
  }

  private grow(): void {
    this.capacity *= 2;
    const positions = new Float32Array(this.capacity * 12);
    positions.set(this.positions);
    this.positions = positions;
    const colors = new Uint8Array(this.capacity * 12);
    colors.set(this.colors);
    this.colors = colors;
    const indices = new Uint32Array(this.capacity * 6);
    indices.set(this.indices);
    this.indices = indices;
  }
}

/* ---------------------------------------------------------------------------------------
 * Worker protocol. Lives here because both sides import this module anyway, and keeping it
 * out of the worker file means the main thread never has to import the worker for a type.
 * ------------------------------------------------------------------------------------ */

/** Hands the worker its own snapshot of the grid; `voxels` is transferred, not copied. */
export interface MesherLoad {
  t: 'load';
  size: GridSize;
  voxels: Uint16Array;
  paletteColors: Uint8Array;
  paletteFlags: Uint8Array;
}

/** Keeps the worker's snapshot in step with an edit, without re-sending the whole grid. */
export interface MesherEdit {
  t: 'edit';
  indices: Uint32Array;
  values: Uint16Array;
}

/**
 * Widens the colour/flag tables after a palette slot was appended.
 *
 * Separate from `load` because appending a slot cannot invalidate a single existing mesh —
 * no voxel references the new index until an edit puts one there, and that edit dirties its
 * own chunks. Re-loading instead would re-mesh the whole structure to redraw nothing.
 */
export interface MesherPalette {
  t: 'palette';
  paletteColors: Uint8Array;
  paletteFlags: Uint8Array;
}

/** `chunks` is a flat run of (cx, cy, cz) triples. */
export interface MesherMesh {
  t: 'mesh';
  batchId: number;
  chunks: Int32Array;
}

export type MesherRequest = MesherLoad | MesherEdit | MesherPalette | MesherMesh;

export interface MesherResponse {
  t: 'meshed';
  batchId: number;
  meshes: ChunkMesh[];
}
