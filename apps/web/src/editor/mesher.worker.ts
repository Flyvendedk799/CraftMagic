/**
 * Meshing worker.
 *
 * It owns the voxels rather than sharing them. SharedArrayBuffer would let both threads read
 * one copy, but it needs COOP/COEP headers on every response — a cost paid by the whole site,
 * including the pages that never open the editor. So the grid is handed over once, in chunks,
 * and edits are forwarded afterwards as index/value pairs.
 *
 * Storage is per chunk (`VoxelStore`), which is what makes a world possible at all: nothing
 * bigger than 8 KB is allocated here, an all-air chunk costs nothing, and the main thread
 * never has to hold a second copy of the grid to hand one over.
 */

import {
  collectTransferables,
  meshStoredChunk,
  PAD_VOLUME,
  type ChunkMesh,
  type MesherRequest,
} from './mesher.js';
import { VoxelStore } from './voxelStore.js';

const ctx = globalThis as unknown as DedicatedWorkerGlobalScope;

let store: VoxelStore | null = null;
let paletteColors: Uint8Array = new Uint8Array(0);
let paletteFlags: Uint8Array = new Uint8Array(0);

/** The gather buffer, allocated once: every chunk is meshed through this same 18³ block. */
const pad = new Uint16Array(PAD_VOLUME);

ctx.addEventListener('message', (event: MessageEvent<MesherRequest>) => {
  const message = event.data;

  switch (message.t) {
    case 'load': {
      store = new VoxelStore(message.size);
      paletteColors = message.paletteColors;
      paletteFlags = message.paletteFlags;
      return;
    }

    case 'chunks': {
      store?.putBatch(message.keys, message.cells);
      return;
    }

    case 'edit': {
      if (!store) return;
      const { indices, values } = message;
      for (let i = 0; i < indices.length; i++) store.writeIndex(indices[i]!, values[i]!);
      return;
    }

    case 'palette': {
      paletteColors = message.paletteColors;
      paletteFlags = message.paletteFlags;
      return;
    }

    case 'mesh': {
      // A stale batch after a reload would paint the previous structure's chunks.
      if (!store) return;
      const meshes: ChunkMesh[] = [];
      const transfer: ArrayBuffer[] = [];
      const chunks = message.chunks;
      for (let i = 0; i + 2 < chunks.length; i += 3) {
        const mesh = meshStoredChunk(
          store,
          paletteColors,
          paletteFlags,
          chunks[i]!,
          chunks[i + 1]!,
          chunks[i + 2]!,
          pad,
        );
        meshes.push(mesh);
        collectTransferables(mesh, transfer);
      }
      ctx.postMessage({ t: 'meshed', batchId: message.batchId, meshes }, transfer);
      return;
    }
  }
});
