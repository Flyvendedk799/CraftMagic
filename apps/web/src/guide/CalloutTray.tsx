import type { BuildStep } from '@craftmagic/core';
import { BlockGlyph, formatStatePills } from './BlockGlyph.js';
import { Swatch } from './primitives.js';

export interface CalloutTrayProps {
  step: BuildStep;
  className?: string;
  title?: string;
}

export function CalloutTray({
  step,
  className = '',
  title = 'PARTS FOR THIS STEP',
}: CalloutTrayProps) {
  const callouts = step.callouts ?? [];
  if (callouts.length === 0) return null;

  const totalPieces = callouts.reduce((sum, c) => sum + c.count, 0);

  return (
    <aside
      className={`callout-tray ${className}`.trim()}
      aria-label={`${title}: ${totalPieces} piece${totalPieces === 1 ? '' : 's'}`}
    >
      <div className="callout-tray__header">
        <span className="callout-tray__title">{title}</span>
        <span className="callout-tray__total">
          {totalPieces} {totalPieces === 1 ? 'piece' : 'pieces'}
        </span>
      </div>

      <div className="callout-tray__grid">
        {callouts.map((callout, idx) => {
          const pills = formatStatePills(callout.glyphType, callout.states);

          return (
            <div
              key={`${callout.block}-${idx}`}
              className="callout-item"
              data-glyph={callout.glyphType ?? 'general'}
            >
              <div className="callout-item__multiplier" aria-label={`${callout.count} pieces`}>
                {callout.count}×
              </div>

              <div className="callout-item__visual">
                <Swatch block={callout.block} />
                {callout.glyphType && (
                  <span className="callout-item__glyph" title={callout.glyphType}>
                    <BlockGlyph glyphType={callout.glyphType} states={callout.states} />
                  </span>
                )}
              </div>

              <div className="callout-item__details">
                <span className="callout-item__name">{callout.displayName}</span>
                {pills.length > 0 && (
                  <div className="callout-item__pills">
                    {pills.map((pill) => (
                      <span key={pill} className="callout-item__pill">
                        {pill}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
