// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildStep } from '@craftmagic/core';
import { CalloutTray } from './CalloutTray.js';

afterEach(() => {
  cleanup();
});

describe('CalloutTray component', () => {
  it('returns null when step has no callouts', () => {
    const step: BuildStep = {
      index: 1,
      layer: 0,
      title: 'Foundation',
      parts: [],
      blocks: [],
      materials: [],
      callouts: [],
      orientation: 'SE',
    };
    const { container } = render(<CalloutTray step={step} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders callout items with counts, display names, and pills', () => {
    const step: BuildStep = {
      index: 1,
      layer: 0,
      title: 'Walls',
      parts: [],
      blocks: [],
      materials: [],
      orientation: 'SE',
      callouts: [
        {
          block: 'minecraft:oak_stairs[facing=north,half=bottom]',
          baseId: 'minecraft:oak_stairs',
          displayName: 'Oak Stairs',
          count: 4,
          states: { facing: 'north', half: 'bottom' },
          glyphType: 'stairs',
        },
        {
          block: 'minecraft:smooth_stone_slab[type=bottom]',
          baseId: 'minecraft:smooth_stone_slab',
          displayName: 'Smooth Stone Slab',
          count: 8,
          states: { type: 'bottom' },
          glyphType: 'slab',
        },
      ],
    };

    render(<CalloutTray step={step} />);

    expect(screen.getByText('PARTS FOR THIS STEP')).toBeTruthy();
    expect(screen.getByText('12 pieces')).toBeTruthy();

    expect(screen.getByText('4×')).toBeTruthy();
    expect(screen.getByText('Oak Stairs')).toBeTruthy();
    expect(screen.getByText('North')).toBeTruthy();
    expect(screen.getByText('Upright')).toBeTruthy();

    expect(screen.getByText('8×')).toBeTruthy();
    expect(screen.getByText('Smooth Stone Slab')).toBeTruthy();
    expect(screen.getByText('Bottom slab')).toBeTruthy();
  });
});
