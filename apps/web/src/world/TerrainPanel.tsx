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
import { WORLD_TOOLS, toolSpec, type WorldTool } from './toolset.js';

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
  /** The column under the pointer, so the readout is a fact rather than a guess. */
  hover: { x: number; z: number; height: number; stratum: number } | null;
}

export function TerrainPanel(props: TerrainPanelProps) {
  const { settings, tool, brush, stratum, targetY, hover } = props;
  const spec = toolSpec(tool);

  return (
    <>
      <Section id="world-tools" title="Tools" summary={spec.label}>
        <div className="world__tools" role="group" aria-label="Terrain tools">
          {WORLD_TOOLS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="world__tool"
              aria-pressed={entry.id === tool}
              title={`${entry.hint}  (${entry.key})`}
              onClick={() => props.onTool(entry.id)}
            >
              <span className="world__tool-key">{entry.key}</span>
              {entry.label}
            </button>
          ))}
        </div>
        <p className="world__hint">{spec.hint}</p>
      </Section>

      {spec.brush && (
        <Section id="world-brush" title="Brush" summary={`${brush.radius}`}>
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
            <div className="world__segmented" role="group" aria-label="Brush falloff">
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
              : 'Full strength to the rim — a plaza wants an edge.'}
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
          <div className="world__row">
            <button
              type="button"
              className="world__mini"
              onClick={() => props.onTargetY(settings.seaLevel)}
            >
              Sea level ({settings.seaLevel})
            </button>
            {hover && (
              <button type="button" className="world__mini" onClick={() => props.onTargetY(hover.height)}>
                Under cursor ({hover.height})
              </button>
            )}
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

      <Section id="world-readout" title="Cursor" defaultOpen={false} summary={hover ? `${hover.x}, ${hover.z}` : '—'}>
        {hover ? (
          <dl className="world__facts">
            <div><dt>Column</dt><dd>{hover.x}, {hover.z}</dd></div>
            <div><dt>Height</dt><dd>y {hover.height}</dd></div>
            <div><dt>Ground</dt><dd>{settings.strata[hover.stratum]?.label ?? '—'}</dd></div>
            <div><dt>Depth</dt><dd>{hover.height - settings.minY + 1} blocks</dd></div>
          </dl>
        ) : (
          <p className="world__hint">Move over the map.</p>
        )}
      </Section>
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
        className="world__number"
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
