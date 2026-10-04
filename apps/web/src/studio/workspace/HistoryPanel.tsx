import { useEffect, useState } from 'react';
import { journalSnapshot, subscribeJournal } from '../journal.js';
import { StudioIcon } from './Icon.js';
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
      <div className="workspace-history__actions">
        <button
          disabled={snapshot.cursor === 0 || snapshot.pending}
          onClick={onUndo}
        >
          <StudioIcon name="undo" />
          Undo latest edit
        </button>
        <button
          disabled={
            snapshot.cursor === snapshot.frames.length || snapshot.pending
          }
          onClick={onRedo}
        >
          <StudioIcon name="redo" />
          Redo
        </button>
      </div>
      {snapshot.frames.length ? (
        <ol>
          {snapshot.frames
            .map((frame, index) => (
              <li
                key={`${index}:${frame.scope}:${frame.docId}`}
                data-undone={index >= snapshot.cursor}
              >
                <span className="workspace-history__number">{index + 1}</span>
                <StudioIcon
                  name={
                    frame.scope === 'build'
                      ? 'cube'
                      : frame.scope === 'arch'
                        ? 'plan'
                        : 'world'
                  }
                />
                <span>
                  <strong>
                    {frame.label ??
                      (frame.scope === 'build'
                        ? 'Edit blocks'
                        : frame.scope === 'arch'
                          ? 'Edit floorplan'
                          : 'Edit world')}
                  </strong>
                  <small>
                    {frame.scope === 'arch' ? 'Plan' : frame.scope} ·{' '}
                    {frame.docId.startsWith('lib:')
                      ? 'Library document'
                      : frame.docId}
                  </small>
                </span>
                <em>
                  {index >= snapshot.cursor
                    ? 'Undone'
                    : index === snapshot.cursor - 1
                      ? 'Current'
                      : 'Applied'}
                </em>
              </li>
            ))
            .reverse()}
        </ol>
      ) : (
        <div className="workspace-empty">
          <StudioIcon name="history" />
          <h3>Your edits will appear here</h3>
          <p>
            A brush stroke, room drag or terrain stroke is one undo step.
            History follows you between editors during this session.
          </p>
        </div>
      )}
      <p className="workspace-modal__note">
        History is kept in memory for this session. Named saves and downloaded
        exports are your durable copies.
      </p>
    </div>
  );
}
