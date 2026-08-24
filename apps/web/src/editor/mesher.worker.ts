/**
 * Meshing worker.
 *
 * It keeps its own snapshot of the voxel array rather than sharing one. SharedArrayBuffer
 * would avoid the copy, but it needs COOP/COEP headers on every response — a cost paid by
 * the whole site, including the pages that never open the editor. A snapshot costs 2 bytes
 * per voxel (≈2.7 MB at the 500k-block cap, most of it air) and edits are forwarded as
 * index/value pairs, so the copy is made exactly once per structure.
 */

import { collectTransferables, meshChunk, type ChunkMesh, type MeshSource, type MesherRequest } from './mesher.js';

const ctx = globalThis as unknown as DedicatedWorkerGlobalScope;

let source: MeshSource | null = null;

ctx.addEventListener('message', (event: MessageEvent<MesherRequest>) => {
  const message = event.data;

  switch (message.t) {
    case 'load': {
      source = {
        size: message.size,
        voxels: message.voxels,
        paletteColors: message.paletteColors,
        paletteFlags: message.paletteFlags,
      };
      return;
    }

    case 'edit': {
      if (!source) return;
      const { indices, values } = message;
      for (let i = 0; i < indices.length; i++) source.voxels[indices[i]!] = values[i]!;
      return;
    }

    case 'palette': {
      if (!source) return;
      source.paletteColors = message.paletteColors;
      source.paletteFlags = message.paletteFlags;
      return;
    }

    case 'mesh': {
      // A stale batch after a reload would paint the previous structure's chunks.
      if (!source) return;
      const meshes: ChunkMesh[] = [];
      const transfer: ArrayBuffer[] = [];
      const chunks = message.chunks;
      for (let i = 0; i + 2 < chunks.length; i += 3) {
        const mesh = meshChunk(source, chunks[i]!, chunks[i + 1]!, chunks[i + 2]!);
        meshes.push(mesh);
        collectTransferables(mesh, transfer);
      }
      ctx.postMessage({ t: 'meshed', batchId: message.batchId, meshes }, transfer);
      return;
    }
  }
});
