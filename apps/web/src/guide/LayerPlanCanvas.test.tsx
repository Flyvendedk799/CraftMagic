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
});
