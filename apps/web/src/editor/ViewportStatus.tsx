import { colorOf, displayName, type BlockRef } from '@craftmagic/core';
import { ToolIcon } from './ToolIcons.js';
import { TOOL_BY_ID, type ToolId } from './toolset.js';
import type { BrushShape } from './tools/brush.js';

export interface ViewportStatusProps {
  tool: ToolId;
  block: BlockRef;
  brushRadius: number;
  brushShape: BrushShape;
  symmetry: boolean;
  layer: number | null;
  isolate: boolean;
  topLayer: number;
}

export function ViewportStatus({
  tool,
  block,
  brushRadius,
  brushShape,
  symmetry,
  layer,
  isolate,
  topLayer,
}: ViewportStatusProps) {
  const toolSpec = TOOL_BY_ID[tool];

  return (
    <div
      className="hud hud--viewport-status"
      role="status"
      aria-label="Active tool and layer feedback"
    >
      <div
        className="viewport-status__item viewport-status__item--tool"
        title={`Active tool: ${toolSpec?.label ?? tool} (${toolSpec?.key})`}
      >
        <ToolIcon tool={tool} />
        <span className="viewport-status__label">{toolSpec?.label ?? tool}</span>
        <kbd className="viewport-status__key">{toolSpec?.key}</kbd>
      </div>

      {toolSpec?.needsBlock && (
        <div
          className="viewport-status__item viewport-status__item--block"
          title={`Active block: ${displayName(block)} (${block})`}
        >
          <span
            className="viewport-status__swatch"
            style={{ backgroundColor: `rgb(${colorOf(block).join(' ')})` }}
            aria-hidden="true"
            data-testid="block-swatch"
          />
          <span className="viewport-status__block-name">{displayName(block)}</span>
        </div>
      )}

      {toolSpec?.usesBrush && (
        <div
          className="viewport-status__item viewport-status__item--brush"
          title={`Brush size: ${brushRadius * 2 + 1}×${brushRadius * 2 + 1}, shape: ${brushShape}`}
        >
          <span className="viewport-status__badge">
            {brushRadius * 2 + 1}×{brushRadius * 2 + 1} {brushShape === 'ball' ? '●' : '■'}
          </span>
        </div>
      )}

      {symmetry && (
        <div
          className="viewport-status__item viewport-status__item--symmetry"
          title="Midplane symmetry is enabled"
        >
          <span className="viewport-status__badge">⇋ Symmetry</span>
        </div>
      )}

      <div className="viewport-status__item viewport-status__item--layer" title="Current layer visibility">
        <span className="viewport-status__layer-pill" data-isolated={isolate}>
          {layer === null
            ? `All layers (y 0–${topLayer})`
            : isolate
              ? `Layer y ${layer} (isolated)`
              : `Layers y 0–${layer}`}
        </span>
      </div>
    </div>
  );
}
