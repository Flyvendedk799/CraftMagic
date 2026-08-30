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

import {
  CHUNK_SIZE,
  PAD_GRID,
  PAD_VOLUME,
  chunkCounts,
  type GridSize,
  type VoxelStore,
} from './voxelStore.js';

// The one import this file has, and it imports nothing itself — so the worker bundle is still
// the mesher and its arithmetic. Re-exported because a caller that meshes a chunk invariably
// also needs to know how big one is, and splitting that across two modules buys nothing.
export { CHUNK_SIZE, PAD_VOLUME, chunkCounts, type GridSize };

/** Bit 0 of a `paletteFlags` byte: see-through (glass, leaves) — meshed separately. */
export const FLAG_TRANSPARENT = 1;
/** Bit 1: full-bright. Skips face shading and AO, since the material is unlit. */
export const FLAG_EMISSIVE = 2;

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

/**
 * Which face of a voxel a cut through each side of a clip box exposes, as an index into
 * `FACES`. The order matches `ClipBox`'s own — minX, maxX, minY, maxY, minZ, maxZ — so a
 * caller holding a mask over the box's faces can reuse the same bit positions here.
 */
const CUT_FACE: readonly number[] = [5, 4, 1, 0, 2, 3];

/** Occlusion level 0..3 → brightness multiplier. The classic Minecraft-ish ramp. */
const AO_FACTOR = [0.5, 0.65, 0.8, 1.0] as const;

/** Corner order (u,v): (0,0) (1,0) (1,1) (0,1) — counter-clockwise seen from outside. */
const CORNER_U = [0, 1, 1, 0] as const;
const CORNER_V = [0, 0, 1, 1] as const;

/**
 * Mesh one chunk of a flat grid, reading neighbours straight out of it.
 *
 * Deliberately no per-chunk padding copy on this path: at 1300 chunks a padded 18³ copy
 * would cost more in memcpy and allocation than the bounds check saves, and padding would
 * have to be rebuilt on every edit that lands near a seam. `meshStoredChunk` does pad,
 * because a chunked store has no flat array to point a stride at.
 */
export function meshChunk(src: MeshSource, cx: number, cy: number, cz: number): ChunkMesh {
  const { size } = src;
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;

  const { opaque, transparent } = meshBox(
    src,
    x0,
    y0,
    z0,
    Math.min(x0 + CHUNK_SIZE, size.x),
    Math.min(y0 + CHUNK_SIZE, size.y),
    Math.min(z0 + CHUNK_SIZE, size.z),
    0,
    0,
    0,
  );
  return { cx, cy, cz, opaque, transparent };
}

/**
 * Mesh one chunk out of a chunked store.
 *
 * The store gathers the chunk and one cell of context into `pad`, and from there this is the
 * same walk over the same faces with the same ambient occlusion — the mesher never learns
 * that the voxels arrived in pieces. `pad` is the caller's, reused across every chunk, so a
 * world costs one 12 KB scratch buffer rather than one per chunk.
 */
export function meshStoredChunk(
  store: VoxelStore,
  paletteColors: Uint8Array,
  paletteFlags: Uint8Array,
  cx: number,
  cy: number,
  cz: number,
  pad: Uint16Array,
): ChunkMesh {
  if (!store.neighbourhood(cx, cy, cz, pad)) return { cx, cy, cz, opaque: null, transparent: null };

  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const src: MeshSource = { size: PAD_GRID, voxels: pad, paletteColors, paletteFlags };

  // The chunk sits at [1, 1+extent) inside the pad, and its blocks belong at `x0` in the
  // world, so the origin walks the emitted positions back by the one cell of padding.
  const { opaque, transparent } = meshBox(
    src,
    1,
    1,
    1,
    1 + Math.min(CHUNK_SIZE, store.size.x - x0),
    1 + Math.min(CHUNK_SIZE, store.size.y - y0),
    1 + Math.min(CHUNK_SIZE, store.size.z - z0),
    x0 - 1,
    y0 - 1,
    z0 - 1,
  );
  return { cx, cy, cz, opaque, transparent };
}

/**
 * The mesher proper: every face of every solid voxel in a half-open box, with `o*` added to
 * the positions it emits.
 *
 * The offset is what lets the padded and unpadded paths share one loop instead of two copies
 * of the ambient-occlusion arithmetic — the place a divergence would be least visible and
 * most damaging, since a subtly different AO ramp on one path is a rendering bug nobody can
 * point at.
 */
function meshBox(
  src: MeshSource,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  ox: number,
  oy: number,
  oz: number,
): { opaque: MeshBuffers | null; transparent: MeshBuffers | null } {
  const { size, voxels, paletteColors, paletteFlags } = src;
  const sx = size.x;
  const sy = size.y;
  const sz = size.z;
  const layer = sx * sz;

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
            pos[p] = ox + x + f.o[0] + f.u[0] * cu + f.v[0] * cv;
            pos[p + 1] = oy + y + f.o[1] + f.u[1] * cu + f.v[1] * cv;
            pos[p + 2] = oz + z + f.o[2] + f.u[2] * cu + f.v[2] * cv;

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

  return { opaque: opaque.take(), transparent: transparent.take() };
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

/**
 * A box to keep, in inclusive block coordinates. An absent face is not cut.
 *
 * Structurally the renderer's `ClipBox`, restated here so this module keeps its no-imports
 * property and stays usable away from the editor.
 */
export interface CutBox {
  minX?: number | null;
  maxX?: number | null;
  minY?: number | null;
  maxY?: number | null;
  minZ?: number | null;
  maxZ?: number | null;
}

/**
 * The skin of a cutaway: the faces a cut through solid material exposes.
 *
 * A voxel mesher culls the face between two solid blocks, because nothing can ever see it.
 * Hiding half a building behind clipping planes breaks that promise — those faces are gone
 * from the geometry rather than merely hidden, so the cut looks straight through whatever it
 * passed through. In a floorplan that is not a subtle artefact. The party wall between two
 * rooms has its top face culled against the ceiling, so a storey cutaway seen from above
 * shows a one-block slot of background exactly where the shared wall is: two rooms that share
 * a wall read as two rooms with a gap between them, and the plan looks like it lied.
 *
 * The repair is the mirror image of the cull. A cut face is precisely a face the mesher
 * declined to emit *because* of a neighbour the cut has since hidden, so walking the six
 * planes of the box and emitting those — and only those — restores the surface without ever
 * double-covering a face that was already drawn.
 *
 * Cost is per unit of cut *area*, not volume, and the box moves far more often than the
 * voxels do. That is what keeps a scrubbed layer slider affordable: the chunks stay meshed
 * and clipped exactly as they were, and only this skin is rebuilt.
 */
export function meshCuts(
  src: MeshSource,
  box: CutBox,
): { opaque: MeshBuffers | null; transparent: MeshBuffers | null } {
  const { size, voxels, paletteColors, paletteFlags } = src;
  const layer = size.x * size.z;
  const limit: readonly number[] = [size.x, size.y, size.z];

  const opaque = new QuadSink();
  const transparent = new QuadSink();

  const at = (x: number, y: number, z: number): number =>
    x < 0 || y < 0 || z < 0 || x >= size.x || y >= size.y || z >= size.z
      ? 0
      : voxels[x + z * size.x + y * layer]!;

  const faces: (number | null | undefined)[] = [
    box.minX,
    box.maxX,
    box.minY,
    box.maxY,
    box.minZ,
    box.maxZ,
  ];

  const pos = new Float32Array(12);
  const col = new Uint8Array(12);

  for (let bi = 0; bi < faces.length; bi++) {
    const bound = faces[bi];
    if (bound === null || bound === undefined) continue;

    const axis = bi >> 1;
    // A cut outside the grid, or on its outermost cell facing outwards, exposes nothing:
    // there was never a neighbour there for the mesher to cull against.
    if (bound < 0 || bound >= limit[axis]!) continue;
    if (bi % 2 === 0 ? bound === 0 : bound === limit[axis]! - 1) continue;

    const f = FACES[CUT_FACE[bi]!]!;
    // The two axes the cut plane spans: x,y,z with the cut's own axis removed.
    const spanA = axis === 0 ? 1 : 0;
    const spanB = axis === 2 ? 1 : 2;
    const cell = [0, 0, 0];
    cell[axis] = bound;

    for (let a = 0; a < limit[spanA]!; a++) {
      cell[spanA] = a;
      for (let b = 0; b < limit[spanB]!; b++) {
        cell[spanB] = b;
        const x = cell[0]!;
        const y = cell[1]!;
        const z = cell[2]!;

        const self = voxels[x + z * size.x + y * layer]!;
        if (self === 0) continue;

        const neighbour = at(x + f.n[0]!, y + f.n[1]!, z + f.n[2]!);
        // Exactly the mesher's cull test, negated: emit only where it stayed silent.
        if (neighbour === 0) continue;
        const selfTransparent = (paletteFlags[self]! & FLAG_TRANSPARENT) !== 0;
        if (
          (paletteFlags[neighbour]! & FLAG_TRANSPARENT) !== 0 &&
          !(selfTransparent && neighbour === self)
        ) {
          continue;
        }

        const shade = (paletteFlags[self]! & FLAG_EMISSIVE) !== 0 ? 1 : f.shade;
        const cBase = self * 3;
        // No ambient occlusion. Every occluder a cut face would sample lives on the far side
        // of the cut — the half deliberately hidden — so shading with them would darken the
        // surface using geometry the viewer has been shown none of.
        const r = paletteColors[cBase]! * shade + 0.5;
        const g = paletteColors[cBase + 1]! * shade + 0.5;
        const bl = paletteColors[cBase + 2]! * shade + 0.5;

        for (let k = 0; k < 4; k++) {
          const cu = CORNER_U[k]!;
          const cv = CORNER_V[k]!;
          const p = k * 3;
          pos[p] = x + f.o[0]! + f.u[0]! * cu + f.v[0]! * cv;
          pos[p + 1] = y + f.o[1]! + f.u[1]! * cu + f.v[1]! * cv;
          pos[p + 2] = z + f.o[2]! + f.u[2]! * cu + f.v[2]! * cv;
          col[p] = r;
          col[p + 1] = g;
          col[p + 2] = bl;
        }

        (selfTransparent ? transparent : opaque).push(pos, col, false);
      }
    }
  }

  return { opaque: opaque.take(), transparent: transparent.take() };
}

/* ---------------------------------------------------------------------------------------
 * Worker protocol. Lives here because both sides import this module anyway, and keeping it
 * out of the worker file means the main thread never has to import the worker for a type.
 * ------------------------------------------------------------------------------------ */

/**
 * Opens a new structure: the worker throws away whatever it held and waits for chunks.
 *
 * No voxels ride along. They used to — one `slice()` of the whole grid, transferred — which
 * meant the main thread had to hold two copies of a build at once at the exact moment it was
 * least able to afford them. A world is delivered as `chunks` batches instead, so the
 * transient cost of loading one is a megabyte rather than the whole thing again.
 */
export interface MesherLoad {
  t: 'load';
  size: GridSize;
  paletteColors: Uint8Array;
  paletteFlags: Uint8Array;
}

/**
 * A batch of chunk contents for the structure most recently opened.
 *
 * `keys` are packed chunk coordinates and `cells` holds their voxels back to back, one
 * buffer for the batch: one transfer instead of one per chunk, and the worker keeps views
 * into it rather than copying. Chunks that are entirely air are simply never sent.
 */
export interface MesherChunks {
  t: 'chunks';
  keys: Int32Array;
  cells: Uint16Array;
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

export type MesherRequest = MesherLoad | MesherChunks | MesherEdit | MesherPalette | MesherMesh;

export interface MesherResponse {
  t: 'meshed';
  batchId: number;
  meshes: ChunkMesh[];
}
