/**
 * Isometric snapshots of a build as it accumulates — one image per guide step.
 *
 * Two constraints shape this file, and both are easy to trip over.
 *
 * The first is the browser's WebGL context budget (~16 before the oldest are dropped). A
 * 42-step guide asking for a renderer per step loses its earliest contexts silently, halfway
 * through, with no error worth catching. So there is exactly one renderer, refcounted at
 * module scope, and every step is drawn into it in turn.
 *
 * The second is that "the build after step N" is a *prefix* of the build, not a separate
 * build. Re-meshing the whole structure for each prefix is O(steps x chunks); meshing only
 * the chunks a step actually disturbs makes the whole filmstrip cost roughly one full mesh.
 * The dirty set has to include the AO neighbourhood, not just the containing chunk, for the
 * same reason the editor's does: a face's shading samples the cells around it.
 *
 * The mesher itself is the editor's, unchanged. A second mesher would be a second set of
 * winding, AO and transparency rules to keep in step with the first.
 */

import * as THREE from 'three';
import { voxelIndex } from '@craftmagic/core';
import { CHUNK_SIZE, chunkCounts, meshChunk, type GridSize, type MeshSource } from '../editor/mesher.js';

/** 45° around Y and 35.264° above the horizon: the true isometric axonometry. */
const AZIMUTH = Math.PI / 4;
const ELEVATION = Math.atan(1 / Math.SQRT2);

/** Breathing room around the bounds, so the silhouette never touches the frame. */
const FRAME_MARGIN = 1.06;

export interface IsoBlock {
  x: number;
  y: number;
  z: number;
  paletteIndex: number;
}

/* --- the shared renderer ---------------------------------------------------------------
 * Refcounted rather than created per page, because React StrictMode mounts the guide twice
 * in development and the second mount would otherwise strand the first context.
 * ------------------------------------------------------------------------------------ */

let sharedRenderer: THREE.WebGLRenderer | null = null;
let sharedUsers = 0;

function acquireRenderer(): THREE.WebGLRenderer {
  if (!sharedRenderer) {
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      // `toDataURL` reads the back buffer, which the browser may clear the moment the frame
      // is composited. Without this the filmstrip is a strip of blank PNGs.
      preserveDrawingBuffer: true,
    });
    // Sizes here are chosen for print resolution, so the display's DPR must not scale them.
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    // The mesher bakes raw palette bytes into the vertex colours, and those bytes are
    // already sRGB. Passing them through unconverted is what makes a block in the render
    // the same colour as its swatch in the bill of materials.
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    sharedRenderer = renderer;
  }
  sharedUsers++;
  return sharedRenderer;
}

function releaseRenderer(): void {
  if (sharedUsers === 0) return;
  if (--sharedUsers > 0) return;
  sharedRenderer?.dispose();
  // Hands the context back now rather than at the whim of the GC, so navigating between
  // guides cannot accumulate dead contexts.
  sharedRenderer?.forceContextLoss();
  sharedRenderer = null;
}

/**
 * The build under construction, plus the camera framed on its finished bounds.
 *
 * Framing on the *finished* bounds — not on what has been placed so far — is deliberate:
 * the reader is watching one model grow, and a camera that re-fits every step would make it
 * pulse in scale instead.
 */
export class IsoFilmstrip {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera();
  private readonly source: MeshSource;
  private readonly counts: GridSize;
  private readonly chunks = new Map<number, { opaque?: THREE.Mesh; transparent?: THREE.Mesh }>();
  private readonly dirty = new Set<number>();

  private readonly opaqueMaterial = new THREE.MeshBasicMaterial({ vertexColors: true });
  private readonly transparentMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    // Same reason as the editor: panes in one chunk otherwise occlude each other by draw order.
    depthWrite: false,
    opacity: 0.72,
    side: THREE.DoubleSide,
  });

  /** Half-extents of the build along the camera's right and up axes, in world units. */
  private halfU = 1;
  private halfV = 1;
  private disposed = false;

  constructor(size: GridSize, paletteColors: Uint8Array, paletteFlags: Uint8Array) {
    this.renderer = acquireRenderer();
    this.source = {
      size,
      voxels: new Uint16Array(size.x * size.y * size.z),
      paletteColors,
      paletteFlags,
    };
    this.counts = chunkCounts(size);
    this.frame(size);
  }

  /**
   * Load a finished build in one go.
   *
   * `place` is the step-at-a-time entry point, and it is the wrong shape for a caller that
   * only wants the completed model: it would mean one object per block to describe
   * something the grid already holds contiguously — a quarter of a million allocations for
   * a large build, thrown away immediately. The library's thumbnails want exactly that, so
   * this copies the voxels straight across and marks every chunk dirty.
   */
  fill(voxels: Uint16Array): void {
    this.source.voxels.set(voxels);
    for (let cy = 0; cy < this.counts.y; cy++) {
      for (let cz = 0; cz < this.counts.z; cz++) {
        for (let cx = 0; cx < this.counts.x; cx++) this.dirty.add(chunkKey(cx, cy, cz));
      }
    }
  }

  /** Add one step's blocks to the standing model. */
  place(blocks: readonly IsoBlock[]): void {
    const { size, voxels } = this.source;
    for (const block of blocks) {
      voxels[voxelIndex(size, block.x, block.y, block.z)] = block.paletteIndex;
      this.touch(block.x, block.y, block.z);
    }
  }

  /** Re-mesh whatever the last `place` disturbed and read the frame back as a PNG. */
  snapshot(width: number, height: number): string {
    if (this.disposed) return '';
    this.remesh();

    const aspect = width / height;
    let halfU = this.halfU;
    let halfV = this.halfV;
    // Widen whichever axis has slack, so the build is never squashed to fit the frame.
    if (halfU / halfV < aspect) halfU = halfV * aspect;
    else halfV = halfU / aspect;

    this.camera.left = -halfU;
    this.camera.right = halfU;
    this.camera.top = halfV;
    this.camera.bottom = -halfV;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height, false);
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.chunks.values()) {
      for (const mesh of [entry.opaque, entry.transparent]) {
        if (!mesh) continue;
        this.scene.remove(mesh);
        mesh.geometry.dispose();
      }
    }
    this.chunks.clear();
    this.dirty.clear();
    this.opaqueMaterial.dispose();
    this.transparentMaterial.dispose();
    releaseRenderer();
  }

  /**
   * Park the camera on the isometric axis and measure the build against its own screen axes.
   *
   * The extents are taken from the eight corners of the bounding box rather than from
   * `Math.max(size)`: an ortho box sized to the diagonal would leave a tall build swimming
   * in empty frame.
   */
  private frame(size: GridSize): void {
    const centre = new THREE.Vector3(size.x / 2, size.y / 2, size.z / 2);
    const direction = new THREE.Vector3(
      Math.cos(ELEVATION) * Math.sin(AZIMUTH),
      Math.sin(ELEVATION),
      Math.cos(ELEVATION) * Math.cos(AZIMUTH),
    ).normalize();

    const radius = Math.hypot(size.x, size.y, size.z);
    this.camera.position.copy(centre).addScaledVector(direction, radius);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(centre);
    this.camera.updateMatrixWorld();

    // An orthographic camera has no perspective to clip against, so the planes only need to
    // straddle the whole build.
    this.camera.near = 0;
    this.camera.far = radius * 3;

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);

    let maxU = 0;
    let maxV = 0;
    const corner = new THREE.Vector3();
    for (const cx of [0, size.x]) {
      for (const cy of [0, size.y]) {
        for (const cz of [0, size.z]) {
          corner.set(cx, cy, cz).sub(centre);
          maxU = Math.max(maxU, Math.abs(corner.dot(right)));
          maxV = Math.max(maxV, Math.abs(corner.dot(up)));
        }
      }
    }

    this.halfU = Math.max(1, maxU * FRAME_MARGIN);
    this.halfV = Math.max(1, maxV * FRAME_MARGIN);
  }

  /**
   * Mark every chunk a single placement can change. Not just the containing one: ambient
   * occlusion samples the cells around each face, so a block on a chunk boundary re-shades
   * its edge- and corner-adjacent neighbours too.
   */
  private touch(x: number, y: number, z: number): void {
    for (let cy = (y - 1) >> 4; cy <= (y + 1) >> 4; cy++) {
      if (cy < 0 || cy >= this.counts.y) continue;
      for (let cz = (z - 1) >> 4; cz <= (z + 1) >> 4; cz++) {
        if (cz < 0 || cz >= this.counts.z) continue;
        for (let cx = (x - 1) >> 4; cx <= (x + 1) >> 4; cx++) {
          if (cx < 0 || cx >= this.counts.x) continue;
          this.dirty.add(chunkKey(cx, cy, cz));
        }
      }
    }
  }

  private remesh(): void {
    if (this.dirty.size === 0) return;
    for (const key of this.dirty) {
      const [cx, cy, cz] = unpackKey(key);
      const mesh = meshChunk(this.source, cx, cy, cz);
      const entry = this.chunks.get(key) ?? {};
      entry.opaque = this.swap(entry.opaque, mesh.opaque, this.opaqueMaterial, cx, cy, cz, 0);
      entry.transparent = this.swap(entry.transparent, mesh.transparent, this.transparentMaterial, cx, cy, cz, 1);
      if (entry.opaque || entry.transparent) this.chunks.set(key, entry);
      else this.chunks.delete(key);
    }
    this.dirty.clear();
  }

  /** Replaces a chunk's geometry, disposing the old one — a long guide leaks GPU memory otherwise. */
  private swap(
    existing: THREE.Mesh | undefined,
    buffers: ReturnType<typeof meshChunk>['opaque'],
    material: THREE.Material,
    cx: number,
    cy: number,
    cz: number,
    renderOrder: number,
  ): THREE.Mesh | undefined {
    if (existing) {
      this.scene.remove(existing);
      existing.geometry.dispose();
    }
    if (!buffers) return undefined;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 3, true));
    geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));

    const min = new THREE.Vector3(cx * CHUNK_SIZE, cy * CHUNK_SIZE, cz * CHUNK_SIZE);
    geometry.boundingBox = new THREE.Box3(min, min.clone().addScalar(CHUNK_SIZE));
    geometry.boundingSphere = new THREE.Sphere(
      min.clone().addScalar(CHUNK_SIZE / 2),
      (CHUNK_SIZE * Math.sqrt(3)) / 2,
    );

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = renderOrder;
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);
    return mesh;
  }
}

/** 10 bits per axis, matching the editor's packing — 16384 blocks, far past the size cap. */
function chunkKey(cx: number, cy: number, cz: number): number {
  return (cx & 1023) | ((cy & 1023) << 10) | ((cz & 1023) << 20);
}

function unpackKey(key: number): [number, number, number] {
  return [key & 1023, (key >> 10) & 1023, (key >> 20) & 1023];
}
