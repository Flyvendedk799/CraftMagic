/**
 * The sculpting controls: which tool, how big, how hard, and what ground.
 *
 * The controls a tool cannot use are hidden rather than disabled. A greyed-out slider still
 * asks to be read, and with nine tools sharing one panel the difference between "this does
 * nothing right now" and "this does not apply" is what keeps the column from reading as a
 * wall of dead widgets. `WorldToolSpec` carries which of the three groups each tool wants, so
 * the panel asks the tool rather than keeping a second list that can disagree with the first.
 *
 * Every slider is paired with a number input. A slider is how you find a radius by feel; a
 * number is how you set it to exactly 24 because the last one was 24, and a terrain tool
 * without both is either imprecise or tedious depending on which half it picked.
 */

import type { TerrainBrush, SurfaceProfile, WorldSettings } from '@craftmagic/core';
import { profileColor } from '@craftmagic/core';
import { Section } from '../editor/Section.js';
import { WORLD_TOOLS, WORLD_TOOL_GROUPS, toolSpec, type WorldTool } from './toolset.js';
import { WorldToolIcon } from './WorldToolIcons.js';

/** The radii a terrain pass actually reaches for: a path, a hill, a valley, a landscape. */
export const BRUSH_PRESETS: readonly { label: string; radius: number }[] = [
  { label: 'S', radius: 4 },
  { label: 'M', radius: 12 },
  { label: 'L', radius: 32 },
  { label: 'XL', radius: 64 },
];

export interface TerrainPanelProps {
  settings: WorldSettings;
  tool: WorldTool;
  onTool: (tool: WorldTool) => void;
  brush: TerrainBrush;
  onBrush: (brush: TerrainBrush) => void;
  stratum: number;
  onStratum: (index: number) => void;
  targetY: number;
  onTargetY: (y: number) => void;
  onShowHelp: () => void;
}

export function TerrainPanel(props: TerrainPanelProps) {
  const { settings, tool, brush, stratum, targetY } = props;
  const spec = toolSpec(tool);

  return (
    <>
      <Section id="world-tools" title="Tools" summary={spec.label}>
        {/* Three families, icon over word, the way Build's palette reads. A flat grid of nine
            words put Pan beside Raise as though they were the same kind of thing. */}
        {WORLD_TOOL_GROUPS.map((group) => (
          <div className="world__toolgroup" key={group.id}>
            <p className="world__grouplabel">{group.label}</p>
            <div className="world__tools" role="group" aria-label={group.label}>
              {WORLD_TOOLS.filter((entry) => entry.group === group.id).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="world__tool"
                  data-tool={entry.id}
                  aria-pressed={entry.id === tool}
                  title={`${entry.hint}  (${entry.key})`}
                  onClick={() => props.onTool(entry.id)}
                >
                  <WorldToolIcon tool={entry.id} />
                  {entry.label}
                  <span className="world__tool-key" aria-hidden="true">{entry.key}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        <p className="world__hint">
          {spec.hint}.{' '}
          <button type="button" className="tools__inline" onClick={props.onShowHelp}>
            shortcuts
          </button>
        </p>
        {spec.modifiers && <p className="world__modhint">{spec.modifiers}</p>}
      </Section>

      {spec.brush && (
        <Section id="world-brush" title="Brush" summary={`${brush.radius}`}>
          {/* The four sizes a terrain pass actually uses, one click each. The slider finds a
              size by feel; these get back to the usual ones without dragging past them. */}
          <div className="world__row world__row--tight">
            <span className="world__label">Size</span>
            <div className="ui-seg ui-seg--grow" role="group" aria-label="Brush size presets">
              {BRUSH_PRESETS.map((preset) => (
                <button
                  key={preset.radius}
                  type="button"
                  aria-pressed={brush.radius === preset.radius}
                  title={`Radius ${preset.radius} blocks`}
                  onClick={() => props.onBrush({ ...brush, radius: preset.radius })}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          <Slider
            label="Radius"
            value={brush.radius}
            min={0}
            max={128}
            step={1}
            unit="blocks"
            onChange={(radius) => props.onBrush({ ...brush, radius })}
          />
          <Slider
            label="Strength"
            value={brush.strength}
            min={0.1}
            max={16}
            step={0.1}
            unit={tool === 'carve' ? 'blocks deep' : 'blocks / dab'}
            onChange={(strength) => props.onBrush({ ...brush, strength })}
          />
          <div className="world__row">
            <span className="world__label">Falloff</span>
            <div className="ui-seg ui-seg--grow" role="group" aria-label="Brush falloff">
              {(['smooth', 'flat'] as const).map((falloff) => (
                <button
                  key={falloff}
                  type="button"
                  aria-pressed={brush.falloff === falloff}
                  onClick={() => props.onBrush({ ...brush, falloff })}
                >
                  {falloff === 'smooth' ? 'Soft' : 'Hard'}
                </button>
              ))}
            </div>
          </div>
          <p className="world__hint">
            {brush.falloff === 'smooth'
              ? 'Fades to nothing at the rim, so repeated strokes pile into a hill.'
              : 'Full strength to the rim — a plaza wants an edge.'}{' '}
            <kbd>[</kbd> <kbd>]</kbd> size, <kbd>Shift</kbd>+<kbd>[</kbd> <kbd>]</kbd> strength.
          </p>
        </Section>
      )}

      {spec.target && (
        <Section id="world-target" title={tool === 'carve' ? 'Carve depth' : 'Target height'} summary={`y ${targetY}`}>
          <Slider
            label={tool === 'carve' ? 'Ceiling' : 'Height'}
            value={targetY}
            min={settings.minY}
            max={settings.maxY}
            step={1}
            unit="y"
            onChange={props.onTargetY}
          />
          {/* "Under cursor" used to be a button here, and it could never be pressed: it only
              rendered while the pointer was over the map, and moving to it took the pointer off
              the map. Sampling belongs on the map, as a modifier on the click you are already
              making. */}
          <div className="world__row">
            <button
              type="button"
              className="ui-btn"
              onClick={() => props.onTargetY(settings.seaLevel)}
            >
              Sea level ({settings.seaLevel})
            </button>
            <span className="world__modhint world__modhint--inline">
              or <kbd>Alt</kbd>-click the map
            </span>
          </div>
        </Section>
      )}

      {spec.stratum && (
        <Section id="world-ground" title="Ground" summary={settings.strata[stratum]?.label ?? '—'}>
          <div className="world__strata" role="group" aria-label="Ground material">
            {settings.strata.map((profile, index) => (
              <button
                key={profile.id}
                type="button"
                className="world__stratum"
                aria-pressed={index === stratum}
                title={describe(profile)}
                onClick={() => props.onStratum(index)}
              >
                <span className="world__swatch" style={{ background: cssColor(profile) }} aria-hidden="true" />
                {profile.label}
              </button>
            ))}
          </div>
          <p className="world__hint">{describe(settings.strata[stratum] ?? settings.strata[0]!)}</p>
        </Section>
      )}

    </>
  );
}

/**
 * A slider and a number that edit the same value.
 *
 * The number is committed on change rather than on blur, and clamped here rather than trusted
 * from the input: `<input type="number">` happily reports an empty string and a `min` it was
 * given, so a caller that believed the element would end up with a `NaN` radius and a brush
 * that silently stops working.
 */
function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  const clamp = (raw: number) =>
    Number.isFinite(raw) ? Math.max(props.min, Math.min(props.max, raw)) : props.min;

  return (
    <label className="world__slider">
      <span className="world__label">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(clamp(Number(event.target.value)))}
      />
      <input
        type="number"
        className="world__number ui-num"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(clamp(Number(event.target.value)))}
      />
      <span className="world__unit">{props.unit}</span>
    </label>
  );
}

function cssColor(profile: SurfaceProfile): string {
  const [r, g, b] = profileColor(profile);
  return `rgb(${r} ${g} ${b})`;
}

/** What a profile actually lays down, in the order it lays it. */
function describe(profile: SurfaceProfile): string {
  const short = (ref: string) => ref.replace(/^minecraft:/, '').replace(/_/g, ' ');
  return `${short(profile.surface)} over ${profile.subsurfaceDepth}× ${short(profile.subsurface)}, then ${short(profile.filler)}`;
}
