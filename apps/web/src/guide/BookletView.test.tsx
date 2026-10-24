// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { BuildGuide, BuildStep } from '@craftmagic/core';
import type { LoadedBuild } from '../editor/builds.js';
import { BookletView } from './BookletView.js';
import type { LayerPlan } from './layerGrid.js';

afterEach(() => {
  cleanup();
});

describe('BookletView component', () => {
  const sampleSteps: BuildStep[] = [
    {
      index: 1,
      layer: 0,
      title: 'Foundation Cobblestone',
      parts: [{ id: 1, label: 'Foundation', blocks: 2 }],
      blocks: [
        { x: 0, y: 0, z: 0, paletteIndex: 1 },
        { x: 1, y: 0, z: 0, paletteIndex: 1 },
      ],
      materials: [
        { block: 'minecraft:cobblestone', displayName: 'Cobblestone', count: 2, stacks: 0, remainder: 2 },
      ],
      callouts: [],
      orientation: 'SE',
      isFlipped: false,
    },
    {
      index: 2,
      layer: 1,
      title: 'Oak Walls',
      parts: [{ id: 2, label: 'Walls', blocks: 1 }],
      blocks: [{ x: 0, y: 1, z: 0, paletteIndex: 2 }],
      materials: [
        { block: 'minecraft:oak_planks', displayName: 'Oak Planks', count: 1, stacks: 0, remainder: 1 },
      ],
      callouts: [],
      orientation: 'SW',
      isFlipped: true,
    },
  ];

  const sampleGuide: BuildGuide = {
    name: 'Sample Fortress',
    size: { x: 5, y: 5, z: 5 },
    totalBlocks: 3,
    steps: sampleSteps,
    materials: [
      { block: 'minecraft:cobblestone', displayName: 'Cobblestone', count: 2, stacks: 0, remainder: 2 },
      { block: 'minecraft:oak_planks', displayName: 'Oak Planks', count: 1, stacks: 0, remainder: 1 },
    ],
    parts: [
      { id: 1, label: 'Foundation', blocks: 2, min: [0, 0, 0], max: [1, 0, 0], type: 'box', path: 'components[0]' },
      { id: 2, label: 'Walls', blocks: 1, min: [0, 1, 0], max: [0, 1, 0], type: 'box', path: 'components[1]' },
    ],
    difficulty: 'simple',
    design: {
      name: 'Default',
      step: { maxBlocks: 40, minBlocks: 4, splitByPart: true },
      stackSize: 64,
      difficulty: [{ upTo: 10, label: 'simple' }, { upTo: Infinity, label: 'epic' }],
      roleLabels: {},
      typeLabels: {} as never,
      anonymousStep: 'Layer {layer}',
      edgeThreshold: 0.33,
    },
  };

  const samplePlan: LayerPlan = {
    size: { x: 5, y: 5, z: 5 },
    voxels: new Uint16Array(125),
    paletteColors: new Uint8Array([0, 0, 0, 100, 100, 100, 150, 100, 50]),
    footprint: { x0: 0, z0: 0, x1: 4, z1: 4 },
    layer: 0,
    placed: [{ x: 0, z: 0, paletteIndex: 1 }],
    earlier: [],
  };

  const sampleBuild: LoadedBuild = {
    id: 'sample-fortress',
    name: 'Sample Fortress',
    program: null,
    description: 'Sample description',
    grid: {
      size: { x: 5, y: 5, z: 5 },
      voxels: new Uint16Array(125),
      palette: ['minecraft:air', 'minecraft:cobblestone', 'minecraft:oak_planks'],
    },
    paletteColors: new Uint8Array([0, 0, 0, 100, 100, 100, 150, 100, 50]),
    paletteFlags: new Uint8Array(3),
    blockCount: 3,
    params: [],
    warnings: [],
    errors: [],
    parts: [],
    origin: null,
  };

  it('renders cover, parts, materials, and step sheets with running headers', () => {
    render(
      <MemoryRouter initialEntries={['/guide?build=sample-fortress&mode=booklet']}>
        <BookletView
          build={sampleBuild}
          guide={sampleGuide}
          plans={[samplePlan, samplePlan]}
          filmShots={['data:image/png;base64,123', 'data:image/png;base64,456']}
        />
      </MemoryRouter>,
    );

    // Running headers check
    const headers = screen.getAllByText(/CRAFTMAGIC MANUAL · Sample Fortress · Volume 1/);
    expect(headers.length).toBeGreaterThan(0);

    // Front matter check
    expect(screen.getByText('What you are building')).toBeTruthy();
    expect(screen.getByText('Bill of materials')).toBeTruthy();

    // Step cards check
    expect(screen.getByText('Foundation Cobblestone')).toBeTruthy();
    expect(screen.getByText('Oak Walls')).toBeTruthy();

    // Density selector
    const oneUpBtn = screen.getByRole('button', { name: '1-up' });
    const twoUpBtn = screen.getByRole('button', { name: '2-up' });
    const fourUpBtn = screen.getByRole('button', { name: '4-up' });
    expect(oneUpBtn).toBeTruthy();
    expect(twoUpBtn).toBeTruthy();
    expect(fourUpBtn).toBeTruthy();

    // Click 1-up density and check page count updates
    fireEvent.click(oneUpBtn);
    expect(screen.getByText('5 Pages')).toBeTruthy();
  });
});
