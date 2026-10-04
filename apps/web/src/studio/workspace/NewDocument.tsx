import { useRef, useState } from 'react';
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
export interface NewDocumentProps {
  initial: StudioMode;
  signedIn: boolean;
  onClose: () => void;
  onBeforeCreate: () => boolean;
  onCreated: (href: string) => void;
}
export function NewDocument({
  initial,
  signedIn,
  onClose,
  onBeforeCreate,
  onCreated,
}: NewDocumentProps) {
  const [kind, setKind] = useState(initial),
    [name, setName] = useState(''),
    [size, setSize] = useState(32),
    [worldSize, setWorldSize] = useState(256),
    [template, setTemplate] = useState('blank');
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
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
        <div
          className="new-document__types"
          role="group"
          aria-label="Document type"
        >
          {(
            [
              {
                id: 'build',
                label: 'Structure',
                description:
                  'Shape blocks directly. Detail a building or make a reusable component.',
                icon: 'cube',
              },
              {
                id: 'arch',
                label: 'Floorplan',
                description:
                  'Design rooms and storeys, with a live model that follows the drawing.',
                icon: 'plan',
              },
              {
                id: 'world',
                label: 'World',
                description:
                  'Sculpt a site and compose your structures into one Minecraft scene.',
                icon: 'world',
              },
            ] as const
          ).map((entry) => (
            <button
              type="button"
              key={entry.id}
              aria-pressed={kind === entry.id}
              disabled={pending}
              onClick={() => setKind(entry.id)}
            >
              <StudioIcon name={entry.icon} />
              <strong>{entry.label}</strong>
              <span>{entry.description}</span>
            </button>
          ))}
        </div>
        <div className="new-document__fields">
          <label>
            Name
            <input
              autoFocus
              aria-label="New document name"
              placeholder={
                kind === 'world'
                  ? 'My world'
                  : kind === 'arch'
                    ? 'My floorplan'
                    : 'My structure'
              }
              value={name}
              maxLength={120}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {kind === 'build' && (
            <label>
              Working volume
              <select
                aria-label="Build volume"
                disabled={pending}
                value={size}
                onChange={(event) => setSize(Number(event.target.value))}
              >
                <option value={16}>Small · 16 × 16 × 16</option>
                <option value={32}>Standard · 32 × 32 × 32</option>
                <option value={64}>Large · 64 × 64 × 64</option>
                <option value={128}>District · 128 × 64 × 128</option>
              </select>
            </label>
          )}
          {kind === 'arch' && (
            <label>
              Starting layout
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
          )}
          {kind === 'world' && (
            <label>
              World extent
              <select
                aria-label="World extent"
                disabled={pending}
                value={worldSize}
                onChange={(event) => setWorldSize(Number(event.target.value))}
              >
                <option value={128}>Single site · 128 × 128</option>
                <option value={256}>Neighbourhood · 256 × 256</option>
                <option value={512}>Town · 512 × 512</option>
                <option value={1024}>Region · 1024 × 1024</option>
              </select>
            </label>
          )}
        </div>
        <div className="new-document__storage">
          <StudioIcon name="folder" />
          <p>
            {kind === 'world' && signedIn
              ? 'This new world will be saved to your account.'
              : 'This document starts on this device. Save to your account or export a file to keep a portable copy.'}{' '}
            No AI call is made when creating a blank document.
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
            className="workspace-primary"
            type="submit"
            disabled={pending}
          >
            {pending ? 'Creating…' : 'Create & open'}
            <StudioIcon name="arrow" />
          </button>
        </footer>
      </form>
    </WorkspaceModal>
  );
}
