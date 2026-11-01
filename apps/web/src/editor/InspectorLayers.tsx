export interface InspectorLayersProps {
  layer: number | null;
  isolate: boolean;
  topLayer: number;
  onUpdate: (update: { layer?: number | null; toggleIsolate?: boolean }) => void;
}

export function InspectorLayers({ layer, isolate, topLayer, onUpdate }: InspectorLayersProps) {
  return (
    <div className="inspector__layers">
      <div className="inspector__layers-head">
        <span className="inspector__layers-title">Layer Slice</span>
        <span className="inspector__layers-value">
          {layer === null ? `All (0–${topLayer})` : isolate ? `y ${layer} (isolated)` : `y 0–${layer}`}
        </span>
      </div>
      <div className="inspector__layers-row">
        <input
          className="inspector__layers-slider"
          type="range"
          min={0}
          max={topLayer}
          value={layer ?? topLayer}
          onChange={(event) => onUpdate({ layer: Number(event.target.value) })}
          aria-label="Inspector layer slider"
        />
      </div>
      <div className="inspector__layers-actions">
        <button
          type="button"
          className="inspector__layers-btn"
          aria-pressed={isolate}
          disabled={layer === null}
          onClick={() => onUpdate({ toggleIsolate: true })}
        >
          Isolate
        </button>
        <button
          type="button"
          className="inspector__layers-btn"
          disabled={layer === null}
          onClick={() => onUpdate({ layer: null })}
        >
          Show all
        </button>
      </div>
    </div>
  );
}
