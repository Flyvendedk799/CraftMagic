/**
 * Tell other studio modes that a library row's voxels or plan just changed.
 *
 * Build writes edits back to the row a placement points at. World keeps those blocks in a
 * catalogue cache so a drag does not re-fetch every frame. Without a signal, zooming back to
 * the map keeps showing the pre-edit building until a full reload. A small listener bus is
 * enough: World (and Architecture's shelf) invalidate that id and fetch again.
 */

export type LibraryRowHandler = (id: string) => void;

const listeners = new Set<LibraryRowHandler>();

export function notifyLibraryRow(id: string): void {
  if (!id) return;
  for (const handler of listeners) handler(id);
}

export function onLibraryRow(handler: LibraryRowHandler): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

/** Test helper — clear every subscriber between cases. */
export function resetLibraryRowListeners(): void {
  listeners.clear();
}
