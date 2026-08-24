/**
 * Tool palette.
 *
 * Presentation only — it holds no editing state and reaches for no grid. The page owns the
 * active tool and hands the result of a canvas click to the matching pure tool, which is
 * what keeps the tools testable without a DOM and the palette re-orderable without touching
 * any of them.
 */

import type { BlockRef } from '@craftmagic/core';
import { BlockPicker } from './BlockPicker.js';
import type { BoxCorner, BoxMode } from './tools/boxSelect.js';

export type ToolId = 'place' | 'erase' | 'fill' | 'select' | 'swap';

interface ToolSpec {
  id: ToolId;
  label: string;
  /** What a click does — the palette is not self-explanatory and a legend is cheaper than guessing. */
  hint: string;
  /** Erase needs no block; showing the picker for it would imply otherwise. */
  needsBlock: boolean;
  /** Number key that selects it. Shown on the button, because an unadvertised shortcut is none. */
  key: string;
}

const TOOLS: readonly ToolSpec[] = [
  { id: 'place', label: 'Place', hint: 'Click a face to add a block against it.', needsBlock: true, key: '1' },
  { id: 'erase', label: 'Erase', hint: 'Click a block to remove it.', needsBlock: false, key: '2' },
  {
    id: 'fill',
    label: 'Fill',
    hint: 'Click to repaint every connected block of the same kind.',
    needsBlock: true,
    key: '3',
  },
  { id: 'select', label: 'Box', hint: 'Click two opposite corners.', needsBlock: true, key: '4' },
  {
    id: 'swap',
    label: 'Swap',
    hint: 'Click a block to replace it everywhere in the build.',
    needsBlock: true,
    key: '5',
  },
];

const BOX_MODES: readonly { id: BoxMode; label: string; title: string }[] = [
  { id: 'fill', label: 'Fill', title: 'Every cell in the box' },
  { id: 'replace', label: 'Replace', title: 'Only cells that already hold a block' },
  { id: 'clear', label: 'Clear', title: 'Empty the box' },
];

export interface ToolPaletteProps {
  tool: ToolId;
  onTool: (tool: ToolId) => void;
  block: BlockRef;
  onBlock: (block: BlockRef) => void;

  boxMode: BoxMode;
  onBoxMode: (mode: BoxMode) => void;
  /** First corner of a box in progress, if any. */
  anchor: BoxCorner | null;
  onClearAnchor: () => void;

  familyMode: boolean;
  onFamilyMode: (on: boolean) => void;

  edits: number;
  detached: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDiscard: () => void;

  /** Result of the last tool run — cell counts, cap warnings. */
  notice: string | null;
}

export function ToolPalette(props: ToolPaletteProps) {
  const spec = TOOLS.find((t) => t.id === props.tool) ?? TOOLS[0]!;

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

      <p className="tools__hint">{spec.hint}</p>

      {spec.needsBlock && <BlockPicker value={props.block} onChange={props.onBlock} />}

      {props.tool === 'select' && (
        <>
          <div className="tools__row tools__row--modes">
            {BOX_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className="tools__mode"
                aria-pressed={props.boxMode === mode.id}
                title={mode.title}
                onClick={() => props.onBoxMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          {props.anchor && (
            <p className="tools__hint">
              Corner at {props.anchor.x}, {props.anchor.y}, {props.anchor.z} —{' '}
              <button type="button" className="tools__inline" onClick={props.onClearAnchor}>
                cancel
              </button>
            </p>
          )}
        </>
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
          Modified — no longer matches the program.{' '}
          <button type="button" className="tools__inline" onClick={props.onDiscard}>
            revert
          </button>
        </p>
      )}

      {props.notice && <p className="tools__notice">{props.notice}</p>}
    </div>
  );
}
