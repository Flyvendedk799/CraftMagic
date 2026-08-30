/**
 * Chunk-mesh manager.
 *
 * Deliberately imperative and outside React. A 300k-block structure is ~1300 chunks; if
 * those were r3f elements, every edit would walk a 1300-node child list through the
 * reconciler and three.js would rebuild render lists it did not need to. Here React owns
 * exactly one object — the group — and everything below it is mutated in place.
 *
 * The materials are unlit `MeshBasicMaterial`s. All shading (face direction and ambient
 * occlusion) is baked into vertex colours by the mesher, which means no lights, no normal
 * attribute, and the cheapest shader three.js has.
 */

import * as THREE from 'three';
import { voxelIndex, type EditOp, type VoxelGrid } from '@craftmagic/core';
import { classicMaterials, type WorldMaterials } from './materials.js';
import {
  CHUNK_SIZE,
  chunkCounts,
  meshChunk,
  meshCuts,
  type MeshBuffers,
  type MeshSource,
  type MesherRequest,
  type MesherResponse,
} from './mesher.js';

/** Geometry uploads per frame. Each one is a GPU buffer upload, so this is the frame budget. */
const UPLOADS_PER_FRAME = 40;
/** Chunks requested per worker message — big enough to amortise postMessage, small enough to stream. */
const REQUEST_BATCH = 48;
/** Cap on outstanding work so a reload cannot queue thousands of stale chunks. */
const MAX_IN_FLIGHT = 192;

/** How far past a block boundary a clipping plane sits, to keep it off any face. */
const CLIP_EPSILON = 0.001;

/** Half-diagonal of a 16³ cube; every chunk shares it, so the bounding sphere is free. */
const CHUNK_RADIUS = (CHUNK_SIZE * Math.sqrt(3)) / 2;

/**
 * A box to show and hide everything outside of, in inclusive block coordinates.
 *
 * Every face is optional and an absent one is *uncut*, not "cut at the edge of the build".
 * That distinction is the whole ergonomics of the type: a layer slider wants two faces and
 * pays for two planes, and only a caller that actually wants a room-shaped hole in a building
 * pays for six.
 */
export interface ClipBox {
  minX?: number | null;
  maxX?: number | null;
  minY?: number | null;
  maxY?: number | null;
  minZ?: number | null;
  maxZ?: number | null;
}

interface ChunkEntry {
  opaque?: THREE.Mesh;
  transparent?: THREE.Mesh;
}

export class VoxelWorld {
  readonly group = new THREE.Group();

  private readonly opaqueMaterial: THREE.Material;
  private readonly transparentMaterial: THREE.Material;

  /**
   * The cut surface, as one mesh rather than a chunked set.
   *
   * It is per-area where the chunks are per-volume, it changes on a different clock from
   * them — the box moves under a drag while the voxels sit still — and it has no use for the
   * upload budget, since one geometry cannot stall a frame the way four hundred can.
   */
  private cuts: ChunkEntry = {};
  private cutsStale = false;

  private readonly chunks = new Map<number, ChunkEntry>();
  private readonly dirty = new Set<number>();
  private readonly inFlight = new Set<number>();
  private readonly pending: MesherResponse['meshes'] = [];

  private grid: VoxelGrid | null = null;
  private source: MeshSource | null = null;
  private counts = { x: 0, y: 0, z: 0 };

  private worker: Worker | null = null;
  private batchId = 0;
  /** Batches issued before the current `load()`; their results are dropped on arrival. */
  private generation = 0;

  /**
   * One plane per face of the clip box, in a fixed order, with fixed normals.
   *
   * Persistent objects whose constants are rewritten in place: the plane *count* is what
   * recompiles the shader, so moving a cut costs one uniform and only adding or removing a
   * face pays for a recompile. That is why an unused face is dropped from the array entirely
   * rather than parked outside the build — a slice that had once been a box would otherwise
   * keep the six-plane shader for the rest of the session.
   */
  private readonly clipPlanes = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), // minX: keep x above
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0), // maxX: keep x below
    new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), // minY
    new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), // maxY
    new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), // minZ
    new THREE.Plane(new THREE.Vector3(0, 0, -1), 0), // maxZ
  ] as const;

  /** Which faces are active, as a bitmask over `clipPlanes`. Zero means no clipping. */
  private clipMask = 0;

  /** The box the skin was last built for, kept so an edit can rebuild it unprompted. */
  private clipBox: ClipBox | null = null;

  /**
   * @param materials The opaque/transparent pair every chunk (and the cut skin) shares.
   *   Injected rather than built here so the render style — Classic's unlit vertex colours,
   *   Enhanced's lit-and-grained Lambert — is the caller's choice, and this class stays a
   *   mesh manager with no opinion about shading.
   */
  constructor(materials: WorldMaterials = classicMaterials()) {
    this.opaqueMaterial = materials.opaque;
    this.transparentMaterial = materials.transparent;
    this.group.name = 'voxel-world';
    this.group.matrixAutoUpdate = false;
  }

  /** Chunks still queued or being meshed — the loading indicator reads this. */
  get remaining(): number {
    return this.dirty.size + this.inFlight.size + this.pending.length;
  }

  /**
   * Full rebuild. The grid is kept by reference (edits write through it); the worker gets
   * a transferred copy.
   */
  load(grid: VoxelGrid, paletteColors: Uint8Array, paletteFlags: Uint8Array): void {
    this.clearChunks();
    this.generation++;
    this.batchId = 0;

    this.cutsStale = this.clipMask !== 0;

    this.grid = grid;
    this.source = { size: grid.size, voxels: grid.voxels, paletteColors, paletteFlags };
    this.counts = chunkCounts(grid.size);

    const snapshot = grid.voxels.slice();
    const worker = this.ensureWorker();
    if (worker) {
      const load: MesherRequest = {
        t: 'load',
        size: grid.size,
        voxels: snapshot,
        paletteColors: paletteColors.slice(),
        paletteFlags: paletteFlags.slice(),
      };
      worker.postMessage(load, [snapshot.buffer as ArrayBuffer]);
    }

    for (let cy = 0; cy < this.counts.y; cy++) {
      for (let cz = 0; cz < this.counts.z; cz++) {
        for (let cx = 0; cx < this.counts.x; cx++) this.dirty.add(chunkKey(cx, cy, cz));
      }
    }
  }

  setVoxel(x: number, y: number, z: number, paletteIndex: number): void {
    const grid = this.grid;
    if (!grid) return;
    const { size } = grid;
    if (x < 0 || y < 0 || z < 0 || x >= size.x || y >= size.y || z >= size.z) return;

    const index = voxelIndex(size, x, y, z);
    if (grid.voxels[index] === paletteIndex) return;
    grid.voxels[index] = paletteIndex;

    this.worker?.postMessage({
      t: 'edit',
      indices: Uint32Array.of(index),
      values: Uint16Array.of(paletteIndex),
    } satisfies MesherRequest);

    this.touch(x, y, z);
  }

  /**
   * Swap in wider colour/flag tables after the palette grew.
   *
   * Deliberately not a reload. Appending a palette slot cannot change any mesh that already
   * exists — nothing references the new index until an edit puts it somewhere, and that edit
   * dirties its own chunks — so tearing down 400 chunks and respawning the worker would be
   * a second of work to redraw identical pixels. Must be called before the edit that first
   * uses the new slot, or the worker would mesh it against a table that is one entry short.
   */
  setPalette(paletteColors: Uint8Array, paletteFlags: Uint8Array): void {
    if (!this.source) return;
    this.source.paletteColors = paletteColors;
    this.source.paletteFlags = paletteFlags;

    this.worker?.postMessage({
      t: 'palette',
      // Copies: the main thread meshes from these too when there is no worker.
      paletteColors: paletteColors.slice(),
      paletteFlags: paletteFlags.slice(),
    } satisfies MesherRequest);
  }

  /** Apply an undo/redo unit forwards. */
  applyEdit(op: EditOp): void {
    this.applyValues(op.indices, op.after);
  }

  /** Apply one backwards — the undo half of the same unit. */
  revertEdit(op: EditOp): void {
    this.applyValues(op.indices, op.before);
  }

  /**
   * Show only the blocks inside a box. `null` shows everything.
   *
   * Clipping planes rather than a re-mesh: scrubbing the layer slider, or sliding a section
   * through a building, would otherwise rebuild every chunk on every pixel of drag. This
   * costs one uniform per face and stays exact, because the planes cut on block boundaries.
   *
   * It used to be a Y band only, which is all the voxel editor's layer slider needs. The
   * layouter needs the other four faces: isolating one room of one storey is how you look
   * inside a building that has more than one room in it, and no amount of cutting
   * horizontally gets you there.
   */
  setClip(box: ClipBox | null): void {
    // The cuts are nudged a thousandth of a block past the boundary they mean. Landing a
    // clipping plane exactly on a face makes the two coplanar, and the depth precision left
    // over decides per pixel whether that face survives — which reads as a speckled slice
    // rather than a clean one.
    const faces: (number | null | undefined)[] = box
      ? [box.minX, box.maxX, box.minY, box.maxY, box.minZ, box.maxZ]
      : [null, null, null, null, null, null];

    let mask = 0;
    for (let i = 0; i < faces.length; i++) {
      const value = faces[i];
      if (value === null || value === undefined) continue;
      mask |= 1 << i;
      // Even indices are minimum faces, whose normal points along the axis: `normal·p +
      // constant > 0` keeps what is above the cut, so the constant is the negated bound.
      // Odd indices are maximum faces, and keep the far side of the block they name.
      this.clipPlanes[i]!.constant = i % 2 === 0 ? -value + CLIP_EPSILON : value + 1 + CLIP_EPSILON;
    }

    // The skin is rebuilt even when the mask is unchanged: sliding a layer slider moves the
    // boundary without adding or removing a face, and the surface it exposes is different at
    // every stop.
    this.clipBox = box;
    this.cutsStale = true;

    if (mask === this.clipMask) return;
    this.clipMask = mask;

    const planes = mask === 0 ? null : this.clipPlanes.filter((_, i) => (mask & (1 << i)) !== 0);
    for (const material of [this.opaqueMaterial, this.transparentMaterial]) {
      material.clippingPlanes = planes;
      material.needsUpdate = true;
    }
  }

  /**
   * One tick of the mesh pipeline. Call from `useFrame`.
   *
   * Uploads are budgeted per frame, not per batch: the worker can outrun the GPU on a
   * large structure, and dropping 1300 geometries into the scene in one frame is a
   * multi-second stall no matter how fast the meshing was.
   */
  update(): void {
    if (this.cutsStale) this.rebuildCuts();

    let budget = UPLOADS_PER_FRAME;
    while (budget > 0 && this.pending.length > 0) {
      this.upload(this.pending.pop()!);
      budget--;
    }
    this.requestDirty(budget);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.clearChunks();
    this.opaqueMaterial.dispose();
    this.transparentMaterial.dispose();
    this.grid = null;
    this.source = null;
  }

  private applyValues(indices: Uint32Array, values: Uint16Array): void {
    const grid = this.grid;
    if (!grid) return;
    const { size } = grid;
    const layer = size.x * size.z;

    for (let i = 0; i < indices.length; i++) {
      const index = indices[i]!;
      grid.voxels[index] = values[i]!;
      const y = Math.floor(index / layer);
      const rem = index - y * layer;
      const z = Math.floor(rem / size.x);
      this.touch(rem - z * size.x, y, z);
    }

    this.worker?.postMessage({
      t: 'edit',
      // Copies, because transferring would neuter the caller's undo record.
      indices: indices.slice(),
      values: values.slice(),
    } satisfies MesherRequest);
  }

  /**
   * Mark the chunks a single voxel change can alter. That is not just the containing
   * chunk: AO samples the 26 cells around each face, so a block on a chunk face changes
   * the shading of its edge- and corner-adjacent chunks too.
   */
  private touch(x: number, y: number, z: number): void {
    if (this.clipMask !== 0) this.cutsStale = true;
    const xLo = (x - 1) >> 4;
    const xHi = (x + 1) >> 4;
    const yLo = (y - 1) >> 4;
    const yHi = (y + 1) >> 4;
    const zLo = (z - 1) >> 4;
    const zHi = (z + 1) >> 4;

    for (let cy = yLo; cy <= yHi; cy++) {
      if (cy < 0 || cy >= this.counts.y) continue;
      for (let cz = zLo; cz <= zHi; cz++) {
        if (cz < 0 || cz >= this.counts.z) continue;
        for (let cx = xLo; cx <= xHi; cx++) {
          if (cx < 0 || cx >= this.counts.x) continue;
          this.dirty.add(chunkKey(cx, cy, cz));
        }
      }
    }
  }

  /**
   * Rebuild the cut surface from the current voxels and box.
   *
   * Placed at the clip boundary itself, where `CLIP_EPSILON` has already nudged the plane a
   * thousandth of a block past — so the skin sits on the kept side of its own cut and needs
   * no exemption from the material's clipping, which is what lets it share the chunk
   * materials and stay subject to the *other* five faces of the box.
   */
  private rebuildCuts(): void {
    this.cutsStale = false;

    const previous = this.cuts;
    this.cuts = {};
    for (const mesh of [previous.opaque, previous.transparent]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }

    const source = this.source;
    const box = this.clipBox;
    if (!source || !box || this.clipMask === 0) return;

    const { opaque, transparent } = meshCuts(source, box);
    this.cuts.opaque = this.addCut(opaque, this.opaqueMaterial, 0);
    this.cuts.transparent = this.addCut(transparent, this.transparentMaterial, 1);
  }

  private addCut(
    buffers: MeshBuffers | null,
    material: THREE.Material,
    renderOrder: number,
  ): THREE.Mesh | undefined {
    if (!buffers) return undefined;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 3, true));
    geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = renderOrder;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    return mesh;
  }

  private requestDirty(uploadBudgetLeft: number): void {
    if (this.dirty.size === 0 || !this.source) return;

    const worker = this.worker;
    if (!worker) {
      // No worker: mesh on the main thread under the same per-frame budget, so the UI
      // degrades to "loads slowly" rather than "locks up".
      let budget = uploadBudgetLeft;
      for (const key of this.dirty) {
        if (budget-- <= 0) break;
        this.dirty.delete(key);
        const [cx, cy, cz] = unpackKey(key);
        this.upload(meshChunk(this.source, cx, cy, cz));
      }
      return;
    }

    while (this.dirty.size > 0 && this.inFlight.size < MAX_IN_FLIGHT) {
      const coords = new Int32Array(Math.min(REQUEST_BATCH, this.dirty.size) * 3);
      let n = 0;
      for (const key of this.dirty) {
        if (n * 3 >= coords.length) break;
        this.dirty.delete(key);
        this.inFlight.add(key);
        const [cx, cy, cz] = unpackKey(key);
        coords[n * 3] = cx;
        coords[n * 3 + 1] = cy;
        coords[n * 3 + 2] = cz;
        n++;
      }
      const request: MesherRequest = { t: 'mesh', batchId: this.nextBatchId(), chunks: coords };
      worker.postMessage(request, [coords.buffer as ArrayBuffer]);
    }
  }

  /** Batch ids carry the generation in the high bits so a reload can discard stale replies. */
  private nextBatchId(): number {
    return this.generation * 1e6 + ++this.batchId;
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(new URL('./mesher.worker.ts', import.meta.url), {
        type: 'module',
        name: 'craftmagic-mesher',
      });
      worker.onmessage = (event: MessageEvent<MesherResponse>) => {
        const { batchId, meshes } = event.data;
        if (Math.floor(batchId / 1e6) !== this.generation) return;
        for (const mesh of meshes) this.pending.push(mesh);
      };
      this.worker = worker;
      return worker;
    } catch {
      // Module workers are near-universal, but a hard failure here should downgrade to
      // main-thread meshing rather than render an empty scene.
      return null;
    }
  }

  private upload(mesh: MesherResponse['meshes'][number]): void {
    const key = chunkKey(mesh.cx, mesh.cy, mesh.cz);
    this.inFlight.delete(key);

    const entry = this.chunks.get(key) ?? {};
    entry.opaque = this.swapMesh(entry.opaque, mesh.opaque, this.opaqueMaterial, mesh, 0);
    entry.transparent = this.swapMesh(entry.transparent, mesh.transparent, this.transparentMaterial, mesh, 1);

    if (entry.opaque || entry.transparent) this.chunks.set(key, entry);
    else this.chunks.delete(key);
  }

  private swapMesh(
    existing: THREE.Mesh | undefined,
    buffers: MeshBuffers | null,
    material: THREE.Material,
    at: { cx: number; cy: number; cz: number },
    renderOrder: number,
  ): THREE.Mesh | undefined {
    if (existing) {
      this.group.remove(existing);
      existing.geometry.dispose();
    }
    if (!buffers) return undefined;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 3, true));
    geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));

    // Chunk bounds are known exactly, so skip the O(n) scan three.js would otherwise do
    // the first time this geometry is frustum-culled.
    const min = new THREE.Vector3(at.cx * CHUNK_SIZE, at.cy * CHUNK_SIZE, at.cz * CHUNK_SIZE);
    const max = min.clone().addScalar(CHUNK_SIZE);
    geometry.boundingBox = new THREE.Box3(min, max);
    geometry.boundingSphere = new THREE.Sphere(
      min.clone().addScalar(CHUNK_SIZE / 2),
      CHUNK_RADIUS,
    );

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = renderOrder;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    return mesh;
  }

  private clearChunks(): void {
    for (const mesh of [this.cuts.opaque, this.cuts.transparent]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.cuts = {};

    for (const entry of this.chunks.values()) {
      for (const mesh of [entry.opaque, entry.transparent]) {
        if (!mesh) continue;
        this.group.remove(mesh);
        mesh.geometry.dispose();
      }
    }
    this.chunks.clear();
    this.dirty.clear();
    this.inFlight.clear();
    this.pending.length = 0;
  }
}

/**
 * Chunk coordinates pack into one integer key: numeric Map keys avoid the string churn a
 * `"x,y,z"` key would create on every dirty-set operation during a drag-edit.
 * 10 bits per axis covers 16384 blocks — far past the 256-block size cap.
 */
function chunkKey(cx: number, cy: number, cz: number): number {
  return (cx & 1023) | ((cy & 1023) << 10) | ((cz & 1023) << 20);
}

function unpackKey(key: number): [number, number, number] {
  return [key & 1023, (key >> 10) & 1023, (key >> 20) & 1023];
}
