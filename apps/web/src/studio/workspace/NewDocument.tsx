import { useMemo, useRef, useState } from 'react';
import { createWorld } from '@craftmagic/core';
import { registerBlankBuild } from '../../editor/builds.js';
import { TEMPLATES } from '../../architecture/templates.js';
import { savePlan } from '../../architecture/storage.js';
import { localStore, remoteStore } from '../../world/api.js';
import { openInBuild, openMap } from '../handoff.js';
import type { StudioMode } from '../mode.js';
import { validateFileName } from './fileCatalogue.js';
import { WorkspaceModal } from './Modal.js';
import { StudioIcon } from './Icon.js';
import { PlanThumbnail } from './PlanThumbnail.js';
import './files-newdoc.css';

export interface NewDocumentProps {
  initial: StudioMode;
  signedIn: boolean;
  onClose: () => void;
  onBeforeCreate: () => boolean;
  onCreated: (href: string) => void;
}

const MODES = [
  {
    id: 'build' as const,
    label: 'Structure · Voxel Build',
    tag: '3D BLOCKS',
    description: 'Shape blocks directly. Detail a building or make a reusable component.',
    icon: 'cube' as const,
  },
  {
    id: 'arch' as const,
    label: 'Floorplan',
    tag: 'ARCHITECTURE',
    description: 'Design rooms and storeys, with a live model that follows the drawing.',
    icon: 'plan' as const,
  },
  {
    id: 'world' as const,
    label: 'World Map',
    tag: 'TERRAIN',
    description: 'Sculpt a site and compose your structures into one Minecraft scene.',
    icon: 'world' as const,
  },
] as const;

const BUILD_SIZES = [
  {
    value: 16,
    label: 'Small · 16³',
    dims: '16 × 16 × 16',
    desc: 'Furniture, decorative props, and small items.',
  },
  {
    value: 32,
    label: 'Standard · 32³',
    dims: '32 × 32 × 32',
    desc: 'Cottages, watchtowers, and single-family houses.',
  },
  {
    value: 64,
    label: 'Large · 64³',
    dims: '64 × 64 × 64',
    desc: 'Cathedrals, keeps, castles, and multi-storey builds.',
  },
  {
    value: 128,
    label: 'District · 128 × 64 × 128',
    dims: '128 × 64 × 128',
    desc: 'Sprawling settlements, grand palaces, and complex scenes.',
  },
];

const WORLD_SIZES = [
  {
    value: 128,
    label: 'Single site · 128 × 128',
    dims: '128 × 128 blocks',
    desc: 'Compact plot for focused scenes or quick placement testing.',
  },
  {
    value: 256,
    label: 'Neighbourhood · 256 × 256',
    dims: '256 × 256 blocks',
    desc: 'Standard terrain world with room for multiple building plots.',
  },
  {
    value: 512,
    label: 'Town · 512 × 512',
    dims: '512 × 512 blocks',
    desc: 'Broad landscape for rivers, hills, and village settlements.',
  },
  {
    value: 1024,
    label: 'Region · 1024 × 1024',
    dims: '1024 × 1024 blocks',
    desc: 'Expansive map for large-scale worldbuilding and exploration.',
  },
];

export function NewDocument({
  initial,
  signedIn,
  onClose,
  onBeforeCreate,
  onCreated,
}: NewDocumentProps) {
  const [kind, setKind] = useState<StudioMode>(initial);
  const [name, setName] = useState('');
  const [size, setSize] = useState(32);
  const [worldSize, setWorldSize] = useState(256);
  const [template, setTemplate] = useState('blank');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const activeTemplate = useMemo(
    () => TEMPLATES.find((t) => t.id === template) ?? TEMPLATES[0]!,
    [template],
  );

  const previewPlan = useMemo(() => {
    try {
      return activeTemplate.build();
    } catch {
      return null;
    }
  }, [activeTemplate]);

  const create = async () => {
    if (lock.current) return;
    const title =
      name.trim() ||
      (kind === 'build'
        ? 'Untitled structure'
        : kind === 'arch'
          ? 'Untitled floorplan'
          : 'Untitled world');
    const validation = validateFileName(title);
    if (validation) {
      setError(validation);
      return;
    }
    if (!onBeforeCreate()) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      let href: string;
      if (kind === 'build') {
        href = openInBuild(registerBlankBuild({ name: title, size }));
      } else if (kind === 'arch') {
        const plan = (
          TEMPLATES.find((value) => value.id === template) ?? TEMPLATES[0]!
        ).build();
        plan.name = title;
        savePlan(plan);
        href = `/studio?mode=arch&plan=${encodeURIComponent(`local:${plan.id}`)}`;
      } else {
        const world = createWorld({ size: { x: worldSize, z: worldSize } });
        world.name = title;
        const id = await (signedIn ? remoteStore : localStore).save(world);
        if (!id)
          throw new Error(
            'The new world could not be saved. Check storage or your connection and try again.',
          );
        href = openMap(id);
      }
      onCreated(href);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not create this document.',
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  };

  const selectedSizeInfo = BUILD_SIZES.find((s) => s.value === size) ?? BUILD_SIZES[1]!;
  const selectedWorldInfo = WORLD_SIZES.find((w) => w.value === worldSize) ?? WORLD_SIZES[1]!;

  return (
    <WorkspaceModal
      title="Create something new"
      eyebrow="ONE WORKSPACE · THREE WAYS TO BUILD"
      onClose={() => {
        if (!pending) onClose();
      }}
      wide
    >
      <form
        className="new-document"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        {/* Mode cards group */}
        <fieldset
          className="new-document__types"
          aria-label="Document type"
        >
          {MODES.map((entry, index) => {
            const isSelected = kind === entry.id;
            return (
              <button
                type="button"
                key={entry.id}
                ref={(el) => {
                  cardRefs.current[index] = el;
                }}
                tabIndex={isSelected ? 0 : -1}
                aria-pressed={isSelected}
                data-active={isSelected}
                className="new-document__type-card"
                disabled={pending}
                onClick={() => setKind(entry.id)}
                onKeyDown={(e) => {
                  let targetIndex: number | null = null;
                  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                    targetIndex = (index + 1) % MODES.length;
                  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                    targetIndex = (index - 1 + MODES.length) % MODES.length;
                  }
                  if (targetIndex !== null) {
                    e.preventDefault();
                    setKind(MODES[targetIndex]!.id);
                    cardRefs.current[targetIndex]?.focus();
                  }
                }}
              >
                <div className="new-document__type-header">
                  <div className="new-document__type-icon">
                    <StudioIcon name={entry.icon} />
                  </div>
                  <span className="new-document__type-tag">{entry.tag}</span>
                </div>
                <strong>{entry.label}</strong>
                <span>{entry.description}</span>
                <div className="new-document__type-indicator" aria-hidden="true">
                  <StudioIcon name={isSelected ? 'check' : 'plus'} />
                </div>
              </button>
            );
          })}
        </fieldset>

        {/* Form fields: Name and Mode-specific options */}
        <div className="new-document__fields">
          <label className="new-document__field-name">
            <span>Document name</span>
            <input
              autoFocus
              aria-label="New document name"
              placeholder={
                kind === 'world'
                  ? 'e.g. Whispering Pines or Nordic Fjord'
                  : kind === 'arch'
                    ? 'e.g. Modern Villa or Lake Cottage'
                    : 'e.g. Stone Watchtower or Oak Cottage'
              }
              value={name}
              maxLength={120}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          {kind === 'build' && (
            <div className="new-document__options">
              <label>
                <span>Working volume</span>
                <select
                  aria-label="Build volume"
                  disabled={pending}
                  value={size}
                  onChange={(event) => setSize(Number(event.target.value))}
                >
                  {BUILD_SIZES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="new-document__preview-card">
                <div className="new-document__preview-icon">
                  <StudioIcon name="cube" />
                </div>
                <div className="new-document__preview-copy">
                  <strong>{selectedSizeInfo.dims}</strong>
                  <p>{selectedSizeInfo.desc}</p>
                </div>
              </div>
            </div>
          )}

          {kind === 'arch' && (
            <div className="new-document__options">
              <label>
                <span>Starting layout template</span>
                <select
                  aria-label="Starting floorplan"
                  disabled={pending}
                  value={template}
                  onChange={(event) => setTemplate(event.target.value)}
                >
                  {TEMPLATES.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="new-document__preview-card new-document__preview-card--arch">
                {previewPlan ? (
                  <div className="new-document__plan-thumb-wrap">
                    <PlanThumbnail plan={previewPlan} />
                  </div>
                ) : (
                  <div className="new-document__preview-icon">
                    <StudioIcon name="plan" />
                  </div>
                )}
                <div className="new-document__preview-copy">
                  <strong>{activeTemplate.name}</strong>
                  <p>{activeTemplate.description}</p>
                </div>
              </div>
            </div>
          )}

          {kind === 'world' && (
            <div className="new-document__options">
              <label>
                <span>World extent</span>
                <select
                  aria-label="World extent"
                  disabled={pending}
                  value={worldSize}
                  onChange={(event) => setWorldSize(Number(event.target.value))}
                >
                  {WORLD_SIZES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="new-document__preview-card">
                <div className="new-document__preview-icon">
                  <StudioIcon name="world" />
                </div>
                <div className="new-document__preview-copy">
                  <strong>{selectedWorldInfo.dims}</strong>
                  <p>{selectedWorldInfo.desc}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Storage location info */}
        <div className="new-document__storage">
          <StudioIcon name={kind === 'world' && signedIn ? 'spark' : 'folder'} />
          <p>
            {kind === 'world' && signedIn
              ? 'This new world will be saved directly to your cloud account.'
              : 'This document starts on this device. Save to your account or export a file anytime.'}{' '}
            No AI credits are needed for blank documents.
          </p>
        </div>

        {error && (
          <p className="workspace-files__error" role="alert">
            {error}
          </p>
        )}

        <footer>
          <button type="button" disabled={pending} onClick={onClose}>
            Cancel
          </button>
          <button
            className="workspace-primary new-document__submit-btn"
            type="submit"
            disabled={pending}
          >
            {pending ? (
              <span>Creating…</span>
            ) : (
              <>
                <span>Create & open</span>
                <StudioIcon name="arrow" />
              </>
            )}
          </button>
        </footer>
      </form>
    </WorkspaceModal>
  );
}
