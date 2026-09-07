/**
 * How much of a world the 3D check is allowed to hold at once.
 *
 * A region materialises into a grid sized to its *contents*, which on a flat map at the 128
 * default is about 128×31×128 — half a million cells, an ordinary large build. That is the
 * number the whole three-tier design rests on, and it is also why "show me four regions at
 * once" is a reasonable request rather than an absurd one.
 *
 * It stops being reasonable at the top end. The y extent of an area is the *union* of its
 * regions', so one tower in a corner makes the whole rectangle that tall, and a 1024² map with
 * a full 160-block span is 168 million cells — a 336 MB contiguous allocation that would take
 * the tab down before the mesher saw any of it. Region count is the wrong thing to cap: four
 * flat regions are cheaper than one region containing a spire.
 *
 * So the budget is in cells, and a requested rectangle is shrunk until it fits rather than
 * refused. Shrinking beats refusing because the request is a gesture — a drag across a
 * navigator, a span button — and answering a gesture with an error dialog when there is an
 * obvious smaller answer is a worse product than answering it with the smaller answer and
 * saying so.
 */

import { areaCount, areaStats, clampArea, type Prefab, type RegionArea, type WorldDoc } from '@craftmagic/core';

/**
 * The ceiling, in grid cells.
 *
 * Eight million is 16 MB as `Uint16Array` and about sixteen times a default region. It is set
 * against what `VoxelWorld` can stream rather than against what fits in memory: the renderer
 * keeps a camera-driven working set and evicts what is behind you, so the grid itself is the
 * only thing that has to be held whole, and 16 MB of it is comparable to a large imported
 * schematic the editor already opens without complaint.
 */
export const MAX_VIEW_CELLS = 8_000_000;

export interface FittedArea {
  /** The area that fits — the requested one, or the largest rectangle inside it that does. */
  area: RegionArea;
  /** Cells the fitted area materialises to. */
  cells: number;
  /** How many regions the request lost to the budget. Zero when the request fitted. */
  dropped: number;
}

/**
 * Shrink an area towards its anchor until it fits the budget.
 *
 * Towards the anchor rather than towards the middle: the anchor is the region the user picked
 * and the one the export controls cover, so it is the one square of the rectangle that must
 * survive. Shrinking the longer side first keeps what is left as square as it can be, which
 * for looking at a hub is the useful shape — a 1×5 strip of regions tells you much less about
 * a neighbourhood than a 2×2 does.
 *
 * A single region is never shrunk away, whatever it costs. There is no smaller answer, and a
 * viewer that renders nothing because the map is tall is not a budget, it is a bug.
 */
export function fitArea(
  doc: WorldDoc,
  requested: RegionArea,
  catalogue?: ReadonlyMap<string, Prefab>,
  budget: number = MAX_VIEW_CELLS,
): FittedArea {
  let area = clampArea(doc.settings, requested);
  const wanted = areaCount(area);

  // Every step drops at least one region, so this cannot run longer than the rectangle is big.
  for (;;) {
    const cells = areaStats(doc, area, undefined, catalogue).cells;
    if (cells <= budget || areaCount(area) === 1) {
      return { area, cells, dropped: wanted - areaCount(area) };
    }
    const wide = area.rx1 - area.rx0;
    const deep = area.rz1 - area.rz0;
    if (wide >= deep) area = { ...area, rx1: area.rx1 - 1 };
    else area = { ...area, rz1: area.rz1 - 1 };
  }
}

/** Whether a region is inside an area — what "the view already covers where I am" means. */
export function areaHolds(area: RegionArea, rx: number, rz: number): boolean {
  return rx >= area.rx0 && rx <= area.rx1 && rz >= area.rz0 && rz <= area.rz1;
}

/** The region a world column falls in. */
export function regionOfColumn(regionSize: number, x: number, z: number): { rx: number; rz: number } {
  return { rx: Math.floor(x / regionSize), rz: Math.floor(z / regionSize) };
}

/** The span a rectangle reads as, for the span buttons: its longer side. */
export function spanOf(area: RegionArea): number {
  return Math.max(area.rx1 - area.rx0 + 1, area.rz1 - area.rz0 + 1);
}
