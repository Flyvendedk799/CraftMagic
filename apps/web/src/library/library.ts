/**
 * The build library, over HTTP.
 *
 * Every call here is ownership-checked server-side and returns 404 — never 403 — for a build
 * that is not the caller's, so there is nothing to distinguish in the UI between "gone" and
 * "not yours". That is intentional on the server and it means this module needs no special
 * case for it.
 */

import { decodeVoxels, encodeVoxels, fromBase64, toBase64 } from '@craftmagic/core';
import type { BuildProgram, EditLayer, VoxelGrid } from '@craftmagic/core';

export interface LibraryBuild {
  id: string;
  name: string;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  blockCount: number;
  /** False once a build has been hand-edited: only its voxels describe it. */
  hasProgram: boolean;
  /** True when a layouter plan was saved beside the build — it can reopen in the layouter. */
  hasPlan: boolean;
  detached: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryBuildDetail {
  id: string;
  name: string;
  blockCount: number;
  detached: boolean;
  program: BuildProgram | null;
  /** The hand-edit layer, on builds saved since it existed. Null on older rows. */
  edits: EditLayer | null;
  /** The layouter drawing this build was compiled from, when it was saved from the layouter. */
  plan: unknown;
  /**
   * The voxels, in whichever form the server sent.
   *
   * `data` is base64 of the gzipped ICVX blob and is what a current server always sends;
   * `voxels` is the old integer array, still sent for small builds so a tab from the previous
   * deploy keeps working. `gridOf` below is the one place that has to know.
   */
  grid: {
    size: { x: number; y: number; z: number };
    palette: string[];
    data?: string;
    voxels?: number[];
  };
}

/**
 * The detail response's grid, as a real `VoxelGrid`.
 *
 * Prefers the compact blob, which is self-describing and carries its own palette — so it is
 * trusted over the loose `size`/`palette` fields beside it rather than merged with them.
 */
export function gridOf(detail: LibraryBuildDetail): VoxelGrid {
  if (typeof detail.grid.data === 'string') return decodeVoxels(fromBase64(detail.grid.data));
  return {
    size: detail.grid.size,
    palette: detail.grid.palette,
    voxels: Uint16Array.from(detail.grid.voxels ?? []),
  };
}

export class LibraryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LibraryError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new LibraryError(body.message ?? `HTTP ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export async function listBuilds(): Promise<LibraryBuild[]> {
  const body = await request<{ builds: LibraryBuild[] }>('/api/builds');
  return body.builds;
}

export function getBuild(id: string): Promise<LibraryBuildDetail> {
  return request<LibraryBuildDetail>(`/api/builds/${encodeURIComponent(id)}`);
}

export function renameBuild(id: string, name: string): Promise<{ id: string; name: string }> {
  return request(`/api/builds/${encodeURIComponent(id)}`, json('PATCH', { name }));
}

export function deleteBuild(id: string): Promise<{ ok: true }> {
  return request(`/api/builds/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Save the build on screen.
 *
 * Voxels, program, and the hand-edit layer all go up. The composited voxels are what the
 * guide, the agent and old readers consume; the program is what keeps the sliders and refine
 * alive; the layer is what lets the editor restore *both at once* — edits riding over a
 * still-parametric build. `detached` is kept for exactly the old readers.
 */
export function saveToLibrary(input: {
  name: string;
  grid: VoxelGrid;
  program: BuildProgram | null;
  detached: boolean;
  edits?: EditLayer | null;
  plan?: unknown;
}): Promise<{ id: string; blockCount: number }> {
  return request(
    '/api/builds',
    json('POST', {
      name: input.name,
      library: true,
      detached: input.detached,
      program: input.program ?? undefined,
      edits: input.edits ?? undefined,
      plan: input.plan ?? undefined,
      grid: {
        size: input.grid.size,
        palette: input.grid.palette,
        // Base64 of the gzipped ICVX blob rather than one JSON number per cell. A build at the
        // engine's own 256x160x256 size cap is ~280 KB this way and 20 MB as an integer array,
        // which is 20x Fastify's body limit — so until this changed, a build that big, and the
        // "Stress test" sample shipped in the editor, could not be saved at all. Both 413'd.
        data: toBase64(encodeVoxels(input.grid)),
      },
    }),
  );
}
