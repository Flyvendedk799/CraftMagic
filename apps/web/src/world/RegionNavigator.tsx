/**
 * The region navigator: a map of the map, and the only control over what the 3D check shows.
 *
 * Before this, choosing a region meant one of three things, none of them the obvious one:
 * sculpting somewhere and letting the view follow, scrolling the right-hand dock down to the
 * Regions list and pressing "Find", or knowing that a placement's Find button pinned the view.
 * All three answer "take me to a region" and none of them answers "which regions are there,
 * which am I looking at, and what is in the ones I am not".
 *
 * So: one cell per region, laid out the way the regions are. It carries four facts a list
 * cannot — where a region is relative to the others, how much is in it (the shading), whether
 * it is too big to deliver as one build (the mark), and which rectangle is on screen. That
 * last one is the whole reason the panel earns its space: an area is a rectangle, and a
 * rectangle drawn as a list of coordinates is a rectangle nobody can see.
 *
 * The anchor is drawn differently from the rest of the selection on purpose. It is the corner
 * a span grows from, the region the arrow keys move, and the one the export controls cover
 * when the view is bigger than a legal build — three jobs that all want the same cell, and a
 * selection with no visible corner would make all three feel arbitrary.
 */

import { useCallback, useRef, useState } from 'react';
import {
  areaLabel,
  clampArea,
  regionCount,
  spanFrom,
  type RegionArea,
  type WorldSettings,
} from '@craftmagic/core';
import { areaHolds, spanOf } from './viewArea.js';

/** The spans the buttons offer. Beyond nine regions the budget is doing the deciding anyway. */
const SPANS: readonly number[] = [1, 2, 3];

/**
 * One cell's worth of reading: a whole region column, slabs included.
 *
 * Not `RegionStats`, and the difference is the reason this type exists. A world taller than a
 * build is cut into stacked y-slabs, so `regionsOf` returns two or more entries per `rx,rz` —
 * and a grid that showed the first of them would shade a region by its bottom 160 blocks and
 * miss the tower in the slab above. A cell is a column of the map, so its reading is the
 * column's.
 */
export interface RegionCell {
  rx: number;
  rz: number;
  blocks: number;
  placements: number;
  /** True when any slab of this column is past what a single build may hold. */
  overCap: boolean;
}

export interface RegionNavigatorProps {
  settings: WorldSettings;
  /** One reading per region column. Used for the shading and the caps. */
  cells: readonly RegionCell[];
  /** The rectangle actually on screen — after the cell budget has had its say. */
  view: RegionArea;
  /** The rectangle asked for, which is the same thing unless the budget shrank it. */
  requested: RegionArea;
  onView: (area: RegionArea) => void;
  /** True while the view follows wherever the sculpting is. */
  following: boolean;
  onFollowing: (following: boolean) => void;
}

export function RegionNavigator(props: RegionNavigatorProps) {
  const { settings, cells, view, requested } = props;
  const counts = regionCount(settings);
  const [open, setOpen] = useState(true);

  /**
   * The corner a drag started from.
   *
   * A ref rather than state: it changes on pointer-down and is read on pointer-enter, and
   * re-rendering the whole grid between those two is work nobody sees.
   */
  const dragFrom = useRef<{ rx: number; rz: number } | null>(null);

  /** The busiest region, so the shading is relative to this map rather than to an absolute. */
  const busiest = cells.reduce((max, entry) => Math.max(max, entry.blocks), 1);

  const cellFor = useCallback(
    (rx: number, rz: number) => cells.find((entry) => entry.rx === rx && entry.rz === rz),
    [cells],
  );

  const pick = useCallback(
    (rx: number, rz: number, extend: boolean) => {
      props.onFollowing(false);
      if (extend) {
        // Extend from the anchor, so shift-clicking around a selection sweeps a rectangle out
        // of one corner rather than re-anchoring on every click.
        props.onView(clampArea(settings, { rx0: requested.rx0, rz0: requested.rz0, rx1: rx, rz1: rz }));
      } else {
        props.onView(spanFrom(settings, rx, rz, spanOf(requested)));
      }
    },
    [props, settings, requested],
  );

  /**
   * Arrow keys move the anchor; with Shift they move the far corner instead.
   *
   * Handled on the grid rather than on the window: the digits 1–9 are the terrain tools and
   * every other global key in this mode is a tool, so a navigator that swallowed the arrows
   * from anywhere would be taking keys the map may want later. You tab to it, or you click it.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const step = ARROWS[event.key];
      if (!step) return;
      event.preventDefault();
      props.onFollowing(false);
      if (event.shiftKey) {
        props.onView(
          clampArea(settings, {
            rx0: requested.rx0,
            rz0: requested.rz0,
            rx1: requested.rx1 + step.x,
            rz1: requested.rz1 + step.z,
          }),
        );
      } else {
        props.onView(spanFrom(settings, requested.rx0 + step.x, requested.rz0 + step.z, spanOf(requested)));
      }
    },
    [props, settings, requested],
  );

  const span = spanOf(requested);
  const shown = (view.rx1 - view.rx0 + 1) * (view.rz1 - view.rz0 + 1);

  return (
    <div className="regionnav" data-open={open ? 'true' : 'false'}>
      <div className="regionnav__head">
        <button
          type="button"
          className="regionnav__toggle"
          aria-expanded={open}
          title={open ? 'Hide the region navigator' : 'Show the region navigator'}
          onClick={() => setOpen((was) => !was)}
        >
          <span className="regionnav__chevron" aria-hidden="true" />
          Regions
        </button>
        <span className="regionnav__at" title={`${shown} region${shown === 1 ? '' : 's'} in view`}>
          {areaLabel(view)}
        </span>
      </div>

      {open && (
        <>
          {/* Row-major, one button per region, sized by the grid rather than by the cell — an
              8×8 map and a 2×2 map both fill the panel instead of one of them being a stamp. */}
          <div
            className="regionnav__grid"
            role="grid"
            aria-label="Regions"
            tabIndex={0}
            onKeyDown={onKeyDown}
            style={{ gridTemplateColumns: `repeat(${counts.x}, minmax(0, 1fr))` }}
            onPointerUp={() => {
              dragFrom.current = null;
            }}
            onPointerLeave={() => {
              dragFrom.current = null;
            }}
          >
            {Array.from({ length: counts.z }, (_, rz) =>
              Array.from({ length: counts.x }, (_, rx) => {
                const entry = cellFor(rx, rz);
                const inView = areaHolds(view, rx, rz);
                const anchor = rx === requested.rx0 && rz === requested.rz0;
                // Dropped by the budget: asked for, not shown. Worth its own state, because
                // otherwise the panel silently disagrees with the button you just pressed.
                const trimmed = !inView && areaHolds(requested, rx, rz);
                const over = entry?.overCap ?? false;
                return (
                  <button
                    key={`${rx},${rz}`}
                    type="button"
                    className="regionnav__cell"
                    data-view={inView ? 'true' : undefined}
                    data-anchor={anchor ? 'true' : undefined}
                    data-trimmed={trimmed ? 'true' : undefined}
                    data-over={over ? 'true' : undefined}
                    aria-pressed={inView}
                    title={
                      entry
                        ? `Region ${rx},${rz} — ${entry.blocks.toLocaleString()} blocks` +
                          (entry.placements > 0 ? `, ${entry.placements} placed` : '') +
                          (over ? ' — too big to deliver as one build' : '') +
                          (trimmed ? ' — asked for, but past the viewer’s budget' : '')
                        : `Region ${rx},${rz}`
                    }
                    onPointerDown={(event) => {
                      dragFrom.current = { rx, rz };
                      pick(rx, rz, event.shiftKey);
                    }}
                    onPointerEnter={() => {
                      const from = dragFrom.current;
                      // A drag across the grid sweeps a rectangle. Only once it has left the
                      // cell it started on, so a plain click stays a plain click.
                      if (!from || (from.rx === rx && from.rz === rz)) return;
                      props.onFollowing(false);
                      props.onView(clampArea(settings, { rx0: from.rx, rz0: from.rz, rx1: rx, rz1: rz }));
                    }}
                  >
                    {/* Shading rather than a number: sixty-four cells of digits is a table, and
                        the question a grid answers is "where is the busy part", not "how many
                        blocks exactly" — which is what the tooltip and the list are for. */}
                    <span
                      className="regionnav__fill"
                      style={{ opacity: entry ? 0.05 + 0.28 * (entry.blocks / busiest) : 0.05 }}
                      aria-hidden="true"
                    />
                    {over && <span className="regionnav__over" aria-hidden="true" />}
                  </button>
                );
              }),
            )}
          </div>

          <div className="regionnav__foot">
            <div className="ui-seg" role="group" aria-label="How many regions to view at once">
              {SPANS.map((size) => (
                <button
                  key={size}
                  type="button"
                  aria-pressed={span === size}
                  title={
                    size === 1
                      ? 'One region — what exports and sends as a single build'
                      : `${size}×${size} regions in one view, so the seams between them are visible`
                  }
                  onClick={() => {
                    props.onFollowing(false);
                    props.onView(spanFrom(settings, requested.rx0, requested.rz0, size));
                  }}
                >
                  {size}×{size}
                </button>
              ))}
            </div>
            <label className="ui-check regionnav__follow" title="Move the view to wherever you are sculpting">
              <input
                type="checkbox"
                checked={props.following}
                onChange={(event) => props.onFollowing(event.target.checked)}
              />
              Follow
            </label>
          </div>
        </>
      )}
    </div>
  );
}

const ARROWS: Record<string, { x: number; z: number } | undefined> = {
  ArrowLeft: { x: -1, z: 0 },
  ArrowRight: { x: 1, z: 0 },
  ArrowUp: { x: 0, z: -1 },
  ArrowDown: { x: 0, z: 1 },
};
