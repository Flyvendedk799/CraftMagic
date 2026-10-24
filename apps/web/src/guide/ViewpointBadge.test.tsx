// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ViewpointBadge } from './ViewpointBadge.js';

afterEach(() => {
  cleanup();
});

describe('ViewpointBadge component', () => {
  it('renders standard orientation badge', () => {
    render(<ViewpointBadge orientation="SE" isFlipped={false} />);
    const badge = screen.getByRole('status');
    expect(badge.textContent).toBe('South-East');
    expect(badge.className).toContain('viewpoint-badge');
    expect(badge.className).not.toContain('viewpoint-badge--flipped');
  });

  it('renders flipped badge with flip icon and flipped modifier class', () => {
    render(<ViewpointBadge orientation="NW" isFlipped={true} />);
    const badge = screen.getByRole('status');
    expect(badge.textContent).toBe('North-West (Flipped)');
    expect(badge.className).toContain('viewpoint-badge--flipped');
  });
});
