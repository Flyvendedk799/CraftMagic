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
    return <p className="issues__clear">Every room can be walked to, and every storey is served by a stair.</p>;
  }

  const sorted = [...issues].sort((a, b) => ORDER[a.level] - ORDER[b.level]);

  return (
    <ul className="issues">
      {sorted.map((issue, index) => (
        <li key={`${issue.code}-${issue.itemId ?? index}`} className={`issues__row issues__row--${issue.level}`}>
          <button type="button" onClick={() => onGo(issue)}>
            <span className="issues__level" aria-hidden="true" />
            {issue.message}
          </button>
        </li>
      ))}
    </ul>
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
