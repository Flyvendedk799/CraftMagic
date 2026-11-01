// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorld } from '@craftmagic/core';
import { TerrainPanel, type TerrainPanelProps } from './TerrainPanel.js';
import type { WorldTool } from './toolset.js';

afterEach(() => {
  cleanup();
});

function material(label: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Ground material' })).getByRole('button', {
    name: new RegExp(label),
  });
}

function setup(tool: WorldTool, overrides: Partial<TerrainPanelProps> = {}) {
  const settings = createWorld().settings;
  const onTool = vi.fn();
  const onStratum = vi.fn();
  render(
    <TerrainPanel
      settings={settings}
      tool={tool}
      onTool={onTool}
      brush={{ radius: 12, strength: 4, falloff: 'smooth' }}
      onBrush={vi.fn()}
      stratum={0}
      onStratum={onStratum}
      targetY={settings.seaLevel}
      onTargetY={vi.fn()}
      onShowHelp={vi.fn()}
      {...overrides}
    />,
  );
  return { settings, onTool, onStratum };
}

describe('TerrainPanel ground materials', () => {
  it('keeps the Ground section visible when a non-paint tool is active', () => {
    const { settings } = setup('raise');
    const group = screen.getByRole('group', { name: 'Ground material' });
    expect(group.querySelectorAll('button')).toHaveLength(settings.strata.length);
  });

  it('selects the material and switches to Paint when another tool is active', () => {
    const { settings, onTool, onStratum } = setup('raise');
    const index = settings.strata.length - 1;
    fireEvent.click(material(settings.strata[index]!.label));
    expect(onStratum).toHaveBeenCalledWith(index);
    expect(onTool).toHaveBeenCalledWith('paint');
  });

  it('selects the material without re-selecting the tool when Paint is already active', () => {
    const { settings, onTool, onStratum } = setup('paint');
    fireEvent.click(material(settings.strata[0]!.label));
    expect(onStratum).toHaveBeenCalledWith(0);
    expect(onTool).not.toHaveBeenCalled();
  });
});
