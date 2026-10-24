// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BlockGlyph, formatStatePills } from './BlockGlyph.js';

afterEach(() => {
  cleanup();
});

describe('formatStatePills', () => {
  it('formats stairs states: facing, half, and shape', () => {
    expect(
      formatStatePills('stairs', { facing: 'north', half: 'bottom', shape: 'straight' }),
    ).toEqual(['North', 'Upright']);

    expect(formatStatePills('stairs', { facing: 'south', half: 'top', shape: 'inner_left' })).toEqual([
      'South',
      'Inverted',
      'Inner L',
    ]);
  });

  it('formats slab states: type', () => {
    expect(formatStatePills('slab', { type: 'top' })).toEqual(['Top slab']);
    expect(formatStatePills('slab', { type: 'bottom' })).toEqual(['Bottom slab']);
    expect(formatStatePills('slab', { type: 'double' })).toEqual(['Double slab']);
  });

  it('formats pillar / log states: axis', () => {
    expect(formatStatePills('pillar', { axis: 'y' })).toEqual(['Axis: Y']);
    expect(formatStatePills('pillar', { axis: 'x' })).toEqual(['Axis: X']);
    expect(formatStatePills('pillar', { axis: 'z' })).toEqual(['Axis: Z']);
  });

  it('formats trapdoor states: open, half, facing', () => {
    expect(
      formatStatePills('trapdoor', { open: 'true', half: 'top', facing: 'east' }),
    ).toEqual(['East', 'Top', 'Open']);

    expect(
      formatStatePills('trapdoor', { open: 'false', half: 'bottom' }),
    ).toEqual(['Bottom', 'Closed']);
  });

  it('formats door states: open, hinge, facing', () => {
    expect(
      formatStatePills('door', { open: 'true', hinge: 'left', facing: 'west' }),
    ).toEqual(['West', 'Left hinge', 'Open']);
  });

  it('formats general states omitting default or empty', () => {
    expect(formatStatePills('general', { facing: 'north' })).toEqual(['North']);
    expect(formatStatePills('general', {})).toEqual([]);
  });
});

describe('BlockGlyph component', () => {
  it('renders SVG with accessible role="img" and descriptive aria-label', () => {
    render(
      <BlockGlyph
        glyphType="stairs"
        states={{ facing: 'north', half: 'bottom' }}
      />,
    );
    const svg = screen.getByRole('img');
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('aria-label')).toBe('Stairs (North, Upright)');
  });

  it('renders general cube glyph when glyphType is general', () => {
    render(<BlockGlyph glyphType="general" states={{}} />);
    const svg = screen.getByRole('img');
    expect(svg.getAttribute('aria-label')).toBe('General');
  });

  it('renders slab glyph with orientation path', () => {
    render(<BlockGlyph glyphType="slab" states={{ type: 'top' }} />);
    const svg = screen.getByRole('img');
    expect(svg.getAttribute('aria-label')).toBe('Slab (Top slab)');
  });

  it('renders pillar with axis indicator', () => {
    render(<BlockGlyph glyphType="pillar" states={{ axis: 'y' }} />);
    const svg = screen.getByRole('img');
    expect(svg.getAttribute('aria-label')).toBe('Pillar (Axis: Y)');
  });
});
