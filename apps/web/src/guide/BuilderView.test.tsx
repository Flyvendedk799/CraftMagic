// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { BuildGuide, BuildStep } from '@craftmagic/core';
import type { LoadedBuild } from '../editor/builds.js';
import {
  BuilderView,
  clearGuideProgress,
  getProgressStorageKey,
  loadGuideProgress,
  saveGuideProgress,
} from './BuilderView.js';
import type { LayerPlan } from './layerGrid.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('BuilderView persistence', () => {
  it('formats progress storage key with prefix', () => {
    expect(getProgressStorageKey('cottage')).toBe('craftmagic:guide:progress:cottage');
  });

  it('saves and loads guide progress correctly', () => {
    saveGuideProgress('cottage', {
      currentStepIndex: 5,
      completedSteps: [1, 2, 3],
    });

    const progress = loadGuideProgress('cottage');
    expect(progress).toEqual({
      currentStepIndex: 5,
      completedSteps: [1, 2, 3],
    });
  });

  it('clears progress from localStorage', () => {
    saveGuideProgress('tower', {
      currentStepIndex: 2,
      completedSteps: [1],
    });
    expect(loadGuideProgress('tower')).not.toBeNull();

    clearGuideProgress('tower');
    expect(loadGuideProgress('tower')).toBeNull();
  });

  it('returns null for missing or invalid progress data', () => {
    expect(loadGuideProgress('nonexistent')).toBeNull();

    localStorage.setItem(getProgressStorageKey('invalid'), 'not-json');
    expect(loadGuideProgress('invalid')).toBeNull();
  });
});

describe('BuilderView component', () => {
  const sampleSteps: BuildStep[] = [
    {
      index: 1,
      layer: 0,
      title: 'Foundation Cobblestone',
      parts: [],
      blocks: [
        { x: 0, y: 0, z: 0, paletteIndex: 1 },
        { x: 1, y: 0, z: 0, paletteIndex: 1 },
      ],
      materials: [],
      callouts: [],
      orientation: 'SE',
      isFlipped: false,
    },
    {
      index: 2,
      layer: 0,
      title: 'Oak Walls',
      parts: [],
      blocks: [{ x: 0, y: 0, z: 1, paletteIndex: 2 }],
      materials: [],
      callouts: [],
      orientation: 'SW',
      isFlipped: true,
    },
  ];

  const sampleGuide: BuildGuide = {
    name: 'Test Cottage',
    size: { x: 5, y: 5, z: 5 },
    totalBlocks: 3,
    steps: sampleSteps,
    materials: [],
    parts: [],
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
    id: 'test-cottage',
    name: 'Test Cottage',
    program: null,
    description: 'Sample description',
    grid: { size: { x: 5, y: 5, z: 5 }, voxels: new Uint16Array(125), palette: ['minecraft:air', 'minecraft:cobblestone', 'minecraft:oak_planks'] },
    paletteColors: new Uint8Array([0, 0, 0, 100, 100, 100, 150, 100, 50]),
    paletteFlags: new Uint8Array(3),
    blockCount: 3,
    params: [],
    warnings: [],
    errors: [],
    parts: [],
    origin: null,
  };

  it('renders step navigation header, stats, and cockpit controls', () => {
    render(
      <MemoryRouter initialEntries={['/guide?build=test-cottage&step=1']}>
        <BuilderView
          buildId="test-cottage"
          build={sampleBuild}
          guide={sampleGuide}
          plans={[samplePlan, samplePlan]}
          filmShots={['data:image/png;base64,123', 'data:image/png;base64,456']}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('STEP 1 OF 2')).toBeTruthy();
    expect(screen.getByText('Foundation Cobblestone')).toBeTruthy();
    expect(screen.getByText('y = 0')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
    expect(screen.getByText(/Next →/)).toBeTruthy();
  });
});
