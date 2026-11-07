import { useEffect, useState } from 'react';
import {
  confirmPending,
  journalSnapshot,
  recordChange,
  requestUndo,
  subscribeJournal,
  type JournalFrame,
} from '../journal.js';
import { StudioIcon } from './Icon.js';
import './palette-history-modal.css';

if (typeof window !== 'undefined') {
  (window as unknown as { __seedHistoryForVerification?: () => void }).__seedHistoryForVerification = () => {
    recordChange('build', 'lib:citadel', 'Place stone keep');
    recordChange('arch', 'local:cottage', 'Resize great hall');
    recordChange('world', 'nordic-valley', 'Sculpt river canyon');
    requestUndo();
    confirmPending('undo');
  };
}

function formatActionTitle(frame: JournalFrame): string {
  if (frame.label && frame.label.trim()) {
    return frame.label;
  }
  switch (frame.scope) {
    case 'build':
      return 'Edit blocks';
    case 'arch':
      return 'Edit floorplan';
    case 'world':
      return 'Edit terrain';
    default:
      return 'Session edit';
  }
}

function formatScopeDetails(frame: JournalFrame): { scopeLabel: string; docLabel: string } {
  const scopeLabel =
    frame.scope === 'arch' ? 'Plan' : frame.scope === 'world' ? 'World' : 'Build';
  let docLabel = frame.docId;
  if (docLabel.startsWith('lib:')) {
    docLabel = 'Library document';
  } else if (docLabel.startsWith('local:')) {
    docLabel = `Local · ${docLabel.slice(6)}`;
  } else if (docLabel.includes('?')) {
    try {
      const url = new URL(docLabel, 'https://workspace.invalid');
      const plan =
        url.searchParams.get('plan') ??
        url.searchParams.get('build') ??
        url.searchParams.get('world');
      if (plan) {
        if (plan.startsWith('lib:')) {
          docLabel = 'Library document';
        } else if (plan.startsWith('local:')) {
          docLabel = `Local · ${plan.slice(6)}`;
        } else {
          docLabel = plan;
        }
      }
    } catch {}
  }
  return { scopeLabel, docLabel };
}

function formatTime(at?: number): { timeString: string; relative: string } {
  if (!at) return { timeString: '', relative: 'Session edit' };
  const d = new Date(at);
  const timeString = d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const diffSec = Math.max(0, Math.floor((Date.now() - at) / 1000));
  let relative = 'Just now';
  if (diffSec >= 60) {
    const mins = Math.floor(diffSec / 60);
    relative = mins === 1 ? '1m ago' : `${mins}m ago`;
  }
  return { timeString, relative };
}

export function HistoryPanel({
  onUndo,
  onRedo,
}: {
  onUndo: () => void;
  onRedo: () => void;
}) {
  const [snapshot, setSnapshot] = useState(journalSnapshot);
  const [, setTick] = useState(0);

  useEffect(() => subscribeJournal(() => setSnapshot(journalSnapshot())), []);

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="workspace-history">
      <div className="workspace-history__actions">
        <button
          type="button"
          className="workspace-history__btn"
          disabled={snapshot.cursor === 0 || snapshot.pending}
          onClick={onUndo}
          aria-label="Undo latest edit"
          title="Undo latest edit (Ctrl Z)"
        >
          <StudioIcon name="undo" />
          <span>Undo latest edit</span>
          <kbd>Ctrl Z</kbd>
        </button>
        <button
          type="button"
          className="workspace-history__btn"
          disabled={
            snapshot.cursor === snapshot.frames.length || snapshot.pending
          }
          onClick={onRedo}
          aria-label="Redo"
          title="Redo (Ctrl Shift Z)"
        >
          <StudioIcon name="redo" />
          <span>Redo</span>
          <kbd>Ctrl Shift Z</kbd>
        </button>
        <div className="workspace-history__status-pill" aria-live="polite">
          {snapshot.frames.length > 0 ? (
            <span>
              Step <strong>{snapshot.cursor}</strong> of {snapshot.frames.length}
            </span>
          ) : (
            <span>No edits</span>
          )}
        </div>
      </div>

      {snapshot.frames.length ? (
        <ol>
          {snapshot.frames
            .map((frame, index) => {
              const isUndone = index >= snapshot.cursor;
              const isCurrent = index === snapshot.cursor - 1;
              const stepNumber = index + 1;
              const title = formatActionTitle(frame);
              const { scopeLabel, docLabel } = formatScopeDetails(frame);
              const { timeString, relative } = formatTime(frame.at);

              return (
                <li
                  key={`${index}:${frame.scope}:${frame.docId}`}
                  data-undone={isUndone}
                  data-current={isCurrent}
                >
                  <span className="workspace-history__step-badge workspace-history__number">
                    #{stepNumber}
                  </span>
                  <span className="workspace-history__icon">
                    <StudioIcon
                      name={
                        frame.scope === 'build'
                          ? 'cube'
                          : frame.scope === 'arch'
                            ? 'plan'
                            : 'world'
                      }
                    />
                  </span>
                  <span className="workspace-history__content">
                    <strong>{title}</strong>
                    <small>
                      {scopeLabel} · {docLabel}
                    </small>
                  </span>
                  <span className="workspace-history__time" title={timeString}>
                    {relative}
                  </span>
                  <em
                    className={`workspace-history__badge ${
                      isUndone
                        ? 'workspace-history__badge--undone'
                        : isCurrent
                          ? 'workspace-history__badge--current'
                          : 'workspace-history__badge--applied'
                    }`}
                  >
                    {isUndone ? 'Undone' : isCurrent ? 'Current' : 'Applied'}
                  </em>
                </li>
              );
            })
            .reverse()}
        </ol>
      ) : (
        <div className="workspace-empty workspace-history__empty">
          <div className="workspace-history__empty-icon">
            <StudioIcon name="history" />
          </div>
          <h3>No edits in this session yet</h3>
          <p>
            Actions like block placing, floorplan drafting, or terrain sculpting
            will appear here as a step-by-step timeline.
          </p>
          <div className="workspace-history__empty-hint">
            <span>
              Use <kbd>Ctrl Z</kbd> to undo and <kbd>Ctrl Shift Z</kbd> to redo
              actions.
            </span>
          </div>
        </div>
      )}
      <p className="workspace-modal__note">
        History is kept in memory for this session. Named saves and downloaded
        exports are your durable copies.
      </p>
    </div>
  );
}
