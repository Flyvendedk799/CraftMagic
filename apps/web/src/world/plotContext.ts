/**
 * The plot a plan was started from, so the 3D preview can show the ground and the neighbours.
 *
 * Architecture compiles a building and nothing else. Starting from the map should not drop
 * that building into an empty void. The view that was on screen — terrain, the placement,
 * whatever stands next to it — is kept here for the next Plan mount.
 */

import { voxelIndex, type VoxelGrid, type WorldPlacement } from '@craftmagic/core';
import type { RegionArea } from '@craftmagic/core';

export interface PlotContext {
  grid: VoxelGrid;
  /** Placement footprint in that grid's local coordinates. */
  ox: number;
  oz: number;
  w: number;
  d: number;
  h: number;
  label: string;
}

let current: PlotContext | null = null;

export function offerPlot(context: PlotContext): void {
  current = context;
}

export function readPlot(): PlotContext | null {
  return current;
}

export function plotFromView(
  grid: VoxelGrid,
  area: RegionArea,
  regionSize: number,
  placement: WorldPlacement,
): PlotContext {
  const turned = placement.turns === 1 || placement.turns === 3;
  return {
    grid: {
      size: grid.size,
      palette: grid.palette.slice(),
      voxels: grid.voxels.slice(),
    },
    ox: placement.x - area.rx0 * regionSize,
    oz: placement.z - area.rz0 * regionSize,
    w: turned ? placement.d : placement.w,
    d: turned ? placement.w : placement.d,
    h: placement.h,
    label: placement.name,
  };
}

/** The compiled building, standing on the plot in place of the one that was there. */
export function stampOnPlot(plot: PlotContext, building: VoxelGrid): VoxelGrid {
  const grid: VoxelGrid = {
    size: plot.grid.size,
    palette: plot.grid.palette.slice(),
    voxels: plot.grid.voxels.slice(),
  };
  const cx = Math.min(grid.size.x - 1, Math.max(0, plot.ox + Math.floor(plot.w / 2)));
  const cz = Math.min(grid.size.z - 1, Math.max(0, plot.oz + Math.floor(plot.d / 2)));
  let top = 0;
  for (let y = 0; y < grid.size.y; y++) {
    if (grid.voxels[voxelIndex(grid.size, cx, y, cz)] !== 0) top = y;
  }
  const base = Math.max(0, top - plot.h + 1);
  for (let y = base; y < Math.min(grid.size.y, base + Math.max(plot.h, building.size.y)); y++) {
    for (let z = 0; z < plot.d; z++) {
      for (let x = 0; x < plot.w; x++) {
        const wx = plot.ox + x;
        const wz = plot.oz + z;
        if (wx < 0 || wz < 0 || wx >= grid.size.x || wz >= grid.size.z) continue;
        grid.voxels[voxelIndex(grid.size, wx, y, wz)] = 0;
      }
    }
  }
  const slotOf = new Map(grid.palette.map((ref, index) => [ref, index]));
  for (let y = 0; y < building.size.y; y++) {
    for (let z = 0; z < building.size.z; z++) {
      for (let x = 0; x < building.size.x; x++) {
        const value = building.voxels[voxelIndex(building.size, x, y, z)]!;
        if (value === 0) continue;
        const wx = plot.ox + x;
        const wy = base + y;
        const wz = plot.oz + z;
        if (wx < 0 || wy < 0 || wz < 0 || wx >= grid.size.x || wy >= grid.size.y || wz >= grid.size.z) continue;
        const ref = building.palette[value] ?? 'minecraft:stone';
        let slot = slotOf.get(ref);
        if (slot === undefined) {
          slot = grid.palette.length;
          grid.palette.push(ref);
          slotOf.set(ref, slot);
        }
        grid.voxels[voxelIndex(grid.size, wx, wy, wz)] = slot;
      }
    }
  }
  return grid;
}
