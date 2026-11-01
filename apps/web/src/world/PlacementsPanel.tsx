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
import { spacingToNearest } from './guides.js';

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
  /** A quarter turn about the building's middle — see `turnedAboutCentre`. */
  onRotate?: (id: string, by: 1 | -1) => void;
  onFrame: (placement: WorldPlacement) => void;
  /** Open the placed build in Build mode — carries any handoff prompt the map still holds. */
  onOpenBuild?: (placement: WorldPlacement) => void;
  onDrawPlan?: (placement: WorldPlacement) => void;
  onPathToRoad?: (placement: WorldPlacement) => void;
  /** Whether to also render the structure placement shelf in this panel (default false) */
  includeShelf?: boolean;
}

export interface StructureShelfProps {
  library: ComponentLibrary;
  onAdd: (entry: ShelfEntry) => void;
  armed?: string | null;
}

/**
 * The structure placement shelf: components available to drop on the terrain.
 * Grouped in the left dock alongside terrain sculpt brushes and stratum materials.
 */
export function StructureShelf(props: StructureShelfProps) {
  const { library, onAdd, armed } = props;
  const [kind, setKind] = useState<'all' | BuildKind>('all');
  const [filter, setFilter] = useState('');

  const shelf = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return library.shelf.filter(
      (entry) =>
        (kind === 'all' || entry.kind === kind) && (needle === '' || entry.name.toLowerCase().includes(needle)),
    );
  }, [library.shelf, kind, filter]);

  return (
    <Section id="world-shelf" title="Components" summary={`${shelf.length}`}>
      <div className="shelf__kinds" role="group" aria-label="Component kind">
        {(['all', 'structure', 'interior'] as const).map((id) => (
          <button
            key={id}
            type="button"
            className="shelf__kind"
            aria-pressed={kind === id}
            onClick={() => setKind(id)}
          >
            {id === 'all' ? 'All' : id === 'structure' ? 'Structures' : 'Interiors'}
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

      {library.status === 'signedOut' && (
        <p className="world__hint">
          The terrain tools work without an account. Placing a building needs one — components
          are your saved builds. <Link to="/dashboard">Sign in</Link>, then save something from
          Build or Architecture and it appears here.
        </p>
      )}
      {library.status === 'loading' && <p className="world__hint">Loading your library…</p>}
      {library.status === 'error' && <p className="world__hint">The library could not be reached.</p>}
      {armed && (
        <p className="world__armed" role="status">
          Click the map to drop it — it stays armed for the next one.
        </p>
      )}

      {library.status === 'ready' && shelf.length === 0 && (
        <p className="world__hint">
          {kind === 'interior'
            ? 'No interiors yet. Draw a floorplan in Architecture and save it — interiors are plans, structures are voxel builds.'
            : kind === 'structure'
              ? 'No structures yet. Save a build from the voxel editor and it shows up here.'
              : 'Nothing saved yet. Make something in Build or draw one in Architecture, press “Save to library”, and it becomes a component you can place here.'}
        </p>
      )}

      {shelf.length > 0 && (
        <ul className="shelf__list">
          {shelf.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="shelf__item shelf__item--world"
                aria-pressed={armed === entry.id}
                title={`Arm “${entry.name}” — then click the map to drop it`}
                onClick={() => onAdd(entry)}
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
  );
}

export function PlacementsPanel(props: PlacementsPanelProps) {
  const { doc, library, selected, includeShelf = false } = props;
  const placement = doc.placements.find((entry) => entry.id === selected) ?? null;

  return (
    <>
      {includeShelf && (
        <StructureShelf
          library={library}
          onAdd={props.onAdd}
          armed={props.armed}
        />
      )}

      <Section id="world-placed" title="Placed" summary={`${doc.placements.length}`}>
        {doc.placements.length === 0 ? (
          <p className="world__hint">Pick a component from the shelf to drop it on the map.</p>
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

      <Section id="world-inspector" title="Placement" summary={placement ? placement.name : 'None selected'}>
        {placement ? (
          <PlacementInspector {...props} placement={placement} />
        ) : (
          <p className="world__hint">
            Select a structure on the map or in the placed list to inspect its coordinates, anchor height, and rotation.
          </p>
        )}
      </Section>
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
  onOpenBuild,
  onDrawPlan,
  onPathToRoad,
  onRotate,
  onFrame,
}: PlacementsPanelProps & { placement: WorldPlacement }) {
  const box = placementFootprint(placement);
  const spacing = spacingToNearest(doc, placement);
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
        {/* Turned about its middle, a quarter at a time, the way R and the toolbar on the map
            turn it. Picking an absolute angle swung a long building round its corner. */}
        {onRotate ? (
          <div className="ui-seg" role="group" aria-label="Rotation">
            <button type="button" title="Turn left  (Shift+R)" onClick={() => onRotate(placement.id, -1)}>
              ⟲
            </button>
            <span className="world__turn">{placement.turns * 90}°</span>
            <button type="button" title="Turn right  (R)" onClick={() => onRotate(placement.id, 1)}>
              ⟳
            </button>
          </div>
        ) : (
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
        )}
      </div>

      <dl className="world__facts">
        <div><dt>Footprint</dt><dd>{box.w}×{box.d}</dd></div>
        <div><dt>Height</dt><dd>{placement.h} blocks</dd></div>
        <div><dt>Elevation</dt><dd>y {resolvedY} (ground: {ground})</dd></div>
        <div><dt>Orientation</dt><dd>{placement.turns * 90}°</dd></div>
        <div><dt>Spacing</dt><dd>{spacing ? `${spacing.blocks} blocks to ${spacing.name}` : 'Nothing nearby'}</dd></div>
        <div><dt>Blocks</dt><dd>{loaded ? 'Loaded' : 'Not fetched yet'}</dd></div>
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
          {onOpenBuild ? (
            <button type="button" className="export__linkish" onClick={() => onOpenBuild(placement)}>
              Open these blocks
            </button>
          ) : (
            <Link to={openInBuild(libRef(placement.buildId))}>Open these blocks</Link>
          )}
          {' · '}
          double-click the building on the map. It points at this build, so an edit here shows
          on every placement of it.
        </p>
      )}

      <div className="world__row world__row--actions">
        <button type="button" className="ui-btn" title="Center map and 3D preview on this structure" onClick={() => onFrame(placement)}>
          Find on map
        </button>
        {onDrawPlan && (
          <button type="button" className="ui-btn" onClick={() => onDrawPlan(placement)}>
            Draw a plan here
          </button>
        )}
        {onPathToRoad && (
          <button type="button" className="ui-btn" onClick={() => onPathToRoad(placement)}>
            Path to road
          </button>
        )}
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
