/**
 * The settings that belong to the whole building rather than to any one thing in it.
 *
 * Storey height, wall thickness and the kit are the three that change how everything already
 * drawn is built, which is exactly why they live here and not in the inspector: they are
 * properties of the project, and finding them on a room would imply they were that room's.
 *
 * Changing any of them re-compiles the plan and the 3D preview follows immediately, which is
 * the point — trying a material or a ceiling height should cost one click, not a re-draw.
 */

import { KITS } from './kits.js';
import { LIMITS, type LayoutPlan, type RoofStyle } from './plan.js';

const ROOFS: { value: RoofStyle; label: string; hint: string }[] = [
  { value: 'gable', label: 'Gable', hint: 'Two slopes meeting at a ridge.' },
  { value: 'hip', label: 'Hip', hint: 'Slopes on all four sides.' },
  { value: 'flat', label: 'Flat', hint: 'A deck with a parapet.' },
  { value: 'none', label: 'Open', hint: 'No lid at all — the top storey is left open to the sky.' },
];

export interface SitePanelProps {
  plan: LayoutPlan;
  onChange: (plan: LayoutPlan) => void;
}

export function SitePanel({ plan, onChange }: SitePanelProps) {
  return (
    <div className="site-panel">
      <label className="field">
        <span className="field__label">Name</span>
        <input
          className="field__input"
          type="text"
          maxLength={60}
          value={plan.name}
          onChange={(event) => onChange({ ...plan, name: event.target.value })}
        />
      </label>

      <label className="field">
        <span className="field__label">Materials</span>
        <select
          className="field__input"
          value={plan.kitId}
          onChange={(event) => onChange({ ...plan, kitId: event.target.value })}
        >
          {KITS.map((kit) => (
            <option key={kit.id} value={kit.id}>
              {kit.name}
            </option>
          ))}
        </select>
      </label>
      <p className="site-panel__hint">{KITS.find((kit) => kit.id === plan.kitId)?.description}</p>

      <Slider
        label="Storey height"
        value={plan.storeyHeight}
        min={LIMITS.minStorey}
        max={LIMITS.maxStorey}
        suffix={`${plan.storeyHeight - 1} clear`}
        onChange={(storeyHeight) => onChange({ ...plan, storeyHeight })}
      />
      <Slider
        label="Wall thickness"
        value={plan.wallThickness}
        min={1}
        max={LIMITS.maxWallThickness}
        onChange={(wallThickness) => onChange({ ...plan, wallThickness })}
      />
      <Slider
        label="Foundation"
        value={plan.foundation}
        min={0}
        max={LIMITS.maxFoundation}
        onChange={(foundation) => onChange({ ...plan, foundation })}
      />

      <label className="field">
        <span className="field__label">Roof</span>
        <select
          className="field__input"
          value={plan.roof}
          onChange={(event) => onChange({ ...plan, roof: event.target.value as RoofStyle })}
        >
          {ROOFS.map((roof) => (
            <option key={roof.value} value={roof.value}>
              {roof.label}
            </option>
          ))}
        </select>
      </label>
      <p className="site-panel__hint">{ROOFS.find((roof) => roof.value === plan.roof)?.hint}</p>

      <div className="field-row">
        <Slider
          label="Site X"
          value={plan.site.x}
          min={LIMITS.minSite}
          max={LIMITS.maxSite}
          onChange={(x) => onChange({ ...plan, site: { ...plan.site, x } })}
        />
        <Slider
          label="Site Z"
          value={plan.site.z}
          min={LIMITS.minSite}
          max={LIMITS.maxSite}
          onChange={(z) => onChange({ ...plan, site: { ...plan.site, z } })}
        />
      </div>
      <p className="site-panel__hint">
        The site is the plot you can draw on. The export is cropped to the building, so a
        generous site costs nothing.
      </p>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="param">
      <span className="param__label">{label}</span>
      <input
        className="param__slider"
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="param__value">{suffix ? `${value} · ${suffix}` : value}</span>
    </label>
  );
}
