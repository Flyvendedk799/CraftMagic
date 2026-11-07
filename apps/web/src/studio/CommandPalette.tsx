import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { rankCommands, nextCursor } from './workspace/commands.js';
import { useModalFocus } from './workspace/Modal.js';
import { StudioIcon } from './workspace/Icon.js';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  category?: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  run: () => void;
}

export interface CommandPaletteProps {
  commands: readonly Command[];
  onClose: () => void;
}

export const CATEGORY_ORDER = ['Navigation', 'Tools', 'Actions', 'Files'] as const;
export type CommandCategory = (typeof CATEGORY_ORDER)[number];

export function resolveCategory(command: Command): string {
  const cat = command.category?.trim();
  if (cat) {
    const lower = cat.toLowerCase();
    if (lower === 'navigation' || lower.includes('nav') || lower.includes('mode')) return 'Navigation';
    if (lower === 'tools' || lower.includes('tool') || lower.includes('view') || lower.includes('edit')) return 'Tools';
    if (lower === 'files' || lower.includes('file') || lower.includes('doc')) return 'Files';
    if (lower === 'actions' || lower.includes('action') || lower.includes('export') || lower.includes('help')) return 'Actions';
    return cat;
  }
  const id = command.id.toLowerCase();
  const label = command.label.toLowerCase();
  if (
    id.startsWith('mode-') ||
    id === 'open-structure-plan' ||
    id.startsWith('go-') ||
    label.startsWith('switch to')
  ) {
    return 'Navigation';
  }
  if (
    id.startsWith('tool-') ||
    id.startsWith('view-') ||
    id.includes('brush') ||
    id.includes('terrain') ||
    label.startsWith('tool:') ||
    label.startsWith('view:')
  ) {
    return 'Tools';
  }
  if (
    id.startsWith('file-open') ||
    id.startsWith('file-new') ||
    id.startsWith('build-') ||
    id.startsWith('lib-') ||
    id.startsWith('map-') ||
    id === 'world-draft'
  ) {
    return 'Files';
  }
  if (
    id.startsWith('file-save') ||
    id.startsWith('file-export') ||
    id.startsWith('style-') ||
    id === 'guide'
  ) {
    return 'Actions';
  }
  return 'Actions';
}

const RECENT_KEY = 'craftmagic.workspace.recentCommands';
function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v)
      ? v.filter((x) => typeof x === 'string').slice(0, 12)
      : [];
  } catch {
    return [];
  }
}

export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState(''),
    [cursor, setCursor] = useState(0),
    [recent] = useState(readRecent);
  const host = useModalFocus(true, onClose),
    input = useRef<HTMLInputElement>(null);

  const shown = useMemo(
    () => rankCommands(commands, query, recent).slice(0, 150),
    [commands, query, recent],
  );

  const { flatItems, sections } = useMemo(() => {
    const groups = new Map<string, Command[]>();
    for (const cat of CATEGORY_ORDER) groups.set(cat, []);

    for (const cmd of shown) {
      const cat = resolveCategory(cmd);
      const existing = groups.get(cat);
      if (existing) {
        existing.push(cmd);
      } else {
        groups.set(cat, [cmd]);
      }
    }

    const flat: { command: Command; category: string; isFirstInCategory: boolean }[] = [];
    const secList: { category: string; count: number }[] = [];

    for (const [category, items] of groups.entries()) {
      if (!items.length) continue;
      secList.push({ category, count: items.length });
      items.forEach((command, idx) => {
        flat.push({
          command,
          category,
          isFirstInCategory: idx === 0,
        });
      });
    }

    return { flatItems: flat, sections: secList };
  }, [shown]);

  const active = Math.min(cursor, Math.max(0, flatItems.length - 1));

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    const el = host.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [active, query, host]);

  const run = (command: Command | undefined) => {
    if (!command || command.disabled) return;
    try {
      localStorage.setItem(
        RECENT_KEY,
        JSON.stringify(
          [command.id, ...recent.filter((id) => id !== command.id)].slice(
            0,
            12,
          ),
        ),
      );
    } catch {}
    onClose();
    command.run();
  };

  return (
    <div
      className="command-search"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <style>{`
        .command-search__input {
          display: flex;
          align-items: center;
          padding: 13px 18px;
          gap: 10px;
          border-bottom: 1px solid #344252;
          background: #171f28;
        }
        .command-search__input-lead {
          display: flex;
          align-items: center;
          color: var(--accent, #8ee8b2);
          flex: none;
        }
        .command-search__input input {
          flex: 1;
          min-width: 0;
          background: transparent;
          border: 0;
          outline: 0;
          color: var(--text, #e6edf3);
          font: 15px ui-sans-serif, system-ui, sans-serif;
        }
        .command-search__clear {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          padding: 0;
          border: 0;
          border-radius: var(--radius-sm, 4px);
          background: rgba(255, 255, 255, 0.05);
          color: var(--muted, #9caab7);
          cursor: pointer;
          flex: none;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .command-search__clear:hover {
          background: rgba(255, 255, 255, 0.12);
          color: var(--text, #e6edf3);
        }
        .command-search__count {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.06);
          color: var(--muted, #9caab7);
          white-space: nowrap;
          flex: none;
          border: 1px solid rgba(255, 255, 255, 0.04);
        }
        .command-search__esc {
          background: transparent;
          border: 0;
          padding: 0;
          cursor: pointer;
          flex: none;
        }
        .command-search__section-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px 5px;
          margin-top: 6px;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: var(--accent, #8ee8b2);
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          list-style: none;
          user-select: none;
        }
        .command-search__section-header:first-child {
          margin-top: 0;
        }
        .command-search__section-count {
          font-size: 10px;
          color: var(--muted, #9caab7);
          font-weight: 400;
          letter-spacing: 0;
        }
        .command-search__item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          border-radius: var(--radius-md, 6px);
          cursor: pointer;
          border: 1px solid transparent;
          transition: background 0.12s ease, border-color 0.12s ease;
        }
        .command-search__item[aria-selected='true'],
        .command-search__item--active {
          background: #23342c !important;
          border-color: #436952 !important;
          box-shadow: inset 0 0 0 1px rgba(142, 232, 178, 0.15);
        }
        .command-search__item[aria-selected='true'] .command-search__glyph {
          color: var(--accent, #8ee8b2);
        }
        .command-search__item[aria-selected='true'] strong {
          color: #ffffff;
        }
        .command-search__shortcut {
          margin-left: auto;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
          font-size: 10px !important;
          padding: 2px 6px !important;
          background: var(--sunken, #12161c) !important;
          border: 1px solid #3c4958 !important;
          border-radius: var(--radius-sm, 4px) !important;
          color: var(--muted, #9caab7) !important;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
          flex: none;
          white-space: nowrap;
        }
        .command-search__item[aria-selected='true'] .command-search__shortcut {
          border-color: rgba(142, 232, 178, 0.5) !important;
          color: var(--text, #e6edf3) !important;
          background: #141f1a !important;
        }
        .command-search__empty-title {
          font-size: 15px;
          font-weight: 600;
          margin: 12px 0 6px;
          color: var(--text, #e6edf3);
        }
        .command-search__empty-text {
          font-size: 12px;
          color: var(--muted, #9caab7);
          max-width: 400px;
          margin: 0 auto 16px;
          line-height: 1.5;
        }
        .command-search__empty-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 14px;
          background: var(--raised, #252d36);
          border: 1px solid var(--border, #303943);
          border-radius: var(--radius-sm, 4px);
          color: var(--text, #e6edf3);
          cursor: pointer;
          font-size: 12px;
          transition: background 0.15s ease;
        }
        .command-search__empty-btn:hover {
          background: #303c47;
        }
      `}</style>
      <div
        ref={host}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="command-search__panel"
        tabIndex={-1}
      >
        <div className="command-search__input">
          <div className="command-search__input-lead">
            <StudioIcon name="search" />
          </div>
          <input
            ref={input}
            role="combobox"
            aria-label="Search commands"
            aria-controls="studio-command-results"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={
              flatItems[active] ? `command-result-${active}` : undefined
            }
            placeholder="What would you like to do?"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setCursor(
                  nextCursor(
                    active,
                    event.key === 'ArrowDown' ? 1 : -1,
                    flatItems.length,
                  ),
                );
              }
              if (event.key === 'Home') {
                event.preventDefault();
                setCursor(0);
              }
              if (event.key === 'End') {
                event.preventDefault();
                setCursor(Math.max(0, flatItems.length - 1));
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                run(flatItems[active]?.command);
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="command-search__clear"
              onClick={() => {
                setQuery('');
                setCursor(0);
                input.current?.focus();
              }}
              aria-label="Clear search query"
              title="Clear search query"
            >
              <StudioIcon name="close" />
            </button>
          )}
          <span className="command-search__count" aria-live="polite">
            {flatItems.length} {flatItems.length === 1 ? 'command' : 'commands'}
          </span>
          <button
            type="button"
            className="command-search__esc"
            onClick={onClose}
            aria-label="Close command palette"
            title="Close command palette (Esc)"
          >
            <kbd>Esc</kbd>
          </button>
        </div>
        <div className="command-search__caption">
          {query
            ? `${flatItems.length} matching ${flatItems.length === 1 ? 'action' : 'actions'} for "${query}"`
            : recent.length
              ? `${flatItems.length} available actions · Recent actions prioritized`
              : `${flatItems.length} available commands across Navigation, Tools, Actions, and Files`}
        </div>
        <ul
          id="studio-command-results"
          role="listbox"
          aria-label="Commands"
          className="command-search__results"
        >
          {flatItems.map((item, index) => {
            const { command, category, isFirstInCategory } = item;
            const isSelected = index === active;
            return (
              <Fragment key={command.id}>
                {isFirstInCategory && (
                  <li
                    role="presentation"
                    className="command-search__section-header"
                    aria-hidden="true"
                  >
                    <span className="command-search__section-title">{category}</span>
                    <span className="command-search__section-count">
                      {sections.find((s) => s.category === category)?.count}
                    </span>
                  </li>
                )}
                <li
                  role="option"
                  id={`command-result-${index}`}
                  aria-selected={isSelected}
                  aria-disabled={command.disabled || undefined}
                  className={`command-search__item${isSelected ? ' command-search__item--active' : ''}`}
                  onPointerMove={() => setCursor(index)}
                  onClick={() => run(command)}
                >
                  <span className="command-search__glyph">
                    <StudioIcon
                      name={
                        command.checked
                          ? 'check'
                          : category === 'Tools'
                            ? 'cube'
                            : category === 'Navigation'
                              ? 'chevron'
                              : category === 'Files'
                                ? 'folder'
                                : 'spark'
                      }
                    />
                  </span>
                  <span className="command-search__copy">
                    <strong>{command.label}</strong>
                    {command.hint && <small>{command.hint}</small>}
                  </span>
                  <span className="command-search__category">
                    {category}
                  </span>
                  {command.shortcut && (
                    <kbd className="command-search__shortcut">{command.shortcut}</kbd>
                  )}
                </li>
              </Fragment>
            );
          })}
        </ul>
        {!flatItems.length && (
          <div className="command-search__empty">
            <StudioIcon name="search" />
            <h3 className="command-search__empty-title">
              {query ? `No matching actions for "${query}"` : 'No actions available'}
            </h3>
            <p className="command-search__empty-text">
              Try searching for tools (brush, erase), document modes (build, world, plan), or actions (save, export).
            </p>
            {query && (
              <button
                type="button"
                className="command-search__empty-btn"
                onClick={() => {
                  setQuery('');
                  setCursor(0);
                  input.current?.focus();
                }}
              >
                <StudioIcon name="close" />
                Clear search query
              </button>
            )}
          </div>
        )}
        <footer>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>Enter</kbd> Run action
          </span>
          <span>Actions apply to the current document</span>
        </footer>
      </div>
    </div>
  );
}
