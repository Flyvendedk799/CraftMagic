import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { rankCommands, nextCursor } from './workspace/commands.js';
import { useModalFocus } from './workspace/Modal.js';
import { StudioIcon } from './workspace/Icon.js';
import './workspace/palette-history-modal.css';

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
    const hasQuery = query.trim().length > 0;
    const groups = new Map<string, Command[]>();
    if (!hasQuery) {
      for (const cat of CATEGORY_ORDER) groups.set(cat, []);
    }

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
  }, [shown, query]);

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
            : `${flatItems.length} available actions across Navigation, Tools, Actions, and Files`}
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
