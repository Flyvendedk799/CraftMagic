/**
 * The parts bin and the inspector: what you can place, and what the selected one is doing.
 *
 * The shelf is the same `useComponents` the Architecture mode uses, filtered by `kind`, and
 * that reuse is the whole three-tier idea made concrete — a structure drawn in Build and an
 * interior drawn in Architecture arrive here as the same kind of thing, because both are just
 * saved builds. Nothing in this panel knows which tier authored a component.
 *
 * The inspector edits absolute numbers rather than offering only drag. A hub is a grid of
 * buildings on axes, and lining two up by eye at 0.4 pixels per block is not possible; typing
 * the same x for both is. Drag is for finding roughly where, the fields are for saying exactly.
 */

import { useMemo, useState } from 'react';
import type { WorldDoc, WorldPlacement } from '@craftmagic/core';
import { anchorY } from '@craftmagic/core';
import { Section } from '../editor/Section.js';
import type { BuildKind } from '../library/library.js';
import type { ComponentLibrary, ShelfEntry } from '../library/components.js';
import { placementFootprint } from './toolset.js';

export interface PlacementsPanelProps {
  doc: WorldDoc;
  library: ComponentLibrary;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Arm a component for the Place tool. */
  onAdd: (entry: ShelfEntry) => void;
  /** Which one is armed, so the shelf shows what the next click will drop. */
  armed?: string | null;
  onUpdate: (id: string, patch: Partial<WorldPlacement>) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onFrame: (placement: WorldPlacement) => void;
}

const KIND_LABELS: ReadonlyArray<{ id: BuildKind; label: string }> = [
  { id: 'structure', label: 'Structures' },
  { id: 'interior', label: 'Interiors' },
];

export function PlacementsPanel(props: PlacementsPanelProps) {
  const { doc, library, selected } = props;
  const [kinds, setKinds] = useState<BuildKind[]>(['structure', 'interior']);
  const [filter, setFilter] = useState('');

  const shelf = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return library.shelf.filter(
      (entry) =>
        kinds.includes(entry.kind) && (needle === '' || entry.name.toLowerCase().includes(needle)),
    );
  }, [library.shelf, kinds, filter]);

  const placement = doc.placements.find((entry) => entry.id === selected) ?? null;

  return (
    <>
      <Section id="world-shelf" title="Components" summary={`${shelf.length}`}>
        <div className="shelf__kinds" role="group" aria-label="Component kind">
          {KIND_LABELS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={kinds.includes(id)}
              onClick={() =>
                setKinds((current) =>
                  current.includes(id)
                    ? // Never empty: a filter that hides everything looks like a broken library
                      // rather than like a filter, and there is no way back from it by clicking.
                      current.length === 1 ? current : current.filter((k) => k !== id)
                    : [...current, id],
                )
              }
            >
              {label}
            </button>
          ))}
        </div>

        <input
          type="search"
          className="world__search"
          placeholder="Filter by name"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />

        {library.status === 'signedOut' && (
          <p className="world__hint">Sign in to place the builds you have saved.</p>
        )}
        {library.status === 'loading' && <p className="world__hint">Loading your library…</p>}
        {library.status === 'error' && <p className="world__hint">The library could not be reached.</p>}
        {props.armed && (
          <p className="world__hint">Click the map to drop it. It stays armed for the next one.</p>
        )}

        {library.status === 'ready' && shelf.length === 0 && (
          <p className="world__hint">
            Nothing here yet. Save a build from Build or Architecture and it becomes a component.
          </p>
        )}

        <ul className="shelf">
          {shelf.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="shelf__item"
                aria-pressed={props.armed === entry.id}
                onClick={() => props.onAdd(entry)}
              >
                <span className="shelf__name">{entry.name}</span>
                <span className="shelf__size">
                  {entry.w}×{entry.h}×{entry.d}
                </span>
                <span className="shelf__kind" data-kind={entry.kind}>
                  {entry.kind === 'interior' ? 'Interior' : 'Structure'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="world-placed" title="Placed" summary={`${doc.placements.length}`}>
        {doc.placements.length === 0 ? (
          <p className="world__hint">Pick a component above to drop it on the map.</p>
        ) : (
          <ul className="world__placed">
            {doc.placements.map((entry) => (
              <li key={entry.id} data-selected={entry.id === selected ? 'true' : undefined}>
                <button type="button" className="world__placed-row" onClick={() => props.onSelect(entry.id)}>
                  <span className="world__placed-name">{entry.name}</span>
                  <span className="world__placed-at">
                    {entry.x}, {entry.z}
                  </span>
                </button>
                <button
                  type="button"
                  className="world__mini"
                  title="Frame on the map"
                  onClick={() => props.onFrame(entry)}
                >
                  Find
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {placement && (
        <Section id="world-inspector" title="Placement" summary={placement.name}>
          <PlacementInspector {...props} placement={placement} />
        </Section>
      )}
    </>
  );
}

function PlacementInspector({
  doc,
  placement,
  onUpdate,
  onRemove,
  onDuplicate,
  library,
}: PlacementsPanelProps & { placement: WorldPlacement }) {
  const box = placementFootprint(placement);
  const index = placement.z * doc.settings.size.x + placement.x;
  const ground = doc.terrain.height[index] ?? doc.settings.minY;
  const resolvedY = anchorY(doc, placement, ground);
  const loaded = library.catalogue.has(placement.buildId);

  return (
    <div className="world__inspector">
      <div className="world__grid2">
        <NumberField label="X" value={placement.x} onChange={(x) => onUpdate(placement.id, { x })} />
        <NumberField label="Z" value={placement.z} onChange={(z) => onUpdate(placement.id, { z })} />
      </div>

      <div className="world__row">
        <span className="world__label">Sits on</span>
        <div className="world__segmented" role="group" aria-label="Vertical anchor">
          {(['surface', 'fixed', 'buried'] as const).map((anchor) => (
            <button
              key={anchor}
              type="button"
              aria-pressed={placement.anchor === anchor}
              onClick={() => onUpdate(placement.id, { anchor })}
            >
              {anchor === 'surface' ? 'Ground' : anchor === 'fixed' ? 'Fixed y' : 'Buried'}
            </button>
          ))}
        </div>
      </div>

      {placement.anchor === 'fixed' ? (
        <NumberField label="Y" value={placement.y} onChange={(y) => onUpdate(placement.id, { y })} />
      ) : (
        <p className="world__hint">
          {placement.anchor === 'surface'
            ? `Standing on the ground at y ${resolvedY}. Raise the terrain under it and it rises too.`
            : `Sunk so its top is flush with the ground, at y ${resolvedY}.`}
        </p>
      )}

      <div className="world__row">
        <span className="world__label">Turn</span>
        <div className="world__segmented" role="group" aria-label="Rotation">
          {([0, 1, 2, 3] as const).map((turns) => (
            <button
              key={turns}
              type="button"
              aria-pressed={placement.turns === turns}
              onClick={() => onUpdate(placement.id, { turns })}
            >
              {turns * 90}°
            </button>
          ))}
        </div>
      </div>

      <dl className="world__facts">
        <div><dt>Footprint</dt><dd>{box.w}×{box.d}</dd></div>
        <div><dt>Height</dt><dd>{placement.h}</dd></div>
        <div><dt>Blocks</dt><dd>{loaded ? 'loaded' : 'not fetched yet'}</dd></div>
      </dl>

      <div className="world__row">
        <button type="button" className="world__mini" onClick={() => onDuplicate(placement.id)}>
          Duplicate
        </button>
        <button type="button" className="world__mini world__mini--danger" onClick={() => onRemove(placement.id)}>
          Remove
        </button>
      </div>
    </div>
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
