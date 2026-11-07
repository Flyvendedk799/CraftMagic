import { useEffect, useState } from 'react';
import { journalSnapshot, subscribeJournal, type JournalFrame } from '../journal.js';
import { StudioIcon } from './Icon.js';

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
    docLabel = `Library · ${docLabel.slice(4)}`;
  } else if (docLabel.startsWith('local:')) {
    docLabel = `Local · ${docLabel.slice(6)}`;
  } else if (docLabel.includes('?')) {
    try {
      const url = new URL(docLabel, 'https://workspace.invalid');
      const plan =
        url.searchParams.get('plan') ??
        url.searchParams.get('build') ??
        url.searchParams.get('world');
      if (plan) docLabel = plan.startsWith('local:') ? plan.slice(6) : plan;
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
  useEffect(() => subscribeJournal(() => setSnapshot(journalSnapshot())), []);

  return (
    <div className="workspace-history">
      <style>{`
        .workspace-history {
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: auto;
        }
        .workspace-history__actions {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 14px 20px;
          background: rgba(0, 0, 0, 0.15);
          border-bottom: 1px solid var(--border, #303943);
          flex-wrap: wrap;
        }
        .workspace-history__btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          font-weight: 500;
          font-size: 12px;
          border-radius: var(--radius-md, 6px);
          background: var(--raised, #252d36);
          border: 1px solid var(--border, #303943);
          color: var(--text, #e6edf3);
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .workspace-history__btn:hover:not(:disabled) {
          background: #303c47;
          border-color: #4a596a;
        }
        .workspace-history__btn:disabled {
          opacity: 0.42;
          cursor: not-allowed;
        }
        .workspace-history__btn kbd {
          font-family: ui-monospace, SFMono-Regular, monospace;
          font-size: 10px;
          padding: 1px 5px;
          background: var(--sunken, #12161c);
          border: 1px solid #3c4958;
          border-radius: var(--radius-sm, 4px);
          color: var(--muted, #9caab7);
        }
        .workspace-history__status-pill {
          margin-left: auto;
          font-size: 11px;
          color: var(--muted, #9caab7);
          padding: 4px 10px;
          background: rgba(255, 255, 255, 0.04);
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.06);
        }
        .workspace-history__status-pill strong {
          color: var(--accent, #8ee8b2);
        }
        .workspace-history ol {
          list-style: none;
          padding: 10px 16px;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .workspace-history li {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 14px;
          border-radius: var(--radius-md, 6px);
          background: #171d24;
          border: 1px solid var(--border, #303943);
          border-left: 3px solid #3c4958;
          transition: all 0.15s ease;
        }
        .workspace-history li[data-current='true'] {
          background: #1c2722;
          border-color: #3b5a48;
          border-left: 3px solid var(--accent, #8ee8b2);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        }
        .workspace-history li[data-undone='true'] {
          opacity: 0.52;
          background: rgba(20, 25, 32, 0.5);
          border-left: 3px dashed #4a5665;
          filter: grayscale(0.5);
        }
        .workspace-history__step-badge {
          font-family: ui-monospace, SFMono-Regular, monospace;
          font-size: 11px;
          font-weight: 600;
          color: var(--muted, #9caab7);
          padding: 2px 6px;
          background: var(--sunken, #12161c);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: var(--radius-sm, 4px);
          flex: none;
        }
        .workspace-history li[data-current='true'] .workspace-history__step-badge {
          color: var(--accent, #8ee8b2);
          border-color: rgba(142, 232, 178, 0.3);
        }
        .workspace-history__icon {
          display: flex;
          align-items: center;
          color: var(--accent, #8ee8b2);
          flex: none;
        }
        .workspace-history li[data-undone='true'] .workspace-history__icon {
          color: var(--muted, #9caab7);
        }
        .workspace-history__content {
          display: flex;
          flex-direction: column;
          gap: 2px;
          flex: 1;
          min-width: 0;
        }
        .workspace-history__content strong {
          font-size: 13px;
          font-weight: 600;
          color: var(--text, #e6edf3);
        }
        .workspace-history li[data-undone='true'] .workspace-history__content strong {
          color: var(--muted, #9caab7);
        }
        .workspace-history__content small {
          font-size: 11px;
          color: var(--muted, #9caab7);
        }
        .workspace-history__time {
          font-size: 11px;
          color: var(--muted, #9caab7);
          white-space: nowrap;
          flex: none;
        }
        .workspace-history__badge {
          font-size: 10px;
          font-style: normal;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          padding: 3px 8px;
          border-radius: 10px;
          flex: none;
        }
        .workspace-history__badge--current {
          background: #233e31;
          color: #bbf7d0;
          border: 1px solid #3b664d;
        }
        .workspace-history__badge--applied {
          background: rgba(255, 255, 255, 0.06);
          color: var(--muted, #9caab7);
        }
        .workspace-history__badge--undone {
          background: rgba(240, 191, 122, 0.12);
          color: var(--pending, #f0bf7a);
          border: 1px dashed rgba(240, 191, 122, 0.35);
        }
        .workspace-history__empty {
          padding: 40px 24px;
          text-align: center;
        }
        .workspace-history__empty-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.04);
          color: var(--accent, #8ee8b2);
          margin-bottom: 12px;
        }
        .workspace-history__empty h3 {
          font-size: 16px;
          font-weight: 600;
          color: var(--text, #e6edf3);
          margin: 0 0 8px;
        }
        .workspace-history__empty p {
          color: var(--muted, #9caab7);
          font-size: 12px;
          max-width: 400px;
          margin: 0 auto 16px;
          line-height: 1.5;
        }
        .workspace-history__empty-hint {
          font-size: 11px;
          color: var(--muted, #9caab7);
        }
        .workspace-history__empty-hint kbd {
          font-family: ui-monospace, SFMono-Regular, monospace;
          font-size: 10px;
          padding: 1px 5px;
          background: var(--sunken, #12161c);
          border: 1px solid #3c4958;
          border-radius: var(--radius-sm, 4px);
          color: var(--text, #e6edf3);
        }
      `}</style>

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
