/**
 * Schematic download.
 *
 * Runs entirely in the browser. `writeSchematic` lives in `packages/core`, which is
 * isomorphic precisely so this can happen client-side: the server never sees the request,
 * never spends CPU on it, and a build can be exported while offline.
 */

import { schematicFilename, writeSchematic, type VoxelGrid } from '@craftmagic/core';

export interface DownloadResult {
  filename: string;
  bytes: number;
}

/**
 * Write a `.schem` and hand it to the browser.
 *
 * The object URL is revoked on the next task rather than immediately: revoking it in the
 * same tick can cancel the download in some browsers before it has read the blob.
 */
export function downloadSchematic(grid: VoxelGrid, name: string): DownloadResult {
  const bytes = writeSchematic(grid, { name });
  const filename = schematicFilename(name);

  // `bytes` is a Uint8Array view; pass the exact slice so a pooled buffer cannot leak
  // trailing bytes into the file.
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 0);

  return { filename, bytes: bytes.length };
}

/**
 * Download the build *program* rather than its voxels.
 *
 * Worth offering separately: the program is the thing that survives a resize, is a few
 * kilobytes instead of a few hundred, and is what you would hand to someone else to
 * re-expand. A `.schem` is the finished object; this is the recipe.
 */
export function downloadProgram(program: unknown, name: string): DownloadResult {
  const json = JSON.stringify(program, null, 2);
  const filename = schematicFilename(name).replace(/\.schem$/, '.program.json');

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 0);

  return { filename, bytes: new TextEncoder().encode(json).length };
}

/** Human-readable file size for the button's hint. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
