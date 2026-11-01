import type { ViewKind } from './EditorCanvas.js';

export interface ViewEntry {
  kind: ViewKind;
  label: string;
}

export const VIEWS: readonly ViewEntry[] = [
  { kind: 'iso', label: 'Iso' },
  { kind: 'top', label: 'Top' },
  { kind: 'front', label: 'Front' },
  { kind: 'side', label: 'Side' },
];

export interface LayersHudProps {
  layer: number | null;
  topLayer: number;
  isolate: boolean;
  ortho: boolean;
  enhanced: boolean;
  views?: readonly ViewEntry[];
  onUpdate: (update: { layer?: number | null; toggleIsolate?: boolean }) => void;
  onSetView: (kind: ViewKind) => void;
  onToggleOrtho: () => void;
  onToggleEnhanced: () => void;
  onTakeScreenshot: () => void;
}

export function LayersHud({
  layer,
  topLayer,
  isolate,
  ortho,
  enhanced,
  views = VIEWS,
  onUpdate,
  onSetView,
  onToggleOrtho,
  onToggleEnhanced,
  onTakeScreenshot,
}: LayersHudProps) {
  return (
    <section className="hud hud--layers" aria-label="Layer slicing and camera framing">
      <div className="layers__slice-controls" role="group" aria-label="Layer slicing controls">
        <span className="layers__label">Layer</span>
        <input
          className="layers__slider"
          type="range"
          min={0}
          max={topLayer}
          value={layer ?? topLayer}
          onChange={(event) => onUpdate({ layer: Number(event.target.value) })}
          aria-label="Highest visible layer"
        />
        <span className="layers__value" data-isolated={isolate}>
          {layer === null ? `y 0–${topLayer}` : isolate ? `y ${layer}` : `y 0–${layer}`}
        </span>
        <button
          type="button"
          aria-pressed={isolate}
          disabled={layer === null}
          title="Show only the cut layer  (I)"
          onClick={() => onUpdate({ toggleIsolate: true })}
        >
          Isolate
        </button>
        <button
          type="button"
          onClick={() => onUpdate({ layer: null })}
          disabled={layer === null}
        >
          Show all
        </button>
      </div>

      <div className="layers__views" role="group" aria-label="Camera framing controls">
        {views.map((entry) => (
          <button
            key={entry.kind}
            type="button"
            title={`Look from ${entry.label.toLowerCase()}${entry.kind === 'iso' ? '  (F)' : ''}`}
            onClick={() => onSetView(entry.kind)}
          >
            {entry.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={ortho}
          title="Orthographic projection — no perspective, true proportions"
          onClick={onToggleOrtho}
        >
          Ortho
        </button>
        <button
          type="button"
          aria-pressed={enhanced}
          title="Lit, grained rendering with sky and fog. Classic is the flat look."
          onClick={onToggleEnhanced}
        >
          ✨
        </button>
        <button
          type="button"
          title="Save the current view as a PNG"
          onClick={onTakeScreenshot}
        >
          📷
        </button>
      </div>
    </section>
  );
}
