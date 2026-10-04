import { useEffect, useMemo, useRef, useState } from 'react';
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
  const active = Math.min(cursor, Math.max(0, shown.length - 1));
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    host.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
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
          <StudioIcon name="search" />
          <input
            ref={input}
            role="combobox"
            aria-label="Search commands"
            aria-controls="studio-command-results"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={
              shown[active] ? `command-result-${active}` : undefined
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
                    shown.length,
                  ),
                );
              }
              if (event.key === 'Home') {
                event.preventDefault();
                setCursor(0);
              }
              if (event.key === 'End') {
                event.preventDefault();
                setCursor(Math.max(0, shown.length - 1));
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                run(shown[active]);
              }
            }}
          />
          <button onClick={onClose} aria-label="Close command palette">
            <kbd>Esc</kbd>
          </button>
        </div>
        <div className="command-search__caption">
          {query
            ? `${shown.length} matching actions`
            : recent.length
              ? 'Recent and available actions'
              : 'Tools, documents and workspace actions'}
        </div>
        <ul
          id="studio-command-results"
          role="listbox"
          aria-label="Commands"
          className="command-search__results"
        >
          {shown.map((command, index) => (
            <li
              role="option"
              id={`command-result-${index}`}
              key={command.id}
              aria-selected={index === active}
              aria-disabled={command.disabled || undefined}
              onPointerMove={() => setCursor(index)}
              onClick={() => run(command)}
            >
              <span className="command-search__glyph">
                <StudioIcon
                  name={
                    command.checked
                      ? 'check'
                      : command.category === 'Tools'
                        ? 'cube'
                        : command.category === 'View'
                          ? 'focus'
                          : 'chevron'
                  }
                />
              </span>
              <span className="command-search__copy">
                <strong>{command.label}</strong>
                {command.hint && <small>{command.hint}</small>}
              </span>
              <span className="command-search__category">
                {command.category ?? 'Workspace'}
              </span>
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </li>
          ))}
        </ul>
        {!shown.length && (
          <div className="command-search__empty">
            <StudioIcon name="search" />
            <h3>No matching action</h3>
            <p>Try a tool, document name, “export” or “world”.</p>
            <button
              onClick={() => {
                setQuery('');
                input.current?.focus();
              }}
            >
              Clear search
            </button>
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
