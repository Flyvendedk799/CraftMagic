import { useMemo, useState } from 'react';
import type { BuildPart } from '@craftmagic/core';
import { StudioIcon } from '../studio/workspace/Icon.js';
export interface OutlinePart extends BuildPart {
  label: string;
}
export interface OutlinerProps {
  parts: OutlinePart[] | null;
  hidden: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSolo: (path: string) => void;
  onShowAll: () => void;
  onFocus: (part: BuildPart) => void;
  onHighlight: (part: BuildPart | null) => void;
}
export function Outliner({
  parts,
  hidden,
  onToggle,
  onSolo,
  onShowAll,
  onFocus,
  onHighlight,
}: OutlinerProps) {
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState<'all' | 'visible' | 'hidden'>('all');
  const shown = useMemo(
    () =>
      parts?.filter(
        (part) =>
          part.label.toLowerCase().includes(query.trim().toLowerCase()) &&
          (filter === 'all' || (filter === 'hidden') === hidden.has(part.path)),
      ) ?? [],
    [parts, query, filter, hidden],
  );
  if (!parts)
    return (
      <p className="outliner__empty" role="status">
        Reading the program…
      </p>
    );
  if (!parts.length)
    return (
      <p className="outliner__empty">
        This build has no procedural components. Use the selection tools to edit
        its blocks.
      </p>
    );
  return (
    <div className="outliner" onPointerLeave={() => onHighlight(null)}>
      <div className="outliner__toolbar">
        <input
          type="search"
          aria-label="Search components"
          placeholder="Find a component…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="Component visibility filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value as typeof filter)}
        >
          <option value="all">All</option>
          <option value="visible">Visible</option>
          <option value="hidden">Hidden</option>
        </select>
      </div>
      {hidden.size > 0 && (
        <p className="outliner__note" role="status">
          {hidden.size} hidden. Show every part before saving or exporting the
          complete structure. <button onClick={onShowAll}>Show all</button>
        </p>
      )}
      <ul className="outliner__list" aria-label="Build components">
        {shown.map((part) => {
          const off = hidden.has(part.path);
          return (
            <li key={part.path} className="outliner__row" data-hidden={off}>
              <button
                className="outliner__eye"
                aria-label={`${off ? 'Show' : 'Hide'} ${part.label}`}
                aria-pressed={!off}
                title={off ? 'Show this component' : 'Hide this component'}
                onClick={() => onToggle(part.path)}
              >
                {off ? '◌' : '●'}
              </button>
              <button
                className="outliner__name"
                title={`${part.blocks.toLocaleString()} blocks · frame this component`}
                onPointerEnter={() => onHighlight(part)}
                onFocus={() => onHighlight(part)}
                onBlur={() => onHighlight(null)}
                onClick={() => onFocus(part)}
              >
                <StudioIcon name="cube" />
                {part.label}
              </button>
              <span className="outliner__blocks">
                {part.blocks.toLocaleString()}
              </span>
              <button
                className="outliner__solo"
                title={`Isolate ${part.label}`}
                aria-label={`Isolate ${part.label}`}
                onClick={() => onSolo(part.path)}
              >
                <StudioIcon name="focus" />
              </button>
            </li>
          );
        })}
      </ul>
      {!shown.length && (
        <p className="outliner__empty">
          No components match.{' '}
          <button
            onClick={() => {
              setQuery('');
              setFilter('all');
            }}
          >
            Clear filters
          </button>
        </p>
      )}
      <p className="outliner__summary">
        {shown.length} of {parts.length} components · click to frame
      </p>
    </div>
  );
}
