/**
 * The build library, over HTTP.
 *
 * Every call here is ownership-checked server-side and returns 404 — never 403 — for a build
 * that is not the caller's, so there is nothing to distinguish in the UI between "gone" and
 * "not yours". That is intentional on the server and it means this module needs no special
 * case for it.
 */

import type { BuildProgram, VoxelGrid } from '@imaginecraft/core';

export interface LibraryBuild {
  id: string;
  name: string;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  blockCount: number;
  /** False once a build has been hand-edited: only its voxels describe it. */
  hasProgram: boolean;
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
  grid: { size: { x: number; y: number; z: number }; palette: string[]; voxels: number[] };
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
 * Both the voxels and the program go up, plus whether the build has been hand-edited. The
 * server keeps all three because they answer different questions on the way back: the program
 * re-expands at any size and restores the param sliders, but once `detached` is true no
 * program describes the grid, and only the voxels do.
 */
export function saveToLibrary(input: {
  name: string;
  grid: VoxelGrid;
  program: BuildProgram | null;
  detached: boolean;
}): Promise<{ id: string; blockCount: number }> {
  return request(
    '/api/builds',
    json('POST', {
      name: input.name,
      library: true,
      detached: input.detached,
      program: input.program ?? undefined,
      grid: {
        size: input.grid.size,
        palette: input.grid.palette,
        voxels: Array.from(input.grid.voxels),
      },
    }),
  );
}
