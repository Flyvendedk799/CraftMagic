/**
 * The room schedule.
 *
 * The one document a floorplan always comes with and this tool did not have. A plan tells you
 * where the rooms are; the schedule tells you how big they are, which is the question every
 * argument about a layout is actually about — is the kitchen big enough, is that corridor a
 * corridor or a cupboard, did the second bedroom end up half the size of the first.
 *
 * Areas are *interior* areas: what is inside the walls, which is the floor you can stand on.
 * Measuring the outer rect would count the masonry, and two rooms sharing a wall would each
 * count half of it — a number that is easy to compute, looks plausible, and is wrong in the
 * direction that flatters the drawing.
 *
 * Sorted biggest first rather than in draw order. A schedule is read to find the outlier, and
 * the outlier is at one end or the other of a sorted list; draw order puts it wherever the
 * user happened to click.
 */

import { interiorRect } from './validate.js';
import type { LayoutPlan, RoomItem } from './plan.js';

export interface RoomScheduleProps {
  plan: LayoutPlan;
  /** The storey on screen. Its rooms are listed; every other storey is a total. */
  floorIndex: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

interface Row {
  room: RoomItem;
  /** Blocks of walkable floor, or 0 for a room whose walls meet in the middle. */
  area: number;
  inner: { w: number; d: number } | null;
}

export function RoomSchedule({ plan, floorIndex, selectedId, onSelect }: RoomScheduleProps) {
  const rows = scheduleFor(plan, floorIndex);
  const floorArea = rows.reduce((sum, row) => sum + row.area, 0);
  const total = plan.floors.reduce(
    (sum, _floor, index) => sum + scheduleFor(plan, index).reduce((n, row) => n + row.area, 0),
    0,
  );

  if (rows.length === 0) {
    return (
      <p className="schedule__empty">
        No rooms on this storey yet. Draw one with the Room tool and it appears here with its
        floor area.
      </p>
    );
  }

  return (
    <>
      <table className="schedule">
        <thead>
          <tr>
            <th scope="col">Room</th>
            <th scope="col">Inside</th>
            <th scope="col">Area</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ room, area, inner }) => (
            <tr key={room.id} data-selected={room.id === selectedId ? '1' : '0'}>
              <th scope="row">
                {/* The whole name is the target. A schedule is a way of getting to a room you
                    can see the number of but not, at a glance, the position of. */}
                <button type="button" onClick={() => onSelect(room.id)}>
                  {room.label.trim() || 'Unnamed'}
                </button>
              </th>
              <td>{inner ? `${inner.w}×${inner.d}` : '—'}</td>
              <td>{area > 0 ? area.toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">This storey</th>
            <td>{rows.length} rooms</td>
            <td>{floorArea.toLocaleString()}</td>
          </tr>
          {plan.floors.length > 1 && (
            <tr>
              <th scope="row">Whole building</th>
              <td>{plan.floors.length} storeys</td>
              <td>{total.toLocaleString()}</td>
            </tr>
          )}
        </tfoot>
      </table>

      <p className="site-panel__hint">
        Area is the floor inside the walls, in blocks. A room with no area has walls thick
        enough to meet in the middle.
      </p>
    </>
  );
}

/** Rooms on one storey with their interior measurements, biggest first. */
function scheduleFor(plan: LayoutPlan, floorIndex: number): Row[] {
  const floor = plan.floors[floorIndex];
  if (!floor) return [];

  return floor.items
    .filter((item): item is RoomItem => item.kind === 'room')
    .map((room) => {
      const inner = interiorRect(room, plan.wallThickness);
      return {
        room,
        area: inner ? inner.w * inner.d : 0,
        inner: inner ? { w: inner.w, d: inner.d } : null,
      };
    })
    .sort((a, b) => b.area - a.area);
}

/** The summary the collapsed section header carries. */
export function scheduleSummary(plan: LayoutPlan, floorIndex: number): string {
  const rows = scheduleFor(plan, floorIndex);
  if (rows.length === 0) return 'no rooms';
  const area = rows.reduce((sum, row) => sum + row.area, 0);
  return `${rows.length} · ${area.toLocaleString()} blocks`;
}
