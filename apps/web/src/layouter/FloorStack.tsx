/**
 * The storey stack.
 *
 * Drawn top-down, the way a section drawing is, because the list is a picture of the building
 * and a ground floor at the top of it reads backwards. The active storey is the one the plan
 * canvas edits; the one below it is drawn as an outline underneath, which is how anything ever
 * lines up between floors — a stair has to land somewhere, and a wall carrying a wall above it
 * is the difference between a building and a stack of unrelated plans.
 *
 * "Duplicate" is the most-used button here and the reason the panel exists in this form: the
 * usual second storey is the first one with a few walls moved, and re-drawing it is the single
 * most tedious thing a floorplan tool can ask for.
 */

import { createFloor, floorName, type LayoutPlan } from './plan.js';

export interface FloorStackProps {
  plan: LayoutPlan;
  active: number;
  showBelow: boolean;
  onShowBelow: (value: boolean) => void;
  onSelect: (index: number) => void;
  onChange: (plan: LayoutPlan) => void;
}

export function FloorStack({ plan, active, showBelow, onShowBelow, onSelect, onChange }: FloorStackProps) {
  const addAbove = () => {
    const floors = [...plan.floors];
    floors.splice(active + 1, 0, createFloor(floorName(active + 1)));
    onChange({ ...plan, floors: renumber(floors) });
    onSelect(active + 1);
  };

  const duplicate = () => {
    const source = plan.floors[active];
    if (!source) return;
    const floors = [...plan.floors];
    // Fresh ids for the copies: two items sharing an id would make selection ambiguous and
    // `replaceItem` would edit both.
    floors.splice(active + 1, 0, {
      ...createFloor(floorName(active + 1)),
      items: source.items.map((item) => ({ ...item, id: `${item.id}_c${floors.length}` })),
    });
    onChange({ ...plan, floors: renumber(floors) });
    onSelect(active + 1);
  };

  const remove = () => {
    if (plan.floors.length <= 1) return;
    const floors = plan.floors.filter((_, index) => index !== active);
    onChange({ ...plan, floors: renumber(floors) });
    onSelect(Math.max(0, active - 1));
  };

  const rename = (index: number, name: string) => {
    onChange({
      ...plan,
      floors: plan.floors.map((floor, i) => (i === index ? { ...floor, name } : floor)),
    });
  };

  return (
    <div className="floors">
      <ol className="floors__list">
        {plan.floors
          .map((floor, index) => ({ floor, index }))
          .reverse()
          .map(({ floor, index }) => (
            <li key={floor.id}>
              <button
                type="button"
                className="floors__row"
                aria-pressed={index === active}
                onClick={() => onSelect(index)}
              >
                <span className="floors__index">{index}</span>
                <span className="floors__name">{floor.name}</span>
                <span className="floors__count">{floor.items.length}</span>
              </button>
            </li>
          ))}
      </ol>

      <label className="field">
        <span className="field__label">Name</span>
        <input
          className="field__input"
          type="text"
          maxLength={40}
          value={plan.floors[active]?.name ?? ''}
          onChange={(event) => rename(active, event.target.value)}
        />
      </label>

      <div className="floors__actions">
        <button type="button" onClick={addAbove} disabled={plan.floors.length >= 12}>
          Add above
        </button>
        <button type="button" onClick={duplicate} disabled={plan.floors.length >= 12}>
          Duplicate
        </button>
        <button type="button" onClick={remove} disabled={plan.floors.length <= 1}>
          Delete
        </button>
      </div>

      <label className="field field--toggle">
        <input type="checkbox" checked={showBelow} onChange={(event) => onShowBelow(event.target.checked)} />
        <span className="field__label">Show the storey below</span>
      </label>
    </div>
  );
}

/** Keep default names in step with position, without overwriting names someone chose. */
function renumber(floors: LayoutPlan['floors']): LayoutPlan['floors'] {
  const defaults = new Set(floors.map((_, index) => floorName(index)));
  return floors.map((floor, index) =>
    defaults.has(floor.name) ? { ...floor, name: floorName(index) } : floor,
  );
}
