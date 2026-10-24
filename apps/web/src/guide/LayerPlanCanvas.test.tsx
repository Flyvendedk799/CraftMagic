// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildStep } from '@craftmagic/core';
import type { LayerPlan } from './layerGrid.js';
import { LayerPlanCanvas } from './LayerPlanCanvas.js';

afterEach(() => {
  cleanup();
});

describe('LayerPlanCanvas component', () => {
  const samplePlan: LayerPlan = {
    size: { x: 5, y: 5, z: 5 },
    voxels: new Uint16Array(125),
    paletteColors: new Uint8Array([0, 0, 0, 100, 100, 100, 150, 100, 50]),
    footprint: { x0: 0, z0: 0, x1: 4, z1: 4 },
    layer: 1,
    placed: [{ x: 1, z: 1, paletteIndex: 1 }],
    earlier: [{ x: 0, z: 0, paletteIndex: 1 }],
  };

  const sampleStep: BuildStep = {
    index: 1,
    layer: 1,
    title: 'Cobblestone Wall',
    parts: [],
    blocks: [{ x: 1, y: 1, z: 1, paletteIndex: 1 }],
    materials: [],
    callouts: [
      {
        block: 'minecraft:cobblestone',
        baseId: 'minecraft:cobblestone',
        displayName: 'Cobblestone',
        count: 1,
        states: {},
      },
    ],
    orientation: 'SE',
  };

  it('renders canvas element with accessible aria-label and default inspector status', () => {
    render(<LayerPlanCanvas plan={samplePlan} step={sampleStep} caption="Custom Layer Plan" />);

    const canvas = screen.getByLabelText('Custom Layer Plan');
    expect(canvas).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(
      screen.getByText('Hover over the grid to inspect coordinates & overhang warnings'),
    ).toBeTruthy();
  });

  it('renders default aria-label when no caption is provided', () => {
    render(<LayerPlanCanvas plan={samplePlan} />);
    expect(screen.getByLabelText('Layer plan for layer y = 1')).toBeTruthy();
  });

  it('renders fallback container when plan is undefined or null', () => {
    const { rerender } = render(<LayerPlanCanvas plan={undefined} />);
    expect(screen.getByText('Plan not available')).toBeTruthy();

    rerender(<LayerPlanCanvas plan={null} />);
    expect(screen.getByText('Plan not available')).toBeTruthy();
  });

  it('correctly identifies block name on hover using exact palette index resolution', () => {
    const multiBlockPlan: LayerPlan = {
      size: { x: 5, y: 5, z: 5 },
      voxels: new Uint16Array(125),
      paletteColors: new Uint8Array([0, 0, 0, 100, 100, 100, 150, 100, 50]),
      palette: ['minecraft:air', 'minecraft:stone', 'minecraft:oak_stairs[facing=north]'],
      footprint: { x0: 0, z0: 0, x1: 4, z1: 4 },
      layer: 1,
      placed: [
        { x: 1, z: 1, paletteIndex: 1 },
        { x: 2, z: 2, paletteIndex: 2 },
      ],
      earlier: [],
    };

    const multiBlockStep: BuildStep = {
      index: 1,
      layer: 1,
      title: 'Foundation & Stairs',
      parts: [],
      blocks: [
        { x: 1, y: 1, z: 1, paletteIndex: 1 },
        { x: 2, y: 1, z: 2, paletteIndex: 2 },
      ],
      materials: [],
      callouts: [
        {
          block: 'minecraft:stone',
          baseId: 'minecraft:stone',
          displayName: 'Stone',
          count: 1,
          states: {},
        },
        {
          block: 'minecraft:oak_stairs[facing=north]',
          baseId: 'minecraft:oak_stairs',
          displayName: 'Oak Stairs',
          count: 1,
          states: { facing: 'north' },
        },
      ],
      orientation: 'SE',
    };

    render(<LayerPlanCanvas plan={multiBlockPlan} step={multiBlockStep} />);
    const canvas = screen.getByLabelText('Layer plan for layer y = 1');

    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 158,
      bottom: 150,
      width: 158,
      height: 150,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // Hover over cell (1, 1): Stone
    fireEvent.mouseMove(canvas, { clientX: 68, clientY: 60 });
    expect(screen.getByText('Stone')).toBeTruthy();

    // Hover over cell (2, 2): Oak Stairs
    fireEvent.mouseMove(canvas, { clientX: 92, clientY: 84 });
    expect(screen.getByText('Oak Stairs')).toBeTruthy();
  });
});
