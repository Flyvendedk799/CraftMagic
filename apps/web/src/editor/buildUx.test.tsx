// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolPalette, type ToolPaletteProps } from './ToolPalette.js';
import { ViewportStatus } from './ViewportStatus.js';
import { InspectorLayers } from './InspectorLayers.js';
import { LayersHud } from './LayersHud.js';
import type { BlockRef } from '@craftmagic/core';

afterEach(() => {
  cleanup();
});

function createMockProps(overrides?: Partial<ToolPaletteProps>): ToolPaletteProps {
  return {
    tool: 'place',
    onTool: vi.fn(),
    block: 'minecraft:oak_planks' as BlockRef,
    onBlock: vi.fn(),
    region: null,
    regionFilled: 0,
    onRegionAction: vi.fn(),
    onRegionNudge: vi.fn(),
    onRegionResize: vi.fn(),
    onDeselectRegion: vi.fn(),
    anchor: null,
    onClearAnchor: vi.fn(),
    familyMode: false,
    onFamilyMode: vi.fn(),
    brushRadius: 1,
    brushShape: 'ball',
    symmetry: false,
    onSymmetry: vi.fn(),
    onBrushRadius: vi.fn(),
    onBrushShape: vi.fn(),
    clip: null,
    stampMode: 'merge',
    onStampMode: vi.fn(),
    onRotateClip: vi.fn(),
    onMirrorClip: vi.fn(),
    onForgetClip: vi.fn(),
    edits: 3,
    detached: false,
    outside: 0,
    canUndo: true,
    canRedo: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onDiscard: vi.fn(),
    notice: null,
    onShowHelp: vi.fn(),
    ...overrides,
  };
}

describe('Build Mode UI/UX Streamlining - ToolPalette & Docks (C1)', () => {
  it('renders clean visual hierarchy with primary tools section, brush controls, and history', () => {
    const props = createMockProps({ tool: 'place' });
    const { container } = render(<ToolPalette {...props} />);

    // Visual hierarchy sections
    expect(container.querySelector('.tools__section--primary')).not.toBeNull();
    expect(container.querySelector('.tools__section--brush-controls')).not.toBeNull();
    expect(container.querySelector('.tools__section--material')).not.toBeNull();
    expect(container.querySelector('.tools__section--history')).not.toBeNull();

    // Section titles
    const titles = Array.from(container.querySelectorAll('.tools__section-title')).map(
      (el) => el.textContent,
    );
    expect(titles).toContain('Tools');
    expect(titles).toContain('Brush & Modifiers');
    expect(titles).toContain('Material Selection');
    expect(titles).toContain('History & Edits');
  });

  it('renders tool buttons with shortcuts and handles tool selection', () => {
    const onTool = vi.fn();
    const props = createMockProps({ onTool });
    const { container } = render(<ToolPalette {...props} />);

    const eraseBtn = container.querySelector('button[data-tool="erase"]')!;
    expect(eraseBtn).not.toBeNull();
    fireEvent.click(eraseBtn);
    expect(onTool).toHaveBeenCalledWith('erase');
  });

  it('renders brush size and shape controls for brush tool and handles user interaction', () => {
    const onBrushRadius = vi.fn();
    const onBrushShape = vi.fn();
    const props = createMockProps({
      tool: 'place',
      brushRadius: 2,
      brushShape: 'ball',
      onBrushRadius,
      onBrushShape,
    });
    render(<ToolPalette {...props} />);

    // Brush span for radius 2 is 2*2 + 1 = 5
    expect(screen.getByText('5×5')).not.toBeNull();

    // Decrement radius
    const decBtn = screen.getByRole('button', { name: 'Smaller brush' });
    fireEvent.click(decBtn);
    expect(onBrushRadius).toHaveBeenCalledWith(1);

    // Increment radius
    const incBtn = screen.getByRole('button', { name: 'Larger brush' });
    fireEvent.click(incBtn);
    expect(onBrushRadius).toHaveBeenCalledWith(3);

    // Toggle shape between ball and cube
    const shapeBtn = screen.getByRole('button', { name: /Round/i });
    fireEvent.click(shapeBtn);
    expect(onBrushShape).toHaveBeenCalledWith('cube');
  });

  it('does not render inaccurate single-voxel fallback note on non-brush tools (Fill, Swap, Box, Stamp)', () => {
    for (const tool of ['fill', 'swap', 'select', 'stamp'] as const) {
      const props = createMockProps({ tool });
      const { container } = render(<ToolPalette {...props} />);
      expect(container.querySelector('.tools__meta-note')).toBeNull();
      cleanup();
    }
  });

  it('does not render empty Shapes & Selection section when line tool has no anchor', () => {
    const props = createMockProps({ tool: 'line', anchor: null });
    const { container } = render(<ToolPalette {...props} />);

    expect(container.querySelector('.tools__section--shapes')).toBeNull();
    expect(screen.queryByText('Shapes & Selection')).toBeNull();
  });

  it('renders Shapes & Selection section when line tool has an anchor and allows canceling', () => {
    const onClearAnchor = vi.fn();
    const props = createMockProps({
      tool: 'line',
      anchor: { x: 5, y: 10, z: 15 },
      onClearAnchor,
    });
    const { container } = render(<ToolPalette {...props} />);

    expect(container.querySelector('.tools__section--shapes')).not.toBeNull();
    expect(screen.getByText('Shapes & Selection')).not.toBeNull();
    expect(screen.getByText(/Start at 5, 10, 15/)).not.toBeNull();

    const cancelBtn = screen.getByRole('button', { name: 'cancel' });
    fireEvent.click(cancelBtn);
    expect(onClearAnchor).toHaveBeenCalled();
  });

  it('renders symmetry toggle button and triggers callback', () => {
    const onSymmetry = vi.fn();
    const props = createMockProps({ symmetry: false, onSymmetry });
    render(<ToolPalette {...props} />);

    const symmetryBtn = screen.getByRole('button', { name: /⇋ Symmetry off/i });
    expect(symmetryBtn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(symmetryBtn);
    expect(onSymmetry).toHaveBeenCalledWith(true);
  });

  it('renders Shapes & Selection section when tool is select or region is active', () => {
    const props = createMockProps({
      tool: 'select',
      region: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 3, y: 3, z: 3 },
      },
      regionFilled: 64,
    });
    const { container } = render(<ToolPalette {...props} />);

    expect(container.querySelector('.tools__section--shapes')).not.toBeNull();
    expect(screen.getByText('Shapes & Selection')).not.toBeNull();
  });

  it('renders clipboard stamp controls in Shapes & Selection when tool is stamp', () => {
    const onStampMode = vi.fn();
    const onRotateClip = vi.fn();
    const props = createMockProps({
      tool: 'stamp',
      clip: {
        size: { x: 2, y: 2, z: 2 },
        blocks: 8,
        palette: ['minecraft:stone'],
        voxels: new Uint16Array(8),
      },
      stampMode: 'merge',
      onStampMode,
      onRotateClip,
    });
    render(<ToolPalette {...props} />);

    expect(screen.getByText('Shapes & Selection')).not.toBeNull();
    const replaceBtn = screen.getByRole('button', { name: 'Replace' });
    fireEvent.click(replaceBtn);
    expect(onStampMode).toHaveBeenCalledWith('replace');

    const rotateBtn = screen.getByRole('button', { name: /Rotate/i });
    fireEvent.click(rotateBtn);
    expect(onRotateClip).toHaveBeenCalled();
  });

  it('renders Material Selection BlockPicker only for tools that need blocks', () => {
    // 'place' needs block
    const placeProps = createMockProps({ tool: 'place' });
    const { container: c1 } = render(<ToolPalette {...placeProps} />);
    expect(c1.querySelector('.tools__section--material')).not.toBeNull();

    cleanup();

    // 'erase' does not need block
    const eraseProps = createMockProps({ tool: 'erase' });
    const { container: c2 } = render(<ToolPalette {...eraseProps} />);
    expect(c2.querySelector('.tools__section--material')).toBeNull();
  });

  it('renders History & Edits with undo, redo, and edit counter', () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const props = createMockProps({
      canUndo: true,
      canRedo: true,
      edits: 5,
      onUndo,
      onRedo,
    });
    render(<ToolPalette {...props} />);

    expect(screen.getByText('5 edits')).not.toBeNull();

    const undoBtn = screen.getByRole('button', { name: /Undo/i });
    fireEvent.click(undoBtn);
    expect(onUndo).toHaveBeenCalled();

    const redoBtn = screen.getByRole('button', { name: /Redo/i });
    fireEvent.click(redoBtn);
    expect(onRedo).toHaveBeenCalled();
  });
});

describe('Build Mode Viewport HUD & Layer Feedback (C1/C2)', () => {
  it('displays active tool, active block swatch, brush badge, symmetry, and layer feedback in production ViewportStatus', () => {
    const { container } = render(
      <ViewportStatus
        tool="place"
        block={'minecraft:oak_planks' as BlockRef}
        brushRadius={1}
        brushShape="ball"
        symmetry={true}
        layer={null}
        isolate={false}
        topLayer={15}
      />,
    );

    const hud = screen.getByRole('status', { name: 'Active tool and layer feedback' });
    expect(hud).not.toBeNull();
    expect(screen.getByText('Place')).not.toBeNull();
    expect(screen.getByText('4')).not.toBeNull();
    expect(screen.getByText('Oak Planks')).not.toBeNull();
    expect(screen.getByText('3×3 ●')).not.toBeNull();
    expect(screen.getByText('⇋ Symmetry')).not.toBeNull();
    expect(screen.getByText('All layers (y 0–15)')).not.toBeNull();

    const swatch = screen.getByTestId('block-swatch');
    expect(swatch).not.toBeNull();
    expect(container.querySelector('.viewport-status__item--tool')).not.toBeNull();
    expect(container.querySelector('.viewport-status__item--block')).not.toBeNull();
    expect(container.querySelector('.viewport-status__item--brush')).not.toBeNull();
    expect(container.querySelector('.viewport-status__item--symmetry')).not.toBeNull();
    expect(container.querySelector('.viewport-status__item--layer')).not.toBeNull();
  });

  it('provides distinct visual indicator when a layer is isolated in production ViewportStatus', () => {
    render(
      <ViewportStatus
        tool="erase"
        block={'minecraft:stone' as BlockRef}
        brushRadius={0}
        brushShape="cube"
        symmetry={false}
        layer={5}
        isolate={true}
        topLayer={20}
      />,
    );

    const layerPill = screen.getByText('Layer y 5 (isolated)');
    expect(layerPill.getAttribute('data-isolated')).toBe('true');
    // 'erase' does not need block
    expect(screen.queryByTestId('block-swatch')).toBeNull();
  });

  it('renders production LayersHud with slice controls and camera framing groups, wiring callbacks correctly', () => {
    const onUpdate = vi.fn();
    const onSetView = vi.fn();
    const onToggleOrtho = vi.fn();
    const onToggleEnhanced = vi.fn();
    const onTakeScreenshot = vi.fn();

    const { container } = render(
      <LayersHud
        layer={8}
        topLayer={20}
        isolate={false}
        ortho={false}
        enhanced={false}
        onUpdate={onUpdate}
        onSetView={onSetView}
        onToggleOrtho={onToggleOrtho}
        onToggleEnhanced={onToggleEnhanced}
        onTakeScreenshot={onTakeScreenshot}
      />,
    );

    expect(container.querySelector('.layers__slice-controls')).not.toBeNull();
    expect(container.querySelector('.layers__views')).not.toBeNull();
    expect(screen.getByText('y 0–8')).not.toBeNull();

    // Slider change
    const slider = screen.getByLabelText('Highest visible layer');
    fireEvent.change(slider, { target: { value: '12' } });
    expect(onUpdate).toHaveBeenCalledWith({ layer: 12 });

    // Isolate button
    fireEvent.click(screen.getByRole('button', { name: 'Isolate' }));
    expect(onUpdate).toHaveBeenCalledWith({ toggleIsolate: true });

    // Show all button
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(onUpdate).toHaveBeenCalledWith({ layer: null });

    // Camera view buttons
    fireEvent.click(screen.getByRole('button', { name: 'Iso' }));
    expect(onSetView).toHaveBeenCalledWith('iso');

    fireEvent.click(screen.getByRole('button', { name: 'Top' }));
    expect(onSetView).toHaveBeenCalledWith('top');

    // Ortho toggle
    fireEvent.click(screen.getByRole('button', { name: 'Ortho' }));
    expect(onToggleOrtho).toHaveBeenCalled();

    // Enhanced toggle
    fireEvent.click(screen.getByRole('button', { name: '✨' }));
    expect(onToggleEnhanced).toHaveBeenCalled();

    // Screenshot button
    fireEvent.click(screen.getByRole('button', { name: '📷' }));
    expect(onTakeScreenshot).toHaveBeenCalled();
  });

  it('renders production InspectorLayers in the right inspector dock and wires update callbacks', () => {
    const onUpdate = vi.fn();
    render(
      <InspectorLayers
        layer={5}
        isolate={true}
        topLayer={15}
        onUpdate={onUpdate}
      />,
    );

    expect(screen.getByText('Layer Slice')).not.toBeNull();
    expect(screen.getByText('y 5 (isolated)')).not.toBeNull();

    const slider = screen.getByLabelText('Inspector layer slider');
    fireEvent.change(slider, { target: { value: '10' } });
    expect(onUpdate).toHaveBeenCalledWith({ layer: 10 });

    const isolateBtn = screen.getByRole('button', { name: 'Isolate' });
    expect(isolateBtn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(isolateBtn);
    expect(onUpdate).toHaveBeenCalledWith({ toggleIsolate: true });

    const showAllBtn = screen.getByRole('button', { name: 'Show all' });
    fireEvent.click(showAllBtn);
    expect(onUpdate).toHaveBeenCalledWith({ layer: null });
  });
});
