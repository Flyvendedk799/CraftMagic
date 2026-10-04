/** Preserve composition across dock resizing instead of cropping a landscape camera on a phone. */
export function perspectiveResizeFactor(
  before: { width: number; height: number },
  after: { width: number; height: number },
): number {
  if (
    before.width <= 0 ||
    before.height <= 0 ||
    after.width <= 0 ||
    after.height <= 0
  )
    return 1;
  const oldNarrow = Math.max(1, before.height / before.width),
    newNarrow = Math.max(1, after.height / after.width);
  return newNarrow / oldNarrow;
}
export function orthographicResizeFactor(
  before: { width: number; height: number },
  after: { width: number; height: number },
): number {
  const oldMin = Math.min(before.width, before.height),
    newMin = Math.min(after.width, after.height);
  return oldMin > 0 && newMin > 0 ? newMin / oldMin : 1;
}
