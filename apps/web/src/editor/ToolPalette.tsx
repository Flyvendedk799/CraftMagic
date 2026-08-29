/**
 * Tool palette.
 *
 * Presentation only — it holds no editing state and reaches for no grid. The page owns the
 * active tool and hands the result of a canvas click to the matching pure tool, which is
 * what keeps the tools testable without a DOM and the palette re-orderable without touching
 * any of them.
 *
 * The controls under the tool row are per-tool on purpose. A brush size beside the box tool
 * or a clipboard beside the fill tool would be four more things to read past every time,
 * and the panel is already the tallest thing on screen.
 */

import type { BlockRef } from '@craftmagic/core';
import { BlockPicker } from './BlockPicker.js';
import { RegionPanel, type RegionAction } from './RegionPanel.js';
import type { BoxCorner } from './tools/boxSelect.js';
import { MAX_BRUSH_RADIUS, type BrushShape } from './tools/brush.js';
import type { Clip, StampMode } from './tools/clipboard.js';
import { TOOL_BY_ID, TOOLS, type ToolId } from './toolset.js';

export type { ToolId } from './toolset.js';
export type { RegionAction } from './RegionPanel.js';


const STAMP_MODES: readonly { id: StampMode; label: string; title: string }[] = [
  { id: 'merge', label: 'Merge', title: 'Empty cells in the clipboard leave the build alone' },
  { id: 'replace', label: 'Replace', title: 'Paste the region exactly, holes and all' },
];

export interface ToolPaletteProps {
  tool: ToolId;
  onTool: (tool: ToolId) => void;
  block: BlockRef;
  onBlock: (block: BlockRef) => void;

  /** The box that is standing, once both corners are down. */
  region: { min: BoxCorner; max: BoxCorner } | null;
  regionFilled: number;
  onRegionAction: (action: RegionAction) => void;
  onRegionNudge: (dx: number, dy: number, dz: number) => void;
  onRegionResize: (by: number) => void;
  onDeselectRegion: () => void;
  /** First corner of a box or line in progress, if any. */
  anchor: BoxCorner | null;
  onClearAnchor: () => void;

  familyMode: boolean;
  onFamilyMode: (on: boolean) => void;

  brushRadius: number;
  brushShape: BrushShape;
  onBrushRadius: (radius: number) => void;
  onBrushShape: (shape: BrushShape) => void;

  clip: Clip | null;
  stampMode: StampMode;
  onStampMode: (mode: StampMode) => void;
  onRotateClip: () => void;
  onMirrorClip: () => void;
  onForgetClip: () => void;

  edits: number;
  detached: boolean;
  /** Edits whose coordinates fall outside the current size — invisible until it grows back. */
  outside: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDiscard: () => void;

  /** Result of the last tool run — cell counts, cap warnings. */
  notice: string | null;
  onShowHelp: () => void;
}

export function ToolPalette(props: ToolPaletteProps) {
  const spec = TOOL_BY_ID[props.tool] ?? TOOLS[0]!;
  const brushSpan = props.brushRadius * 2 + 1;

  return (
    <div className="tools">

      <div className="tools__row">
        {TOOLS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="tools__tool"
            // A stable hook for the headless drivers. They used to match on the button's text,
            // which broke the moment the shortcut digit was added inside it.
            data-tool={entry.id}
            aria-pressed={props.tool === entry.id}
            title={`${entry.hint}  (${entry.key})`}
            onClick={() => props.onTool(entry.id)}
          >
            {entry.label}
            <span className="tools__key" aria-hidden="true">
              {entry.key}
            </span>
          </button>
        ))}
      </div>

      <p className="tools__hint">
        {spec.hint}{' '}
        <button type="button" className="tools__inline" onClick={props.onShowHelp}>
          shortcuts
        </button>
      </p>

      {spec.usesBrush && (
        <div className="tools__row tools__row--brush">
          <span className="tools__label">Brush</span>
          <button
            type="button"
            className="tools__step"
            title="Smaller brush  (−)"
            aria-label="Smaller brush"
            disabled={props.brushRadius === 0}
            onClick={() => props.onBrushRadius(props.brushRadius - 1)}
          >
            −
          </button>
          <span className="tools__brush-size">
            {brushSpan}×{brushSpan}
          </span>
          <button
            type="button"
            className="tools__step"
            title="Larger brush  (+)"
            aria-label="Larger brush"
            disabled={props.brushRadius >= MAX_BRUSH_RADIUS}
            onClick={() => props.onBrushRadius(props.brushRadius + 1)}
          >
            +
          </button>
          <button
            type="button"
            className="tools__shape"
            title="Round or square brush  (B)"
            onClick={() => props.onBrushShape(props.brushShape === 'ball' ? 'cube' : 'ball')}
          >
            {props.brushShape === 'ball' ? '● Round' : '■ Square'}
          </button>
        </div>
      )}

      {spec.needsBlock && <BlockPicker value={props.block} onChange={props.onBlock} />}

      {props.tool === 'select' && (
        <RegionPanel
          region={props.region}
          anchor={props.anchor}
          onCancelAnchor={props.onClearAnchor}
          onAction={props.onRegionAction}
          onNudge={props.onRegionNudge}
          onResize={props.onRegionResize}
          onDeselect={props.onDeselectRegion}
          filled={props.regionFilled}
        />
      )}

      {props.tool === 'line' && props.anchor && (
        <p className="tools__hint">
          Start at {props.anchor.x}, {props.anchor.y}, {props.anchor.z} —{' '}
          <button type="button" className="tools__inline" onClick={props.onClearAnchor}>
            cancel
          </button>
        </p>
      )}

      {props.tool === 'stamp' && (
        <div className="clip">
          {props.clip ? (
            <>
              <p className="clip__what">
                {props.clip.size.x}×{props.clip.size.y}×{props.clip.size.z} ·{' '}
                {props.clip.blocks.toLocaleString()} block{props.clip.blocks === 1 ? '' : 's'}
              </p>
              <div className="tools__row tools__row--modes">
                {STAMP_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    className="tools__mode"
                    aria-pressed={props.stampMode === mode.id}
                    title={mode.title}
                    onClick={() => props.onStampMode(mode.id)}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              <div className="tools__row tools__row--clip">
                <button type="button" onClick={props.onRotateClip} title="Rotate 90°  (R)">
                  ⟳ Rotate
                </button>
                <button type="button" onClick={props.onMirrorClip} title="Mirror  (M)">
                  ⇄ Mirror
                </button>
                <button type="button" onClick={props.onForgetClip} title="Empty the clipboard">
                  Forget
                </button>
              </div>
            </>
          ) : (
            <p className="clip__what clip__what--empty">
              Nothing copied yet. Switch to Box, choose Copy, and click two corners.
            </p>
          )}
        </div>
      )}

      {props.tool === 'swap' && (
        <label className="tools__check">
          <input
            type="checkbox"
            checked={props.familyMode}
            onChange={(event) => props.onFamilyMode(event.target.checked)}
          />
          <span>Re-skin the whole family (every oak block → the chosen block&apos;s wood)</span>
        </label>
      )}

      <div className="tools__row tools__row--history">
        <button type="button" onClick={props.onUndo} disabled={!props.canUndo} title="Ctrl+Z">
          ↶ Undo
        </button>
        <button
          type="button"
          onClick={props.onRedo}
          disabled={!props.canRedo}
          title="Ctrl+Shift+Z"
        >
          ↷ Redo
        </button>
        <span className="tools__count" data-modified={props.detached}>
          {props.edits} edit{props.edits === 1 ? '' : 's'}
        </span>
      </div>

      {props.detached && (
        <p className="tools__detached">
          Hand edits ride over the program — sliders, resize and refine keep them.
          {props.outside > 0 &&
            ` ${props.outside} sit${props.outside === 1 ? 's' : ''} outside the current size.`}{' '}
          <button type="button" className="tools__inline" onClick={props.onDiscard}>
            clear edits
          </button>
        </p>
      )}

      {props.notice && <p className="tools__notice">{props.notice}</p>}
    </div>
  );
}
