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
import { voxelIndex, type EditOp, type VoxelGrid } from '@imaginecraft/core';
import {
  CHUNK_SIZE,
  chunkCounts,
  meshChunk,
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

/** Half-diagonal of a 16³ cube; every chunk shares it, so the bounding sphere is free. */
const CHUNK_RADIUS = (CHUNK_SIZE * Math.sqrt(3)) / 2;

interface ChunkEntry {
  opaque?: THREE.Mesh;
  transparent?: THREE.Mesh;
}

export class VoxelWorld {
  readonly group = new THREE.Group();

  private readonly opaqueMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  private readonly transparentMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    // Without this, panes of glass in the same chunk occlude each other in draw order.
    depthWrite: false,
    opacity: 0.72,
    side: THREE.DoubleSide,
  });

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

  private readonly clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private clipped = false;

  constructor() {
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
   * Hide everything above layer `y`.
   *
   * A clipping plane rather than a re-mesh: scrubbing the layer slider would otherwise
   * rebuild every chunk on every pixel of drag. This costs one uniform and stays exact,
   * because the plane cuts at the block boundary y+1.
   */
  setLayerClip(y: number | null): void {
    const wanted = y !== null;
    if (wanted) this.clipPlane.constant = y + 1;

    if (wanted === this.clipped) return;
    this.clipped = wanted;

    const planes = wanted ? [this.clipPlane] : null;
    for (const material of [this.opaqueMaterial, this.transparentMaterial]) {
      material.clippingPlanes = planes;
      // Only the count change recompiles the shader, so a scrub never touches this.
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
        name: 'imaginecraft-mesher',
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
