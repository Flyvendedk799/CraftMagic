import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { displayName, type BuildStep } from '@craftmagic/core';
import {
  cellSizeFor,
  columnLabel,
  drawLayerPlan,
  isInteriorVoid,
  isPlanCellOverhang,
  type LayerPlan,
} from './layerGrid.js';

export interface HoverCellInfo {
  colLabel: string;
  rowNumber: number;
  worldX: number;
  worldY: number;
  worldZ: number;
  blockName?: string;
  status: string;
  isOverhang: boolean;
  isPlaced: boolean;
}

export interface LayerPlanCanvasProps {
  plan?: LayerPlan | null;
  step?: BuildStep;
  className?: string;
  caption?: string;
}

const GUTTER_LEFT = 26;
const GUTTER_TOP = 18;
const PAD = 6;

export function LayerPlanCanvas({
  plan,
  step,
  className = '',
  caption,
}: LayerPlanCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoverCellInfo | null>(null);

  useLayoutEffect(() => {
    if (canvasRef.current && plan) {
      drawLayerPlan(canvasRef.current, plan);
    }
  }, [plan]);

  // Map of placed coordinates to display names from step callouts / palette
  const blockNames = useMemo(() => {
    const map = new Map<string, string>();
    if (!step) return map;

    for (const b of step.blocks) {
      const key = `${b.x},${b.z}`;
      const blockRef = plan?.palette?.[b.paletteIndex];
      if (blockRef) {
        const baseId = blockRef.split('[')[0];
        const callout = step.callouts?.find(
          (c) => c.block === blockRef || c.baseId === baseId || c.baseId === blockRef,
        );
        if (callout) {
          map.set(key, callout.displayName);
        } else {
          map.set(key, displayName(blockRef));
        }
      } else if (step.callouts && step.callouts.length === 1 && step.callouts[0]) {
        map.set(key, step.callouts[0].displayName);
      }
    }
    return map;
  }, [step, plan?.palette]);

  if (!plan) {
    return (
      <div
        ref={containerRef}
        className={`layer-plan-wrapper layer-plan-wrapper--empty ${className}`.trim()}
      >
        <div className="layer-plan__empty-fallback">
          <span>Plan not available</span>
        </div>
      </div>
    );
  }

  const cols = plan.footprint.x1 - plan.footprint.x0 + 1;
  const rows = plan.footprint.z1 - plan.footprint.z0 + 1;
  const cell = cellSizeFor(cols, rows);
  const totalW = GUTTER_LEFT + cols * cell + PAD * 2;
  const totalH = GUTTER_TOP + rows * cell + PAD * 2;
  const originX = GUTTER_LEFT + PAD;
  const originY = GUTTER_TOP + PAD;

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const scaleX = totalW / rect.width;
    const scaleY = totalH / rect.height;

    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * scaleY;

    const gridX = mouseX - originX;
    const gridY = mouseY - originY;

    if (gridX >= 0 && gridX < cols * cell && gridY >= 0 && gridY < rows * cell) {
      const colIdx = Math.floor(gridX / cell);
      const rowIdx = Math.floor(gridY / cell);
      const worldX = plan.footprint.x0 + colIdx;
      const worldZ = plan.footprint.z0 + rowIdx;
      const worldY = plan.layer;
      const colLabel = columnLabel(worldX);
      const rowNumber = worldZ + 1;

      // Check cell status
      const placedCell = plan.placed.find((c) => c.x === worldX && c.z === worldZ);
      const isPlaced = Boolean(placedCell);
      const isEarlier = plan.earlier.some((c) => c.x === worldX && c.z === worldZ);

      let isOverhang = false;
      let status = 'Empty space';
      let blockName: string | undefined;

      if (placedCell) {
        isOverhang = isPlanCellOverhang(plan, placedCell);
        status = isOverhang ? 'Overhang: place on side face' : 'Solid foundation';
        const blockRef = plan.palette?.[placedCell.paletteIndex];
        const baseId = blockRef ? blockRef.split('[')[0] : undefined;
        const callout = blockRef
          ? step?.callouts?.find((c) => c.block === blockRef || c.baseId === baseId || c.baseId === blockRef)
          : undefined;
        blockName =
          blockNames.get(`${worldX},${worldZ}`) ??
          callout?.displayName ??
          (blockRef ? displayName(blockRef) : undefined) ??
          (step?.callouts?.length === 1 ? step.callouts[0]?.displayName : undefined) ??
          step?.title;
      } else if (isEarlier) {
        status = 'Placed earlier in this layer';
      } else if (plan.layer > 0) {
        const belowIdx = (plan.layer - 1) * plan.size.x * plan.size.z + worldZ * plan.size.x + worldX;
        if (plan.voxels[belowIdx] !== 0) {
          status = `Solid below (y = ${plan.layer - 1})`;
        } else if (isInteriorVoid(plan, worldX, worldZ)) {
          status = 'Open interior shaft below';
        }
      }

      setHoverInfo({
        colLabel,
        rowNumber,
        worldX,
        worldY,
        worldZ,
        blockName,
        status,
        isOverhang,
        isPlaced,
      });
    } else {
      setHoverInfo(null);
    }
  };

  const handlePointerLeave = () => {
    setHoverInfo(null);
  };

  return (
    <div
      ref={containerRef}
      className={`layer-plan-wrapper ${className}`.trim()}
    >
      <canvas
        ref={canvasRef}
        className="panel__plan"
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onMouseMove={handlePointerMove}
        onMouseLeave={handlePointerLeave}
        aria-label={caption ?? `Layer plan for layer y = ${plan.layer}`}
      />

      <div
        className={`layer-plan__inspector ${
          hoverInfo?.isOverhang ? 'layer-plan__inspector--warning' : ''
        }`.trim()}
        role="status"
        aria-live="polite"
      >
        {hoverInfo ? (
          <>
            <span className="inspector__coord">
              Col {hoverInfo.colLabel}, Row {hoverInfo.rowNumber} (x: {hoverInfo.worldX}, y: {hoverInfo.worldY}, z: {hoverInfo.worldZ})
            </span>
            {hoverInfo.blockName && (
              <span className="inspector__name">{hoverInfo.blockName}</span>
            )}
            <span
              className={`inspector__status ${
                hoverInfo.isOverhang ? 'inspector__status--overhang' : ''
              }`}
            >
              {hoverInfo.status}
            </span>
          </>
        ) : (
          <span className="inspector__hint">
            Hover over the grid to inspect coordinates & overhang warnings
          </span>
        )}
      </div>
    </div>
  );
}
