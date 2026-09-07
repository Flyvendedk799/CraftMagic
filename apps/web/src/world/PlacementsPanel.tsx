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
import { Link } from 'react-router-dom';
import type { WorldDoc, WorldPlacement } from '@craftmagic/core';
import { anchorY } from '@craftmagic/core';
import { Section } from '../editor/Section.js';
import type { BuildKind } from '../library/library.js';
import type { ComponentLibrary, ShelfEntry } from '../library/components.js';
import { libRef, openInBuild } from '../studio/handoff.js';
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
        {/* The two filters. They carried no class at all, so they fell through to the global
            `button` rule and rendered as two full-strength mint call-to-actions — the loudest
            thing on a page whose actual verbs are "sculpt" and "place". */}
        <div className="shelf__kinds" role="group" aria-label="Component kind">
          {KIND_LABELS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className="shelf__kind"
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
          className="ui-input world__search"
          placeholder="Filter by name"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />

        {/* Sculpting works signed out; placing does not, because a component is a saved build
            and the library needs an account. Both halves of that are said here, with the door,
            rather than leaving an empty shelf to explain itself. */}
        {library.status === 'signedOut' && (
          <p className="world__hint">
            The terrain tools work without an account. Placing a building needs one — components
            are your saved builds. <Link to="/dashboard">Sign in</Link>, then save something from
            Build or Architecture and it appears here.
          </p>
        )}
        {library.status === 'loading' && <p className="world__hint">Loading your library…</p>}
        {library.status === 'error' && <p className="world__hint">The library could not be reached.</p>}
        {props.armed && (
          <p className="world__armed" role="status">
            Click the map to drop it — it stays armed for the next one.
          </p>
        )}

        {library.status === 'ready' && shelf.length === 0 && (
          <p className="world__hint">
            Nothing saved yet. Make something in <Link to="/studio?build=empty">Build</Link> or
            draw one in <Link to="/studio?mode=arch">Architecture</Link>, press “Save to
            library”, and it becomes a component you can place here.
          </p>
        )}

        {/* `shelf__list` and `shelf__item` are Architecture's, so the same saved build looks
            the same in both modes. The badge is `shelf__badge`, not `shelf__kind`: that name
            already belongs to the filter buttons above, and while the two shared it every
            badge in the list was being drawn as a pressed filter. */}
        {shelf.length > 0 && (
          <ul className="shelf__list">
            {shelf.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="shelf__item shelf__item--world"
                  aria-pressed={props.armed === entry.id}
                  title={`Arm “${entry.name}” — then click the map to drop it`}
                  onClick={() => props.onAdd(entry)}
                >
                  <span className="shelf__name">{entry.name}</span>
                  <span className="shelf__meta">
                    {entry.w}×{entry.h}×{entry.d}
                  </span>
                  <span className="shelf__badge" data-kind={entry.kind}>
                    {entry.kind === 'interior' ? 'Interior' : 'Structure'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
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
                  className="ui-btn"
                  title="Frame this one on the map and in the 3D view"
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
        <div className="ui-seg" role="group" aria-label="Vertical anchor">
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
        <div className="ui-seg" role="group" aria-label="Rotation">
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

      {/* The way back: a placement is a reference to a library row, and that row is what Build
          edits. A placement whose row is gone says so rather than offering a link to a 404. */}
      {library.failed.has(placement.buildId) ? (
        <p className="world__hint">
          The build this was placed from is no longer in your library, so it cannot be edited or
          materialised — only removed.
        </p>
      ) : (
        <p className="world__hint">
          <Link to={openInBuild(libRef(placement.buildId))}>Edit the source build in Build →</Link>{' '}
          Changes there save as a new build; re-place it here to use the new one.
        </p>
      )}

      <div className="world__row world__row--actions">
        <button type="button" className="ui-btn" onClick={() => onDuplicate(placement.id)}>
          Duplicate
        </button>
        <button type="button" className="ui-btn ui-btn--danger" onClick={() => onRemove(placement.id)}>
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
        className="ui-num"
        value={props.value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) props.onChange(Math.round(next));
        }}
      />
    </label>
  );
}
