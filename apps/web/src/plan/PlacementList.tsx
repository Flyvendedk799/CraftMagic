/**
 * What is on the plot, and where.
 *
 * A layout tool needs both halves: dragging is how you place something roughly, and typed
 * coordinates are how you place it exactly. Neither substitutes for the other — nobody drags
 * four towers onto the precise corners of a keep, and nobody types their way through deciding
 * where a village looks right.
 *
 * Only the selected row expands. Six placements each showing three steppers and a rotation
 * control is a wall of numbers in a 20rem column, and the one you are working on is the only
 * one whose numbers you are reading.
 */

import type { Placement, PlanComponent } from '@craftmagic/core';

export interface PlacementListProps {
  placements: Placement[];
  components: Map<string, PlanComponent>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, at: { x: number; y: number; z: number }) => void;
  onTurn: (id: string, quarters: number) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
}

const HEADING = ['North', 'East', 'South', 'West'] as const;

export function PlacementList({
  placements,
  components,
  selected,
  onSelect,
  onMove,
  onTurn,
  onDuplicate,
  onRemove,
}: PlacementListProps) {
  if (placements.length === 0) {
    return (
      <p className="placements__empty">
        Nothing placed yet. Pick a component on the left and it lands on the plot.
      </p>
    );
  }

  return (
    <ul className="placements">
      {placements.map((placement, index) => {
        const component = components.get(placement.sourceId);
        const isSelected = placement.id === selected;

        return (
          <li key={placement.id} className="placement" data-selected={isSelected}>
            <button
              type="button"
              className="placement__head"
              aria-expanded={isSelected}
              onClick={() => onSelect(isSelected ? null : placement.id)}
            >
              <span className="placement__index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="placement__name">
                {component?.name ?? 'Missing component'}
              </span>
              <span className="placement__at">
                {placement.at.x},{placement.at.z}
                {placement.at.y > 0 && ` ·${placement.at.y}`}
              </span>
            </button>

            {isSelected && (
              <div className="placement__body">
                {!component && (
                  <p className="placement__warn">
                    This build is no longer in your library, so it cannot be composed. Remove it
                    to build the rest of the plan.
                  </p>
                )}

                <div className="placement__axes">
                  <Axis
                    label="East"
                    hint="X"
                    value={placement.at.x}
                    onChange={(x) => onMove(placement.id, { ...placement.at, x })}
                  />
                  <Axis
                    label="South"
                    hint="Z"
                    value={placement.at.z}
                    onChange={(z) => onMove(placement.id, { ...placement.at, z })}
                  />
                  <Axis
                    label="Up"
                    hint="Y"
                    value={placement.at.y}
                    onChange={(y) => onMove(placement.id, { ...placement.at, y })}
                  />
                </div>

                <div className="placement__row">
                  <span className="placement__label">
                    Facing <strong>{HEADING[placement.rotation]}</strong>
                  </span>
                  <button
                    type="button"
                    className="placement__btn"
                    title="Turn a quarter anticlockwise"
                    onClick={() => onTurn(placement.id, -1)}
                  >
                    ↺
                  </button>
                  <button
                    type="button"
                    className="placement__btn"
                    title="Turn a quarter clockwise (R)"
                    onClick={() => onTurn(placement.id, 1)}
                  >
                    ↻
                  </button>
                </div>

                <div className="placement__row placement__row--actions">
                  <button
                    type="button"
                    className="placement__btn"
                    title="Place another one beside it (Ctrl+D)"
                    onClick={() => onDuplicate(placement.id)}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="placement__btn placement__btn--danger"
                    title="Take it off the plot (Delete)"
                    onClick={() => onRemove(placement.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One axis of a position.
 *
 * A number field plus two steppers rather than a slider: the plot is 256 blocks across, so a
 * slider's pixel is four blocks and the last four blocks of alignment are exactly the ones
 * that matter. The steppers move by one; the field takes any number and the caller clamps it.
 */
function Axis({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="axis">
      <span className="axis__label">
        {label} <span className="axis__hint">{hint}</span>
      </span>
      <span className="axis__controls">
        <button type="button" className="axis__step" onClick={() => onChange(value - 1)} aria-label={`${label} minus one`}>
          −
        </button>
        <input
          className="axis__input"
          type="number"
          value={value}
          onChange={(event) => {
            const next = Number.parseInt(event.target.value, 10);
            if (Number.isFinite(next)) onChange(next);
          }}
          aria-label={label}
        />
        <button type="button" className="axis__step" onClick={() => onChange(value + 1)} aria-label={`${label} plus one`}>
          +
        </button>
      </span>
    </label>
  );
}
