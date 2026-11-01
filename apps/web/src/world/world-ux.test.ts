import { describe, expect, it } from 'vitest';
import type { WorldPlacement } from '@craftmagic/core';
import {
  WORLD_TOOLS,
  WORLD_TOOL_GROUPS,
  dropCorner,
  placementFacing,
  placementFootprint,
  toolSpec,
  turnedAboutCentre,
} from './toolset.js';
import { WorldHistory } from './history.js';

describe('World Mode UI/UX Streamlining - Criteria Verification', () => {
  describe('C1: Left Dock Grouping and Active Toolset', () => {
    it('organizes tools into shape, surface, and arrange groups', () => {
      const groupIds = WORLD_TOOL_GROUPS.map((g) => g.id);
      expect(groupIds).toEqual(['shape', 'surface', 'arrange']);

      const shapeTools = WORLD_TOOLS.filter((t) => t.group === 'shape').map((t) => t.id);
      expect(shapeTools).toEqual(['raise', 'lower', 'level', 'smooth']);

      const surfaceTools = WORLD_TOOLS.filter((t) => t.group === 'surface').map((t) => t.id);
      expect(surfaceTools).toEqual(['paint', 'carve']);

      const arrangeTools = WORLD_TOOLS.filter((t) => t.group === 'arrange').map((t) => t.id);
      expect(arrangeTools).toEqual(['select', 'place', 'pan']);
    });

    it('identifies stratum and brush configuration correctly', () => {
      const paint = toolSpec('paint');
      expect(paint.stratum).toBe(true);
      expect(paint.brush).toBe(true);

      const carve = toolSpec('carve');
      expect(carve.target).toBe(true);
      expect(carve.brush).toBe(true);
      expect(carve.stratum).toBe(false);

      const raise = toolSpec('raise');
      expect(raise.brush).toBe(true);
      expect(raise.target).toBe(false);
    });
  });

  describe('C2: Right Dock Placement Inspector & Details', () => {
    const placement: WorldPlacement = {
      id: 'place-test-1',
      buildId: 'b-cottage',
      x: 120,
      z: 80,
      y: 64,
      anchor: 'surface',
      turns: 0,
      name: 'Cozy Cottage',
      w: 16,
      h: 12,
      d: 24,
    };

    it('calculates footprint and rotated dimensions for inspector details', () => {
      const box0 = placementFootprint(placement);
      expect(box0).toEqual({ x: 120, z: 80, w: 16, d: 24 });

      const turned1 = { ...placement, ...turnedAboutCentre(placement, 1) };
      const box1 = placementFootprint(turned1);
      expect(box1).toEqual({ x: 116, z: 84, w: 24, d: 16 });
    });

    it('preserves building center during inspector quarter turns', () => {
      const cx0 = placement.x + placement.w / 2;
      const cz0 = placement.z + placement.d / 2;

      const turned = { ...placement, ...turnedAboutCentre(placement, 1) };
      const turnedBox = placementFootprint(turned);
      const cx1 = turnedBox.x + turnedBox.w / 2;
      const cz1 = turnedBox.z + turnedBox.d / 2;

      expect(cx1).toBe(cx0);
      expect(cz1).toBe(cz0);
    });
  });

  describe('C3: Viewport Overlays and Orientation Indicators', () => {
    it('computes exact front edge coordinates for placement orientation visual cues', () => {
      const box = { x: 50, z: 100, w: 20, d: 30 };

      // Turns 0: front facing south (+z edge, y = 100 + 30 = 130)
      const south = placementFacing(box, 0);
      expect(south).toEqual({ x1: 50, y1: 130, x2: 70, y2: 130 });

      // Turns 1: front facing west (-x edge, x = 50)
      const west = placementFacing(box, 1);
      expect(west).toEqual({ x1: 50, y1: 100, x2: 50, y2: 130 });

      // Turns 2: front facing north (-z edge, y = 100)
      const north = placementFacing(box, 2);
      expect(north).toEqual({ x1: 50, y1: 100, x2: 70, y2: 100 });

      // Turns 3: front facing east (+x edge, x = 50 + 20 = 70)
      const east = placementFacing(box, 3);
      expect(east).toEqual({ x1: 70, y1: 100, x2: 70, y2: 130 });
    });
  });

  describe('C4: Core Workflows Intact (Undo/Redo and Drops)', () => {
    it('manages undo/redo delta stacks accurately', () => {
      const history = new WorldHistory();
      expect(history.canUndo).toBe(false);
      expect(history.canRedo).toBe(false);

      const p0: WorldPlacement[] = [];
      const p1: WorldPlacement[] = [
        {
          id: 'p1',
          buildId: 'b1',
          x: 10,
          z: 10,
          y: 60,
          anchor: 'surface',
          turns: 0,
          name: 'P1',
          w: 8,
          h: 8,
          d: 8,
        },
      ];

      history.push({ kind: 'placements', before: p0, after: p1 });
      expect(history.canUndo).toBe(true);
      expect(history.depth).toBe(1);

      const undone = history.undo();
      expect(undone).toEqual({ kind: 'placements', before: p0, after: p1 });
      expect(history.canUndo).toBe(false);
      expect(history.canRedo).toBe(true);

      const redone = history.redo();
      expect(redone).toEqual({ kind: 'placements', before: p0, after: p1 });
      expect(history.canUndo).toBe(true);
      expect(history.canRedo).toBe(false);
    });

    it('centers dropped components correctly within bounds', () => {
      const size = { x: 256, z: 256 };
      const footprint = { w: 16, d: 20 };

      const dropAtCenter = dropCorner(128, 128, footprint, size);
      expect(dropAtCenter).toEqual({ x: 120, z: 118 });

      const dropAtOrigin = dropCorner(0, 0, footprint, size);
      expect(dropAtOrigin).toEqual({ x: 0, z: 0 });

      const dropAtFarEdge = dropCorner(300, 300, footprint, size);
      expect(dropAtFarEdge).toEqual({ x: 255, z: 255 });
    });
  });
});
