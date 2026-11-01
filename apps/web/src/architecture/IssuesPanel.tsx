/**
 * What is wrong with the building.
 *
 * Every row is clickable and jumps to the thing it is about — the storey *and* the item —
 * because the whole value of a circulation check is that it finds problems you cannot see,
 * and a message about a room you then have to hunt for gives most of that value back.
 *
 * Ordered errors first: a storey nothing climbs to is a different kind of statement from a
 * window that will be trimmed at the ceiling, and mixing them makes both easy to ignore.
 */

import type { PlanIssue } from './validate.js';

export interface IssuesPanelProps {
  issues: readonly PlanIssue[];
  onGo: (issue: PlanIssue) => void;
}

const ORDER: Record<PlanIssue['level'], number> = { error: 0, warning: 1, info: 2 };

export function IssuesPanel({ issues, onGo }: IssuesPanelProps) {
  if (issues.length === 0) {
    return (
      <div className="issues__clear-card">
        <p className="issues__clear">Every room can be walked to, and every storey is served by a stair.</p>
      </div>
    );
  }

  const sorted = [...issues].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
  const errorCount = issues.filter((i) => i.level === 'error').length;
  const warningCount = issues.filter((i) => i.level === 'warning').length;

  return (
    <div className="issues__wrap">
      <div className="issues__header">
        <span className="issues__badge">
          {errorCount > 0 ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : ''}
          {errorCount > 0 && warningCount > 0 ? ' · ' : ''}
          {warningCount > 0 ? `${warningCount} warning${warningCount === 1 ? '' : 's'}` : ''}
        </span>
        <span className="issues__tip">Click to jump to item</span>
      </div>

      <ul className="issues">
        {sorted.map((issue, index) => (
          <li key={`${issue.code}-${issue.itemId ?? index}`} className={`issues__row issues__row--${issue.level}`}>
            <button type="button" onClick={() => onGo(issue)} title="Jump to this item on the plan">
              <span className="issues__level" aria-hidden="true" />
              <span className="issues__content">
                <span className="issues__message">{issue.message}</span>
                {issue.floorIndex !== undefined && (
                  <span className="issues__floor-tag">Storey {issue.floorIndex}</span>
                )}
              </span>
              <span className="issues__arrow" aria-hidden="true">→</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Counts for the collapsed header, where "3 problems" is all that fits. */
export function issueSummary(issues: readonly PlanIssue[]): string {
  const errors = issues.filter((issue) => issue.level === 'error').length;
  const warnings = issues.filter((issue) => issue.level === 'warning').length;
  if (errors === 0 && warnings === 0) return 'clear';
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
