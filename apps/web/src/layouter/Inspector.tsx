/**
 * Properties of whatever is selected.
 *
 * A plan tool needs both halves: a pointer for the things that are easier to draw than to
 * describe (where a room is, how big) and fields for the things that are easier to describe
 * than to draw (which way a door faces, how high a sill sits). The level editor engine this is
 * ported from splits its editor exactly this way — a viewport and a `renderInspector()` that
 * rebuilds a form for the selected entity — and the split holds up.
 *
 * Every control writes through `onChange`, which the page commits as a single history entry, so
 * one field edit is one undo.
 */

import type { Face } from '@craftmagic/core';
import { OVERRIDE_ROLES } from './kits.js';
import { FURNISHINGS } from './furniture.js';
import { floorHeight, type LayoutPlan, type PlanItem, type PlanAxis } from './plan.js';

const FACES: Face[] = ['north', 'east', 'south', 'west'];

export interface InspectorProps {
  plan: LayoutPlan;
  item: PlanItem | null;
  onChange: (next: PlanItem) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  /** Move the selection to another storey — the fastest way to fix "drew it on the wrong floor". */
  onSendToFloor: (floorIndex: number) => void;
  floorIndex: number;
}

export function Inspector({
  plan: wholePlan,
  item,
  onChange,
  onDelete,
  onDuplicate,
  onSendToFloor,
  floorIndex,
}: InspectorProps) {
  // Slider ceilings answer to the storey the item is on, not the building default.
  const plan = { ...wholePlan, storeyHeight: floorHeight(wholePlan, floorIndex) };
  if (!item) {
    return (
      <p className="layouter__empty">
        Nothing selected. Click something on the plan, or pick a tool and draw.
      </p>
    );
  }

  return (
    <div className="inspector">
      <p className="inspector__kind">{item.kind}</p>

      {item.kind === 'room' && (
        <>
          <TextField label="Name" value={item.label} onChange={(label) => onChange({ ...item, label })} />
          <RectFields plan={plan} rect={item.rect} onChange={(rect) => onChange({ ...item, rect })} />
          <RoleField
            label="Walls"
            value={item.wallRole ?? 'wall_primary'}
            onChange={(wallRole) => onChange({ ...item, wallRole })}
          />
          <RoleField
            label="Floor"
            value={item.floorRole ?? 'floor'}
            onChange={(floorRole) => onChange({ ...item, floorRole })}
          />
          <ToggleField
            label="Floor slab"
            hint="Off leaves the room open to the storey below — a double-height space."
            value={item.slab}
            onChange={(slab) => onChange({ ...item, slab })}
          />
        </>
      )}

      {item.kind === 'wall' && (
        <>
          <ChoiceField
            label="Runs"
            value={item.axis}
            options={[
              { value: 'x', label: 'East–west' },
              { value: 'z', label: 'North–south' },
            ]}
            onChange={(axis) => onChange({ ...item, axis: axis as PlanAxis })}
          />
          <NumberField
            label="Length"
            value={item.length}
            min={1}
            max={item.axis === 'x' ? plan.site.x - item.x : plan.site.z - item.z}
            onChange={(length) => onChange({ ...item, length })}
          />
          <PositionFields plan={plan} x={item.x} z={item.z} onChange={(x, z) => onChange({ ...item, x, z })} />
          <RoleField label="Material" value={item.role ?? 'wall_primary'} onChange={(role) => onChange({ ...item, role })} />
        </>
      )}

      {item.kind === 'door' && (
        <>
          <ChoiceField
            label="Faces"
            value={item.facing}
            options={FACES.map((face) => ({ value: face, label: face }))}
            onChange={(facing) => onChange({ ...item, facing: facing as Face })}
          />
          <ChoiceField
            label="Width"
            value={String(item.width)}
            options={[
              { value: '1', label: 'Single' },
              { value: '2', label: 'Double' },
            ]}
            onChange={(width) => onChange({ ...item, width: width === '2' ? 2 : 1 })}
          />
          <ChoiceField
            label="Height"
            value={String(item.height)}
            options={[
              { value: '2', label: '2 blocks' },
              { value: '3', label: '3 blocks' },
            ]}
            onChange={(height) => onChange({ ...item, height: height === '3' ? 3 : 2 })}
          />
          <ToggleField
            label="Open archway"
            hint="No door in the opening — the right answer between two rooms that share a use."
            value={item.open}
            onChange={(open) => onChange({ ...item, open })}
          />
          <PositionFields plan={plan} x={item.x} z={item.z} onChange={(x, z) => onChange({ ...item, x, z })} />
        </>
      )}

      {item.kind === 'window' && (
        <>
          <ChoiceField
            label="Runs"
            value={item.axis}
            options={[
              { value: 'x', label: 'East–west' },
              { value: 'z', label: 'North–south' },
            ]}
            onChange={(axis) => onChange({ ...item, axis: axis as PlanAxis })}
          />
          <NumberField label="Length" value={item.length} min={1} max={24} onChange={(length) => onChange({ ...item, length })} />
          <NumberField
            label="Sill"
            hint="Blocks above the floor."
            value={item.sill}
            min={0}
            max={Math.max(0, plan.storeyHeight - 2)}
            onChange={(sill) => onChange({ ...item, sill })}
          />
          <NumberField
            label="Height"
            value={item.height}
            min={1}
            max={Math.max(1, plan.storeyHeight - 1)}
            onChange={(height) => onChange({ ...item, height })}
          />
          <PositionFields plan={plan} x={item.x} z={item.z} onChange={(x, z) => onChange({ ...item, x, z })} />
        </>
      )}

      {item.kind === 'stair' && (
        <>
          <ChoiceField
            label="Climbs"
            value={item.facing}
            options={FACES.map((face) => ({ value: face, label: face }))}
            onChange={(facing) => onChange({ ...item, facing: facing as Face })}
          />
          <NumberField label="Width" value={item.width} min={1} max={6} onChange={(width) => onChange({ ...item, width })} />
          <PositionFields plan={plan} x={item.x} z={item.z} onChange={(x, z) => onChange({ ...item, x, z })} />
          <p className="inspector__note">
            The run is {plan.storeyHeight} blocks long — one per block of storey height — and cuts its
            own well through the floor above.
          </p>
        </>
      )}

      {item.kind === 'opening' && (
        <RectFields plan={plan} rect={item.rect} onChange={(rect) => onChange({ ...item, rect })} />
      )}

      {item.kind === 'platform' && (
        <>
          <RectFields plan={plan} rect={item.rect} onChange={(rect) => onChange({ ...item, rect })} />
          <NumberField
            label="Raise"
            value={item.raise}
            min={1}
            max={Math.max(1, plan.storeyHeight - 2)}
            onChange={(raise) => onChange({ ...item, raise })}
          />
          <RoleField label="Material" value={item.role ?? 'floor'} onChange={(role) => onChange({ ...item, role })} />
        </>
      )}

      {item.kind === 'column' && (
        <>
          <NumberField label="Size" value={item.size} min={1} max={4} onChange={(size) => onChange({ ...item, size })} />
          <PositionFields plan={plan} x={item.x} z={item.z} onChange={(x, z) => onChange({ ...item, x, z })} />
          <RoleField label="Material" value={item.role ?? 'frame'} onChange={(role) => onChange({ ...item, role })} />
        </>
      )}

      {item.kind === 'furnish' && (
        <>
          <ChoiceField
            label="Piece"
            value={item.itemId}
            options={FURNISHINGS.map((piece) => ({ value: piece.id, label: piece.label }))}
            onChange={(itemId) => onChange({ ...item, itemId })}
          />
          <ChoiceField
            label="Faces"
            value={item.facing}
            options={FACES.map((face) => ({ value: face, label: face }))}
            onChange={(facing) => onChange({ ...item, facing: facing as Face })}
          />
          <PositionFields plan={plan} x={item.x} z={item.z} onChange={(x, z) => onChange({ ...item, x, z })} />
        </>
      )}

      <div className="inspector__actions">
        <button type="button" onClick={onDuplicate}>
          Duplicate
        </button>
        <button type="button" className="inspector__delete" onClick={onDelete}>
          Delete
        </button>
      </div>

      {plan.floors.length > 1 && (
        <label className="field">
          <span className="field__label">Move to storey</span>
          <select
            className="field__input"
            value={floorIndex}
            onChange={(event) => onSendToFloor(Number(event.target.value))}
          >
            {plan.floors.map((floor, index) => (
              <option key={floor.id} value={index}>
                {floor.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

function RectFields({
  plan,
  rect,
  onChange,
}: {
  plan: LayoutPlan;
  rect: { x: number; z: number; w: number; d: number };
  onChange: (rect: { x: number; z: number; w: number; d: number }) => void;
}) {
  return (
    <div className="field-row">
      <NumberField label="X" value={rect.x} min={0} max={plan.site.x - 1} onChange={(x) => onChange({ ...rect, x })} />
      <NumberField label="Z" value={rect.z} min={0} max={plan.site.z - 1} onChange={(z) => onChange({ ...rect, z })} />
      <NumberField label="Wide" value={rect.w} min={1} max={plan.site.x - rect.x} onChange={(w) => onChange({ ...rect, w })} />
      <NumberField label="Deep" value={rect.d} min={1} max={plan.site.z - rect.z} onChange={(d) => onChange({ ...rect, d })} />
    </div>
  );
}

function PositionFields({
  plan,
  x,
  z,
  onChange,
}: {
  plan: LayoutPlan;
  x: number;
  z: number;
  onChange: (x: number, z: number) => void;
}) {
  return (
    <div className="field-row">
      <NumberField label="X" value={x} min={0} max={plan.site.x - 1} onChange={(next) => onChange(next, z)} />
      <NumberField label="Z" value={z} min={0} max={plan.site.z - 1} onChange={(next) => onChange(x, next)} />
    </div>
  );
}

function RoleField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (role: string) => void;
}) {
  return (
    <ChoiceField
      label={label}
      value={value}
      options={OVERRIDE_ROLES.map((role) => ({ value: role, label: role.replace(/_/g, ' ') }))}
      onChange={onChange}
    />
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field" title={hint}>
      <span className="field__label">{label}</span>
      <input
        className="field__input"
        type="number"
        value={value}
        min={min}
        max={Math.max(min, max)}
        onChange={(event) => {
          const next = Math.round(Number(event.target.value));
          if (!Number.isFinite(next)) return;
          onChange(Math.max(min, Math.min(Math.max(min, max), next)));
        }}
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
        className="field__input"
        type="text"
        value={value}
        maxLength={40}
        placeholder="Unnamed"
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ChoiceField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <select className="field__input" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ToggleField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="field field--toggle" title={hint}>
      <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
      <span className="field__label">{label}</span>
    </label>
  );
}
