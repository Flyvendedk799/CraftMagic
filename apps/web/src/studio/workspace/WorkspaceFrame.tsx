import { EditorBoundary } from './EditorBoundary.js';
import { NewDocument } from './NewDocument.js';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import type { StudioMode } from '../mode.js';
import type { StudioPresence } from '../presence.js';
import type { WorkbenchActions } from '../workbench.js';
import {
  canonicalDocument,
  closeDocument,
  pinDocument,
  moveDocument,
  adjacentDocument,
  readSession,
  visitDocument,
} from './documents.js';
import {
  defaultLayout,
  readLayout,
  type DockSide,
  type DockTab,
} from './layout.js';
import { DockProvider, WorkspaceDock } from './Docks.js';
import { DocumentTabs } from './DocumentTabs.js';
import { ResizeHandle } from './ResizeHandle.js';
import { StudioIcon } from './Icon.js';
import { WorkspaceModal } from './Modal.js';
import { useStoredState } from './storage.js';
import { HistoryPanel } from './HistoryPanel.js';
import { Logo } from '../../brand/Logo.js';
import './workspace.css';

interface Props {
  mode: StudioMode;
  href: string;
  title: string;
  presence: StudioPresence | null;
  workbench: WorkbenchActions | null;
  signedIn: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onMode: (mode: StudioMode) => void;
  onOpen: (href: string, confirmed?: boolean) => void;
  onFiles: () => void;
  onCommands: () => void;
  onUndo: () => void;
  onRedo: () => void;
  children: ReactNode;
}
export function WorkspaceFrame(props: Props) {
  const { mode, href, title, presence, workbench } = props;
  const [layout, setLayout, layoutError] = useStoredState(
    'craftmagic.workspace.layout.v1',
    readLayout,
  );
  const [session, setSession, sessionError] = useStoredState(
    'craftmagic.workspace.documents.v1',
    readSession,
  );
  const [mobile, setMobile] = useState<'canvas' | 'left' | 'right'>('canvas');
  const [dialog, setDialog] = useState<
    'settings' | 'history' | 'recent' | 'new' | null
  >(null);
  const [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState<string | null>(null);
  const active = canonicalDocument(href)?.key ?? `${mode}:draft`;
  useEffect(() => {
    if (presence?.mode === mode)
      setSession((current) => visitDocument(current, href, title));
  }, [href, title, mode, presence?.mode, setSession]);
  useEffect(() => {
    setMobile('canvas');
    setSaveError(null);
  }, [mode, active]);
  useEffect(() => {
    const failed = (event: Event) => {
      const detail = (
        event as CustomEvent<{ message?: unknown; href?: unknown }>
      ).detail;
      if (typeof detail?.message !== 'string') return;
      let key: string | null | undefined = null;
      try {
        if (typeof detail.href === 'string') {
          const url = new URL(detail.href, window.location.origin);
          if (url.origin === window.location.origin)
            key = canonicalDocument(url.pathname + url.search)?.key;
        }
      } catch {
        /* A malformed event cannot replace the error surface. */
      }
      setSaveError(
        key === active
          ? detail.message
          : `Another document could not be saved: ${detail.message}`,
      );
    };
    window.addEventListener('studio:save-error', failed);
    return () => window.removeEventListener('studio:save-error', failed);
  }, [active]);
  const reveal = useCallback(
    (side: DockSide, tab: DockTab) => {
      setLayout((current) => ({
        ...current,
        focus: false,
        [side === 'left' ? 'leftVisible' : 'rightVisible']: true,
        active: {
          ...current.active,
          [mode]: { ...current.active[mode], [side]: tab },
        },
      }));
      setMobile(side);
    },
    [mode, setLayout],
  );
  const delivery = useCallback(() => {
    reveal('right', 'deliver');
    requestAnimationFrame(() =>
      document
        .getElementById('studio-section-export')
        ?.dispatchEvent(new Event('studio:open-section')),
    );
  }, [reveal]);
  useEffect(() => {
    window.addEventListener('studio:delivery', delivery);
    return () => window.removeEventListener('studio:delivery', delivery);
  }, [delivery]);
  useEffect(() => {
    const openNew = () => setDialog('new');
    window.addEventListener('studio:new-document', openNew);
    return () => window.removeEventListener('studio:new-document', openNew);
  }, []);
  useEffect(() => {
    const remove = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (
        !Array.isArray(detail) ||
        !detail.every((key) => typeof key === 'string')
      )
        return;
      const keys = new Set(detail);
      setSession((current) => ({
        ...current,
        tabs: current.tabs.filter((tab) => !keys.has(tab.key)),
        recent: current.recent.filter((tab) => !keys.has(tab.key)),
      }));
    };
    window.addEventListener('studio:files-removed', remove);
    return () => window.removeEventListener('studio:files-removed', remove);
  }, [setSession]);
  const toggle = useCallback(
    (side: DockSide) =>
      setLayout((current) => ({
        ...current,
        focus: false,
        [side === 'left' ? 'leftVisible' : 'rightVisible']:
          !current[side === 'left' ? 'leftVisible' : 'rightVisible'],
      })),
    [setLayout],
  );
  const save = useCallback(async () => {
    if (saving || !workbench?.canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await workbench.save();
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : 'Could not save this document.',
      );
    } finally {
      setSaving(false);
    }
  }, [workbench, saving]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (event.target instanceof HTMLElement &&
          event.target.closest(
            'input,textarea,select,[contenteditable="true"],[role="dialog"]',
          ))
      )
        return;
      if (event.key === '\\' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        toggle(event.shiftKey ? 'right' : 'left');
      }
      if (event.key === 'F8') {
        event.preventDefault();
        setLayout((current) => ({ ...current, focus: !current.focus }));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [setLayout, toggle]);
  const close = (key: string) => {
    if (
      key === active &&
      presence?.dirty &&
      !window.confirm(
        `Close ${title}? Save changes first if you need this version.`,
      )
    )
      return;
    const next = adjacentDocument(session.tabs, key);
    setSession((current) => closeDocument(current, key));
    if (key === active) {
      if (next) props.onOpen(next.href, true);
      else props.onOpen('/dashboard', true);
    }
  };
  const variables = useMemo(
    () =>
      ({
        '--workspace-left': `${layout.leftWidth}px`,
        '--workspace-right': `${layout.rightWidth}px`,
      }) as CSSProperties,
    [layout.leftWidth, layout.rightWidth],
  );
  const dirty = presence?.dirty ?? false;
  return (
    <DockProvider reveal={reveal}>
      <div
        className="workspace"
        data-mode={mode}
        data-density={layout.density}
        data-focus={layout.focus}
        data-left={layout.leftVisible}
        data-right={layout.rightVisible}
        data-mobile={mobile}
        data-split={layout.split}
        style={variables}
      >
        <a className="workspace-skip" href="#workspace-stage">
          Skip to canvas
        </a>
        <header className="workspace-header">
          <Link
            to="/dashboard"
            className="workspace-brand"
            aria-label="CraftMagic dashboard"
          >
            <Logo size={24} />
            <span>Studio</span>
            <small>CRAFTMAGIC</small>
          </Link>
          <div className="workspace-header__file">
            <button onClick={props.onFiles}>
              <StudioIcon name="folder" />
              Open
            </button>
            <button onClick={() => setDialog('new')} disabled={!workbench}>
              <StudioIcon name="plus" />
              New
            </button>
            <button
              onClick={() => setDialog('recent')}
              title="Recent documents"
            >
              <StudioIcon name="history" />
              <span className="workspace-wide-only">Recent</span>
            </button>
          </div>
          <button className="workspace-search" onClick={props.onCommands}>
            <StudioIcon name="search" />
            <span>Search commands, tools, files…</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="workspace-header__actions">
            <button
              onClick={() => setDialog('settings')}
              aria-label="Workspace settings"
              title="Workspace settings"
            >
              <StudioIcon name="settings" />
            </button>
            <Link className="workspace-account" to="/dashboard">
              {props.signedIn ? 'Account' : 'Sign in'}
            </Link>
            <button
              className="workspace-save"
              onClick={() => void save()}
              disabled={!workbench?.canSave || saving || workbench?.saving}
              title={workbench?.saveHint}
            >
              <StudioIcon name="save" />
              <span>
                {saving || workbench?.saving
                  ? 'Saving…'
                  : (workbench?.saveLabel ?? 'Save')}
              </span>
            </button>
            <button className="workspace-primary" onClick={delivery}>
              <StudioIcon name="export" />
              Deliver
            </button>
          </div>
        </header>
        <DocumentTabs
          tabs={session.tabs}
          active={active}
          dirty={dirty}
          onOpen={props.onOpen}
          onClose={close}
          onPin={(key) => setSession((current) => pinDocument(current, key))}
          onMove={(key, by) =>
            setSession((current) => moveDocument(current, key, by))
          }
          onNew={() => setDialog('new')}
        />
        <div className="workspace-context">
          <nav className="workspace-modes" aria-label="Studio workspaces">
            {(['world', 'arch', 'build'] as StudioMode[]).map((id) => (
              <button
                key={id}
                data-mode={id}
                aria-pressed={mode === id}
                onClick={() => props.onMode(id)}
                title={
                  id === 'world'
                    ? 'Compose terrain and place structures'
                    : id === 'arch'
                      ? 'Draw the floorplan for this structure'
                      : 'Edit blocks and materials'
                }
              >
                <StudioIcon
                  name={
                    id === 'world' ? 'world' : id === 'arch' ? 'plan' : 'cube'
                  }
                />
                {id === 'world' ? 'World' : id === 'arch' ? 'Plan' : 'Build'}
              </button>
            ))}
          </nav>
          <span className="workspace-context__divider" />
          <div className="workspace-breadcrumb" title={title}>
            <span>
              {mode === 'world'
                ? 'Project'
                : (presence?.project ?? 'Workspace')}
            </span>
            <StudioIcon name="chevron" />
            <strong>{title}</strong>
          </div>
          <div className="workspace-view-actions">
            <button
              onClick={props.onUndo}
              disabled={!props.canUndo}
              aria-label="Undo"
              title="Undo · Ctrl Z"
            >
              <StudioIcon name="undo" />
            </button>
            <button
              onClick={props.onRedo}
              disabled={!props.canRedo}
              aria-label="Redo"
              title="Redo · Ctrl Shift Z"
            >
              <StudioIcon name="redo" />
            </button>
            <button
              onClick={() => setDialog('history')}
              aria-label="Project history"
              title="Project history"
            >
              <StudioIcon name="history" />
            </button>
            <span className="workspace-context__divider" />
            {mode !== 'build' && (
              <select
                aria-label="Canvas layout"
                value={layout.split}
                onChange={(event) =>
                  setLayout((current) => ({
                    ...current,
                    split: event.target.value as typeof current.split,
                  }))
                }
              >
                <option value="both">Split view</option>
                <option value="primary">
                  {mode === 'arch' ? 'Plan only' : 'Map only'}
                </option>
                <option value="preview">3D only</option>
              </select>
            )}
            <button
              onClick={() => toggle('left')}
              aria-pressed={layout.leftVisible && !layout.focus}
              aria-label="Toggle tools panel"
              title="Tools · Ctrl \"
            >
              <StudioIcon name="panelLeft" />
            </button>
            <button
              onClick={() => toggle('right')}
              aria-pressed={layout.rightVisible && !layout.focus}
              aria-label="Toggle inspector panel"
              title="Inspector · Ctrl Shift \"
            >
              <StudioIcon name="panelRight" />
            </button>
            <button
              onClick={() =>
                setLayout((current) => ({ ...current, focus: !current.focus }))
              }
              aria-pressed={layout.focus}
              aria-label="Focus mode"
              title="Focus mode · F8"
            >
              <StudioIcon name="focus" />
            </button>
          </div>
        </div>
        {(saveError || workbench?.saveError || layoutError || sessionError) && (
          <div className="workspace-alert" role="alert">
            <StudioIcon name="warning" />
            {saveError ?? workbench?.saveError ?? layoutError ?? sessionError}
            {saveError && (
              <button onClick={() => void save()}>Retry save</button>
            )}
          </div>
        )}
        <div className="workspace-body">
          <WorkspaceDock
            side="left"
            mode={mode}
            layout={layout}
            onTab={(tab) => reveal('left', tab)}
            onClose={() => toggle('left')}
          />
          <ResizeHandle
            side="left"
            width={layout.leftWidth}
            onChange={(leftWidth) =>
              setLayout((current) => ({ ...current, leftWidth }))
            }
          />
          <main
            id="workspace-stage"
            className="workspace-stage"
            role="region"
            aria-label={`${mode === 'arch' ? 'Floorplan' : mode === 'world' ? 'World' : 'Build'} canvas`}
            tabIndex={-1}
          >
            <EditorBoundary documentKey={active} onOpenFiles={props.onFiles}>
              {props.children}
            </EditorBoundary>
          </main>
          <ResizeHandle
            side="right"
            width={layout.rightWidth}
            onChange={(rightWidth) =>
              setLayout((current) => ({ ...current, rightWidth }))
            }
          />
          <WorkspaceDock
            side="right"
            mode={mode}
            layout={layout}
            onTab={(tab) => reveal('right', tab)}
            onClose={() => toggle('right')}
          />
        </div>
        <footer className="workspace-status">
          <span className={dirty ? 'is-dirty' : ''}>
            <i />
            {workbench?.saving
              ? 'Saving…'
              : (workbench?.activity ??
                (dirty ? 'Unsaved changes' : 'No pending edits'))}
          </span>
          <span>
            {props.signedIn
              ? 'Account connected'
              : 'Local workspace · sign in for cloud saves'}
          </span>
          <button onClick={() => setDialog('history')}>
            {props.canUndo ? 'History available' : 'No edits this session'}
          </button>
          <span className="workspace-status__hint">1 block = 1 metre</span>
          <button onClick={props.onCommands}>
            Keyboard & commands <kbd>Ctrl K</kbd>
          </button>
        </footer>
        <nav className="workspace-mobile-nav" aria-label="Workspace view">
          {(['left', 'canvas', 'right'] as const).map((pane) => (
            <button
              key={pane}
              aria-pressed={mobile === pane}
              onClick={() => {
                setMobile(pane);
                if (pane !== 'canvas')
                  setLayout((current) => ({
                    ...current,
                    focus: false,
                    [pane === 'left' ? 'leftVisible' : 'rightVisible']: true,
                  }));
              }}
            >
              {pane === 'left'
                ? 'Tools'
                : pane === 'right'
                  ? 'Inspector'
                  : 'Canvas'}
            </button>
          ))}
        </nav>
        {dialog === 'new' && (
          <NewDocument
            initial={mode}
            signedIn={props.signedIn}
            onClose={() => setDialog(null)}
            onBeforeCreate={() =>
              !dirty ||
              window.confirm(
                `Open a new document? Save changes to ${title} first if you need this version.`,
              )
            }
            onCreated={(href) => {
              setDialog(null);
              props.onOpen(href, true);
            }}
          />
        )}
        {dialog === 'history' && (
          <WorkspaceModal
            title="Project history"
            eyebrow="ONE TIMELINE · ALL EDITORS"
            onClose={() => setDialog(null)}
          >
            <HistoryPanel onUndo={props.onUndo} onRedo={props.onRedo} />
          </WorkspaceModal>
        )}
        {dialog === 'recent' && (
          <WorkspaceModal
            title="Recent work"
            eyebrow="SAVED NAVIGATION · THIS DEVICE"
            onClose={() => setDialog(null)}
          >
            <div className="workspace-recent">
              {session.recent.length ? (
                session.recent.map((doc) => (
                  <button
                    key={doc.key}
                    onClick={() => {
                      setDialog(null);
                      props.onOpen(doc.href);
                    }}
                  >
                    <StudioIcon
                      name={
                        doc.mode === 'build'
                          ? 'cube'
                          : doc.mode === 'arch'
                            ? 'plan'
                            : 'world'
                      }
                    />
                    <span>
                      <strong>{doc.title}</strong>
                      <small>
                        {doc.mode === 'arch' ? 'Floorplan' : doc.mode} ·{' '}
                        {new Date(doc.lastOpened).toLocaleDateString()}
                      </small>
                    </span>
                    <StudioIcon name="arrow" />
                  </button>
                ))
              ) : (
                <p>Your opened documents will appear here.</p>
              )}
            </div>
            <p className="workspace-modal__note">
              These are links, not backups. Browser drafts stay on this device;
              library documents require your account.
            </p>
          </WorkspaceModal>
        )}
        {dialog === 'settings' && (
          <WorkspaceModal
            title="Workspace settings"
            eyebrow="YOUR WORKSPACE · YOUR LAYOUT"
            onClose={() => setDialog(null)}
          >
            <div className="workspace-settings">
              <label>
                Control density
                <select
                  value={layout.density}
                  onChange={(event) =>
                    setLayout((current) => ({
                      ...current,
                      density: event.target.value as typeof current.density,
                    }))
                  }
                >
                  <option value="comfortable">Comfortable</option>
                  <option value="compact">Compact</option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={layout.leftVisible}
                  onChange={() => toggle('left')}
                />
                Show tools dock
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={layout.rightVisible}
                  onChange={() => toggle('right')}
                />
                Show inspector dock
              </label>
              <p>
                Drag the dock edges to resize. Use arrow keys on a focused
                separator for precise control. Double-click an edge to reset its
                width.
              </p>
              <button onClick={() => setLayout(defaultLayout())}>
                Restore default layout
              </button>
              <p>
                Layout and open-document links are remembered on this device. No
                document content is removed when you reset the layout.
              </p>
            </div>
          </WorkspaceModal>
        )}
      </div>
    </DockProvider>
  );
}
