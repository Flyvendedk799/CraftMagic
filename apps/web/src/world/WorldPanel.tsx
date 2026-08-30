/**
 * The world itself: its name, its extent, and the regions it will be delivered in.
 *
 * The size control is the "smartly customizable" part of the brief, and it is also the one
 * control here that can destroy work. Shrinking a map genuinely discards the columns past the
 * new edge — `resizeWorld` says how many — so the count is shown *before* the button is
 * pressed rather than in a confirmation after it. A dialog that appears once you have already
 * decided is not a safeguard; a number next to the field is.
 *
 * The region list is the honest face of the delivery model. A world does not go into Minecraft
 * in one send: it is cut into region-sized pieces, each of which materialises into an ordinary
 * build, and each of which the bot places at 8,000 blocks a second. Showing the pieces and
 * their block counts is what turns "why is this taking so long" into an estimate the user made
 * themselves.
 */

import { useMemo, useState } from 'react';
import {
  WORLD_LIMITS,
  regionCount,
  regionStats,
  regionsOf,
  resizeWorld,
  type WorldDoc,
} from '@craftmagic/core';
import { Section } from '../editor/Section.js';
import type { SavedWorld } from './storage.js';

export interface WorldPanelProps {
  doc: WorldDoc;
  /** Region stats are an O(columns) walk each; recomputed when this changes, not per render. */
  revision: number;
  saved: SavedWorld[];
  dirty: boolean;
  onRename: (name: string) => void;
  onResize: (size: { x: number; z: number }) => void;
  onSettings: (patch: { seaLevel?: number; minY?: number; maxY?: number; regionSize?: number }) => void;
  onSave: () => void;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onNew: () => void;
  /** Jump the map to a region. */
  onFrameRegion: (rx: number, rz: number) => void;
  onSendRegion: (rx: number, rz: number) => void;
  /** One region at a time: the run is ordered, and a second send would be refused anyway. */
  sending?: boolean;
}

/** Blocks a second the builder bot places — 400 per tick, twenty ticks. Fixed by the mod. */
const BLOCKS_PER_SECOND = 8_000;

export function WorldPanel(props: WorldPanelProps) {
  const { doc, saved, dirty } = props;
  const { settings } = doc;
  const [draftX, setDraftX] = useState(String(settings.size.x));
  const [draftZ, setDraftZ] = useState(String(settings.size.z));

  const wanted = {
    x: clamp(Number(draftX), WORLD_LIMITS.minSize, WORLD_LIMITS.maxSize, settings.size.x),
    z: clamp(Number(draftZ), WORLD_LIMITS.minSize, WORLD_LIMITS.maxSize, settings.size.z),
  };
  const changingSize = wanted.x !== settings.size.x || wanted.z !== settings.size.z;

  /**
   * What a resize would cost, measured rather than guessed.
   *
   * `resizeWorld` is pure and returns the count, so asking it is both the cheapest and the
   * only correct way to know — the arithmetic looks obvious and is wrong for any map that is
   * not square, which is most of them.
   */
  const lost = useMemo(
    () => (changingSize ? resizeWorld(doc, wanted).lost : null),
    // Only the target matters; re-running this on every terrain stroke would clone the map.
    [changingSize, wanted.x, wanted.z, settings.size.x, settings.size.z],
  );

  const counts = regionCount(settings);
  const regions = useMemo(() => regionsOf(settings), [settings]);

  const stats = useMemo(
    () => regions.map((region) => ({ region, stats: regionStats(doc, region.rx, region.rz, region) })),
    [doc, props.revision, regions],
  );

  const totalBlocks = stats.reduce((sum, entry) => sum + entry.stats.blocks, 0);

  return (
    <>
      <Section id="world-doc" title="World" summary={doc.name}>
        <label className="world__field">
          <span className="world__label">Name</span>
          <input value={doc.name} onChange={(event) => props.onRename(event.target.value)} />
        </label>

        <div className="world__row">
          <button type="button" className="world__action" onClick={props.onSave}>
            {dirty ? 'Save world' : 'Saved'}
          </button>
          <button type="button" className="world__mini" onClick={props.onNew}>
            New
          </button>
        </div>

        {saved.length > 0 && (
          <ul className="world__saved">
            {saved.map((entry) => (
              <li key={entry.id}>
                <button type="button" className="world__saved-row" onClick={() => props.onOpen(entry.id)}>
                  <span>{entry.name}</span>
                  <span className="world__saved-size">
                    {entry.sizeX}×{entry.sizeZ}
                  </span>
                </button>
                <button
                  type="button"
                  className="world__mini world__mini--danger"
                  onClick={() => props.onRemove(entry.id)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="world-extent" title="Extent" summary={`${settings.size.x}×${settings.size.z}`}>
        <div className="world__grid2">
          <label className="world__field">
            <span className="world__label">Width (x)</span>
            <input type="number" value={draftX} onChange={(event) => setDraftX(event.target.value)} />
          </label>
          <label className="world__field">
            <span className="world__label">Depth (z)</span>
            <input type="number" value={draftZ} onChange={(event) => setDraftZ(event.target.value)} />
          </label>
        </div>

        <p className="world__hint">
          {(settings.size.x * settings.size.z).toLocaleString()} columns, {' '}
          {((settings.size.x * settings.size.z * 3) / 1_048_576).toFixed(1)} MB of terrain.
        </p>

        {changingSize && (
          <>
            {lost && lost.columns > 0 && (
              <p className="world__warn">
                Shrinking discards {lost.columns.toLocaleString()} columns
                {lost.chunks > 0 && ` and ${lost.chunks} carved chunks`}
                {lost.movedPlacements > 0 && `, and moves ${lost.movedPlacements} placements inside the new edge`}.
              </p>
            )}
            <button
              type="button"
              className="world__action"
              onClick={() => props.onResize(wanted)}
            >
              Resize to {wanted.x}×{wanted.z}
            </button>
          </>
        )}

        <div className="world__grid2">
          <NumberField
            label="Sea level"
            value={settings.seaLevel}
            onChange={(seaLevel) => props.onSettings({ seaLevel })}
          />
          <NumberField
            label="Region size"
            value={settings.regionSize}
            onChange={(regionSize) => props.onSettings({ regionSize })}
          />
        </div>
        <div className="world__grid2">
          <NumberField label="Floor (y)" value={settings.minY} onChange={(minY) => props.onSettings({ minY })} />
          <NumberField label="Ceiling (y)" value={settings.maxY} onChange={(maxY) => props.onSettings({ maxY })} />
        </div>
        <p className="world__hint">
          A region materialises into an ordinary build, so it is capped at{' '}
          {WORLD_LIMITS.maxRegionSize} blocks a side.
        </p>
      </Section>

      <Section
        id="world-regions"
        title="Regions"
        summary={`${counts.x}×${counts.z}`}
        defaultOpen={false}
      >
        <p className="world__hint">
          {stats.length} region{stats.length === 1 ? '' : 's'}, {totalBlocks.toLocaleString()} blocks —
          about {formatDuration(totalBlocks / BLOCKS_PER_SECOND)} of building at 8,000 blocks a second.
        </p>

        <ul className="world__regions">
          {stats.map(({ region, stats: entry }) => (
            <li key={region.key}>
              <button type="button" className="world__region-row" onClick={() => props.onFrameRegion(region.rx, region.rz)}>
                <span className="world__region-id">
                  {region.rx},{region.rz}
                </span>
                <span className="world__region-blocks">{entry.blocks.toLocaleString()}</span>
                <span className="world__region-time">{formatDuration(entry.blocks / BLOCKS_PER_SECOND)}</span>
                {entry.placements > 0 && <span className="world__region-places">{entry.placements} placed</span>}
                {!entry.withinSizeCap && <span className="world__region-warn">too tall</span>}
              </button>
              <button
                type="button"
                className="world__mini"
                disabled={props.sending}
                onClick={() => props.onSendRegion(region.rx, region.rz)}
              >
                Send
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function NumberField(props: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="world__field">
      <span className="world__label">{props.label}</span>
      <input
        type="number"
        value={props.value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) props.onChange(Math.round(next));
        }}
      />
    </label>
  );
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** Rounded to the unit above once it stops being worth counting in the one below. */
function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
