/**
 * Dimensions on the plan.
 *
 * The single thing that separated this from a drawing tool. You could drag a room out and
 * have no idea how big it was until you let go and read the inspector; you could nudge a wall
 * and not know whether the corridor was still wide enough to walk down. Every other decision
 * in a floorplan is downstream of a number, and none of the numbers were on the drawing.
 *
 * Drawn the way a drawing does it: a measured line outside the thing it measures, witness
 * lines running back to what it is measuring, a slash tick at each end, and the figure sitting
 * on the line. Not a tooltip and not a badge in the corner — a dimension belongs beside its
 * edge, because two of them at once is the normal case and a corner can only hold one.
 *
 * Everything here is sized in *screen* units divided by the scale, so a dimension stays the
 * same size on screen at 4 pixels per block and at 40. That inversion is the only trick in the
 * file, and it is why nothing below is a constant in plan units.
 */

import type { Rect } from './plan.js';

/** Screen pixels. Converted to plan units against the live scale at every call. */
const PX = {
  /** How far the dimension line sits outside the edge it measures. */
  offset: 18,
  /** How far the witness line stops short of the thing it points at. */
  gap: 4,
  /** Overshoot past the dimension line, so the corner reads as a corner. */
  overshoot: 5,
  tick: 5,
  text: 11,
  /** Padding around the figure, which knocks a hole in the line behind it. */
  textPad: 3,
} as const;

export interface DimensionsProps {
  rect: Rect;
  /** Screen pixels per block — everything here is measured against it. */
  scale: number;
  /**
   * Which edges get a dimension.
   *
   * A square selection wants both; a wall run wants only the one that means anything, because
   * "1 block thick" measured on every partition is noise the drawing has to carry forever.
   */
  axes?: 'both' | 'x' | 'z';
  /** Marks a dimension that is changing under the pointer, so it can be drawn brighter. */
  live?: boolean;
}

/**
 * Width along the top, depth down the left.
 *
 * Always those two sides rather than the nearest free ones. A dimension that moved to whatever
 * side had room would make two adjacent rooms disagree about where their figures live, and the
 * eye reads a column of aligned figures far faster than it reads correctly-placed ones.
 */
export function Dimensions({ rect, scale, axes = 'both', live = false }: DimensionsProps) {
  const u = (px: number) => px / scale;
  const cls = live ? 'plan__dim plan__dim--live' : 'plan__dim';

  return (
    <g className={cls} pointerEvents="none">
      {axes !== 'z' && (
        <DimensionLine
          from={{ x: rect.x, z: rect.z }}
          to={{ x: rect.x + rect.w, z: rect.z }}
          along="x"
          value={rect.w}
          u={u}
        />
      )}
      {axes !== 'x' && (
        <DimensionLine
          from={{ x: rect.x, z: rect.z }}
          to={{ x: rect.x, z: rect.z + rect.d }}
          along="z"
          value={rect.d}
          u={u}
        />
      )}
    </g>
  );
}

interface LineProps {
  from: { x: number; z: number };
  to: { x: number; z: number };
  along: 'x' | 'z';
  value: number;
  u: (px: number) => number;
}

function DimensionLine({ from, to, along, value, u }: LineProps) {
  const offset = u(PX.offset);
  const gap = u(PX.gap);
  const over = u(PX.overshoot);
  const tick = u(PX.tick);
  const text = u(PX.text);
  const pad = u(PX.textPad);

  const label = String(value);
  // A rough advance width is enough: the gap only has to clear the glyphs, and measuring text
  // properly would mean a layout pass per dimension per pointer move.
  const half = (label.length * text * 0.62) / 2 + pad;

  if (along === 'x') {
    const y = from.z - offset;
    const mid = (from.x + to.x) / 2;
    return (
      <>
        <line x1={from.x} y1={from.z - gap} x2={from.x} y2={y - over} className="plan__dim-witness" vectorEffect="non-scaling-stroke" />
        <line x1={to.x} y1={to.z - gap} x2={to.x} y2={y - over} className="plan__dim-witness" vectorEffect="non-scaling-stroke" />
        {/* Broken either side of the figure rather than drawn behind it: a filled label box
            would punch a hole in whatever the dimension happens to cross. */}
        <line x1={from.x} y1={y} x2={mid - half} y2={y} className="plan__dim-line" vectorEffect="non-scaling-stroke" />
        <line x1={mid + half} y1={y} x2={to.x} y2={y} className="plan__dim-line" vectorEffect="non-scaling-stroke" />
        <Tick x={from.x} y={y} size={tick} />
        <Tick x={to.x} y={y} size={tick} />
        <text x={mid} y={y} className="plan__dim-text" fontSize={text} textAnchor="middle" dominantBaseline="central">
          {label}
        </text>
      </>
    );
  }

  const x = from.x - offset;
  const mid = (from.z + to.z) / 2;
  return (
    <>
      <line x1={from.x - gap} y1={from.z} x2={x - over} y2={from.z} className="plan__dim-witness" vectorEffect="non-scaling-stroke" />
      <line x1={to.x - gap} y1={to.z} x2={x - over} y2={to.z} className="plan__dim-witness" vectorEffect="non-scaling-stroke" />
      <line x1={x} y1={from.z} x2={x} y2={mid - half} className="plan__dim-line" vectorEffect="non-scaling-stroke" />
      <line x1={x} y1={mid + half} x2={x} y2={to.z} className="plan__dim-line" vectorEffect="non-scaling-stroke" />
      <Tick x={x} y={from.z} size={tick} />
      <Tick x={x} y={to.z} size={tick} />
      {/* Turned to read up the page, which is the convention and the only way a figure fits
          beside a tall room without colliding with the one above it. */}
      <text
        x={x}
        y={mid}
        className="plan__dim-text"
        fontSize={text}
        textAnchor="middle"
        dominantBaseline="central"
        transform={`rotate(-90 ${x} ${mid})`}
      >
        {label}
      </text>
    </>
  );
}

/** The 45° slash a drawing uses instead of an arrowhead. */
function Tick({ x, y, size }: { x: number; y: number; size: number }) {
  return (
    <line
      x1={x - size / 2}
      y1={y + size / 2}
      x2={x + size / 2}
      y2={y - size / 2}
      className="plan__dim-tick"
      vectorEffect="non-scaling-stroke"
    />
  );
}

export interface SizeBadgeProps {
  /** Plan position the badge points at — normally the corner the pointer is dragging. */
  at: { x: number; z: number };
  scale: number;
  lines: readonly string[];
}

/**
 * A readout pinned to the pointer during a gesture.
 *
 * The dimension lines say how big the thing is; this says what is happening to it — the offset
 * of a move, the area of a room being drawn — which has no edge to sit beside. It is deliberately
 * the only floating element on the surface: two would be a HUD, and a plan is not a HUD.
 */
export function SizeBadge({ at, scale, lines }: SizeBadgeProps) {
  if (lines.length === 0) return null;
  const u = (px: number) => px / scale;
  const text = u(11);
  const padX = u(6);
  const padY = u(4);
  const lead = text * 1.25;
  const width = Math.max(...lines.map((line) => line.length)) * text * 0.62 + padX * 2;
  const height = lines.length * lead + padY * 2;
  // Up and to the right of the pointer, where the cursor is not already covering it.
  const x = at.x + u(14);
  const z = at.z - height - u(10);

  return (
    <g className="plan__badge" pointerEvents="none">
      <rect x={x} y={z} width={width} height={height} rx={u(4)} className="plan__badge-box" vectorEffect="non-scaling-stroke" />
      {lines.map((line, index) => (
        <text
          key={line}
          x={x + padX}
          y={z + padY + lead * (index + 0.5)}
          className={index === 0 ? 'plan__badge-text' : 'plan__badge-text plan__badge-text--dim'}
          fontSize={text}
          dominantBaseline="central"
        >
          {line}
        </text>
      ))}
    </g>
  );
}
