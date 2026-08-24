/**
 * Resize the whole build.
 *
 * This is the visible payoff of generating a *program* rather than voxels: changing the size
 * re-runs the program with every coordinate scaled, so the walls, the roof pitch, the pillar
 * spacing and the dome all grow together. Scaling a voxel grid could only stretch or resample
 * it, which is why this control belongs here and not in the editing tools.
 *
 * Two modes, because both are things people actually want:
 *
 *   * **Linked** — one slider, all three axes together. Overwhelmingly the common case: "make
 *     it bigger" almost never means "make it wider only".
 *   * **Per axis** — three sliders, for a tower that should be taller without becoming fatter.
 *
 * Linked is the default and stays selected until someone deliberately unlinks, so the simple
 * case needs one drag and the harder one is still reachable.
 */

import { useCallback } from 'react';
import type { ScaleOutcome } from './builds.js';
import { NO_SCALE, type ScalePercent } from './builds.js';
// Shared with the URL clamp: a slider that ranges wider than the link can carry would snap
// back on reload.
import { SCALE_MAX as MAX, SCALE_MIN as MIN } from './urlState.js';

export interface ScalePanelProps {
  scale: ScalePercent;
  /** The size this scale produces, and whether an axis hit the engine cap. */
  outcome: ScaleOutcome | null;
  /** The program's own size — what 100% means. */
  base: { x: number; y: number; z: number } | null;
  onChange: (next: ScalePercent) => void;
}

/** Round to a step so dragging lands on tidy numbers rather than 137%. */
const STEP = 5;

const AXES = [
  { key: 'x', label: 'Width', hint: 'X' },
  { key: 'y', label: 'Height', hint: 'Y' },
  { key: 'z', label: 'Depth', hint: 'Z' },
] as const;

export function ScalePanel({ scale, outcome, base, onChange }: ScalePanelProps) {
  const linked = scale.x === scale.y && scale.y === scale.z;
  const uniform = scale.x;

  const setUniform = useCallback(
    (percent: number) => onChange({ x: percent, y: percent, z: percent }),
    [onChange],
  );

  const setAxis = useCallback(
    (axis: 'x' | 'y' | 'z', percent: number) => onChange({ ...scale, [axis]: percent }),
    [onChange, scale],
  );

  const changed = scale.x !== 100 || scale.y !== 100 || scale.z !== 100;

  return (
    <div className="params scale">
      <div className="scale__head">
        <p className="params__title">Scale</p>
        <div className="scale__modes">
          <button
            type="button"
            className={`scale__mode ${linked ? 'scale__mode--on' : ''}`}
            onClick={() => setUniform(uniform)}
            title="One slider for all three axes"
          >
            Linked
          </button>
          <button
            type="button"
            className={`scale__mode ${linked ? '' : 'scale__mode--on'}`}
            // Nudging one axis is what makes the three sliders appear, so unlinking has to
            // actually change something or the button would look inert.
            onClick={() => onChange({ ...scale, y: Math.max(MIN, Math.min(MAX, scale.y - STEP)) })}
            title="A slider per axis"
          >
            Per axis
          </button>
        </div>
      </div>

      {linked ? (
        <label className="param">
          <span className="param__label">Size</span>
          <input
            className="param__slider"
            type="range"
            min={MIN}
            max={MAX}
            step={STEP}
            value={uniform}
            onChange={(event) => setUniform(Number(event.target.value))}
          />
          <span className="param__value">{uniform}%</span>
        </label>
      ) : (
        AXES.map(({ key, label, hint }) => (
          <label key={key} className="param">
            <span className="param__label">
              {label} <span className="scale__axis">{hint}</span>
            </span>
            <input
              className="param__slider"
              type="range"
              min={MIN}
              max={MAX}
              step={STEP}
              value={scale[key]}
              onChange={(event) => setAxis(key, Number(event.target.value))}
            />
            <span className="param__value">{scale[key]}%</span>
          </label>
        ))
      )}

      <p className="scale__readout">
        {outcome ? (
          <>
            <strong>
              {outcome.size.x}×{outcome.size.y}×{outcome.size.z}
            </strong>
            {base && (
              <span className="scale__base">
                {' '}
                from {base.x}×{base.y}×{base.z}
              </span>
            )}
          </>
        ) : (
          '—'
        )}
        {changed && (
          <button type="button" className="scale__reset" onClick={() => onChange(NO_SCALE)}>
            Reset
          </button>
        )}
      </p>

      {outcome?.clamped && (
        <p className="scale__warn">
          At the engine’s size limit — an axis stopped growing rather than producing a build the
          expander would refuse.
        </p>
      )}
    </div>
  );
}
