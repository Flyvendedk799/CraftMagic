/**
 * The viewport's own controls, along the bottom of the studio.
 *
 * Everything here changes how the build is *looked at* and nothing here changes the build,
 * which is why it sits with the viewport instead of in either sidebar. The old layout had
 * the layer slider stretched across the full width of the window for one value, the hover
 * readout floating in the middle of the scene on top of the thing it described, and no way
 * at all to get the camera back once you had spun it — three symptoms of the same missing
 * surface.
 *
 * The layer control is a **range** rather than a ceiling. A ceiling can only answer "how far
 * up has it been built"; a range answers "what does course 7 look like", which is the
 * question someone copying a build into Minecraft is actually asking, and it is one control
 * away from the ceiling behaviour they had before.
 */

import { useCallback } from 'react';
import type { VoxelHit } from './raycast.js';
import type { CameraPreset, DisplayOptions, LayerRange } from './viewport.js';

export interface ViewBarProps {
  /** Highest layer index in the build; the range can never exceed it. */
  topLayer: number;
  range: LayerRange | null;
  onRange: (next: LayerRange | null) => void;

  display: DisplayOptions;
  onDisplay: (next: DisplayOptions) => void;
  onView: (preset: CameraPreset) => void;

  /** What the pointer is over, and what a click would do to it. */
  hover: VoxelHit | null;
  hoverBlock: string | null;
  toolVerb: string;

  /** Chunks left to mesh, and how many there are in total, for the progress strip. */
  remaining: number;
  totalChunks: number;
}

const VIEWS: readonly { preset: CameraPreset; label: string; title: string }[] = [
  { preset: 'frame', label: 'Fit', title: 'Frame the whole build from here (F)' },
  { preset: 'iso', label: 'Iso', title: 'Three-quarter view' },
  { preset: 'front', label: 'Front', title: 'Straight on' },
  { preset: 'side', label: 'Side', title: 'From the side' },
  { preset: 'top', label: 'Top', title: 'Looking down' },
];

export function ViewBar({
  topLayer,
  range,
  onRange,
  display,
  onDisplay,
  onView,
  hover,
  hoverBlock,
  toolVerb,
  remaining,
  totalChunks,
}: ViewBarProps) {
  // A null range means "all of it", but the sliders still have to sit somewhere, so they
  // render the full span and only *writing* to them creates a real range.
  const min = range?.min ?? 0;
  const max = range?.max ?? topLayer;
  const sliced = range !== null && (range.min > 0 || range.max < topLayer);

  const setMin = useCallback(
    (value: number) => onRange({ min: Math.min(value, max), max }),
    [onRange, max],
  );
  const setMax = useCallback(
    (value: number) => onRange({ min, max: Math.max(value, min) }),
    [onRange, min],
  );

  /** One course at the current top — the "show me this layer" gesture, as one click. */
  const solo = useCallback(() => onRange({ min: max, max }), [onRange, max]);

  const meshed = totalChunks === 0 ? 1 : 1 - remaining / totalChunks;

  return (
    <footer className="viewbar" data-sliced={sliced}>
      {remaining > 0 && (
        <div
          className="viewbar__progress"
          role="progressbar"
          aria-label="Meshing"
          aria-valuenow={Math.round(meshed * 100)}
        >
          <span style={{ width: `${Math.round(meshed * 100)}%` }} />
        </div>
      )}

      <div className="viewbar__group viewbar__group--layers">
        <span className="viewbar__label">Layers</span>

        {/* Two inputs stacked on one track. A native range has one thumb, and a hand-rolled
            two-thumb widget loses keyboard support, screen-reader semantics and the OS's own
            drag behaviour — all of which matter more here than the extra pixel of polish. */}
        <div className="dualrange">
          <span className="dualrange__track" aria-hidden="true">
            <span
              className="dualrange__fill"
              style={{
                left: `${(min / Math.max(1, topLayer)) * 100}%`,
                right: `${100 - (max / Math.max(1, topLayer)) * 100}%`,
              }}
            />
          </span>
          <input
            className="dualrange__input dualrange__input--min"
            type="range"
            min={0}
            max={topLayer}
            value={min}
            onChange={(event) => setMin(Number(event.target.value))}
            aria-label="Lowest visible layer"
          />
          <input
            className="dualrange__input dualrange__input--max"
            type="range"
            min={0}
            max={topLayer}
            value={max}
            onChange={(event) => setMax(Number(event.target.value))}
            aria-label="Highest visible layer"
          />
        </div>

        <span className="viewbar__value">
          y {min}–{max}
        </span>

        <button type="button" className="viewbar__btn" onClick={solo} title="Show only the top course ([ and ] step it)">
          Solo
        </button>
        <button
          type="button"
          className="viewbar__btn"
          onClick={() => onRange(null)}
          disabled={!sliced}
          title="Show every layer (\\)"
        >
          All
        </button>
      </div>

      <div className="viewbar__group viewbar__group--view">
        <span className="viewbar__label">View</span>
        {VIEWS.map((view) => (
          <button
            key={view.preset}
            type="button"
            className="viewbar__btn"
            title={view.title}
            onClick={() => onView(view.preset)}
          >
            {view.label}
          </button>
        ))}

        <span className="viewbar__divider" aria-hidden="true" />

        <Toggle
          label="Grid"
          on={display.grid}
          onChange={(on) => onDisplay({ ...display, grid: on })}
        />
        <Toggle
          label="Bounds"
          on={display.bounds}
          onChange={(on) => onDisplay({ ...display, bounds: on })}
        />
        <Toggle
          label="Cursor"
          on={display.highlight}
          onChange={(on) => onDisplay({ ...display, highlight: on })}
        />
      </div>

      {/* Kept as `.hover-readout` and kept containing a `<strong>`: it is how the editing
          driver reads which block it is about to click. */}
      <div className="viewbar__group viewbar__group--readout hover-readout">
        {hover ? (
          <>
            <strong>{hoverBlock}</strong>
            <span className="viewbar__coords">
              {hover.x}, {hover.y}, {hover.z} · {hover.face}
            </span>
          </>
        ) : (
          <span className="viewbar__idle">
            drag to orbit · scroll to zoom · click to {toolVerb}
          </span>
        )}
      </div>
    </footer>
  );
}

function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="viewbar__btn viewbar__btn--toggle"
      aria-pressed={on}
      onClick={() => onChange(!on)}
    >
      {label}
    </button>
  );
}
