/**
 * What the inspector shows when more than one thing is selected.
 *
 * Not a reduced inspector. The single-item inspector is a form — a name, a width, a facing —
 * and none of those questions has an answer for six items at once; offering them greyed out,
 * or filled with the first item's values, would be worse than not offering them. What several
 * items *do* have is a relationship to each other, so this panel asks about that instead.
 *
 * The buttons are pictures rather than words. "Align left" and "align top" are the same length
 * and the same shape as text, and a reader picking between six of them at a glance is reading
 * six near-identical labels; the same six as diagrams are told apart without reading at all.
 */

import type { AlignMode, DistributeAxis } from './arrange.js';

export interface ArrangePanelProps {
  count: number;
  onAlign: (mode: AlignMode) => void;
  onDistribute: (axis: DistributeAxis) => void;
  /** Two items have no gap between them to even out, so the buttons say so rather than no-op. */
  canDistribute: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
}

interface AlignSpec {
  mode: AlignMode;
  label: string;
  /** Where the three bars sit inside a 24×24 icon, as x/y/width/height quads. */
  bars: readonly (readonly [number, number, number, number])[];
  /** The edge or centreline the bars line up on. */
  rule: readonly [number, number, number, number];
}

const ALIGN: readonly AlignSpec[] = [
  {
    mode: 'left',
    label: 'Align left edges',
    bars: [
      [5, 4, 14, 4],
      [5, 10, 9, 4],
      [5, 16, 12, 4],
    ],
    rule: [4, 2, 0, 20],
  },
  {
    mode: 'centerX',
    label: 'Centre on a vertical line',
    bars: [
      [5, 4, 14, 4],
      [7, 10, 9, 4],
      [6, 16, 12, 4],
    ],
    rule: [12, 2, 0, 20],
  },
  {
    mode: 'right',
    label: 'Align right edges',
    bars: [
      [5, 4, 14, 4],
      [10, 10, 9, 4],
      [7, 16, 12, 4],
    ],
    rule: [20, 2, 0, 20],
  },
  {
    mode: 'top',
    label: 'Align top edges',
    bars: [
      [4, 5, 4, 14],
      [10, 5, 4, 9],
      [16, 5, 4, 12],
    ],
    rule: [2, 4, 20, 0],
  },
  {
    mode: 'centerZ',
    label: 'Centre on a horizontal line',
    bars: [
      [4, 5, 4, 14],
      [10, 7, 4, 9],
      [16, 6, 4, 12],
    ],
    rule: [2, 12, 20, 0],
  },
  {
    mode: 'bottom',
    label: 'Align bottom edges',
    bars: [
      [4, 5, 4, 14],
      [10, 10, 4, 9],
      [16, 7, 4, 12],
    ],
    rule: [2, 20, 20, 0],
  },
];

function AlignIcon({ spec }: { spec: AlignSpec }) {
  const [rx, ry, rw, rh] = spec.rule;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <line x1={rx} y1={ry} x2={rx + rw} y2={ry + rh} className="arrange__rule" />
      {spec.bars.map(([x, y, w, h]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} rx={1} className="arrange__bar" />
      ))}
    </svg>
  );
}

export function ArrangePanel({
  count,
  onAlign,
  onDistribute,
  canDistribute,
  onDelete,
  onDuplicate,
}: ArrangePanelProps) {
  return (
    <div className="arrange">
      <p className="arrange__count">
        <strong>{count}</strong> items selected
      </p>

      <p className="arrange__hint">
        Drag any one of them to move the set. Arrows nudge. Shift-click adds and removes.
      </p>

      <div className="arrange__group" role="group" aria-label="Align">
        {ALIGN.map((spec) => (
          <button
            key={spec.mode}
            type="button"
            className="arrange__btn"
            onClick={() => onAlign(spec.mode)}
            title={spec.label}
            aria-label={spec.label}
          >
            <AlignIcon spec={spec} />
          </button>
        ))}
      </div>

      <div className="arrange__group" role="group" aria-label="Space evenly">
        <button
          type="button"
          className="arrange__wide"
          onClick={() => onDistribute('x')}
          disabled={!canDistribute}
          title={
            canDistribute
              ? 'Equal gaps left to right, with the two outer items held where they are'
              : 'Three or more items, so there is a gap to even out'
          }
        >
          Space across
        </button>
        <button
          type="button"
          className="arrange__wide"
          onClick={() => onDistribute('z')}
          disabled={!canDistribute}
          title={
            canDistribute
              ? 'Equal gaps top to bottom, with the two outer items held where they are'
              : 'Three or more items, so there is a gap to even out'
          }
        >
          Space down
        </button>
      </div>

      <div className="arrange__group">
        <button type="button" className="arrange__wide" onClick={onDuplicate}>
          Duplicate
        </button>
        <button type="button" className="arrange__wide arrange__wide--warn" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
