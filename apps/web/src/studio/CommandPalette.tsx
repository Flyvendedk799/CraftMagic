/**
 * The Ctrl+K palette: every studio destination behind one keystroke.
 *
 * A flat, filtered list — no nesting, no categories to navigate. The commands are assembled
 * by the page from what the product already exposes (URL-addressable builds, style packs,
 * routes), so the palette holds no state of its own and cannot drift from the pages it
 * drives: executing a command is a navigation, and the page that owns the thing reacts to
 * its URL exactly as if the user had typed it.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

export interface Command {
  id: string;
  /** What the row says. Matching runs on this plus `hint`. */
  label: string;
  /** Quieter second line — a description, a shortcut, a destination. */
  hint?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  commands: readonly Command[];
  onClose: () => void;
}

export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const shown = useMemo(() => {
    // Every word must land somewhere, but each independently: "restyle gothic" has to find
    // "Restyle: Gothic keep" even though the two words are not adjacent in the label.
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return commands;
    return commands.filter((command) => {
      const haystack = `${command.label} ${command.hint ?? ''}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [commands, query]);

  // The cursor follows the filter: a selection pointing past the end of a shrunken list
  // would make Enter run nothing, which reads as the palette being broken.
  const active = Math.min(cursor, Math.max(0, shown.length - 1));

  const run = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  return (
    <div className="palette" role="dialog" aria-label="Command palette" onClick={onClose}>
      <div className="palette__panel" onClick={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          type="text"
          placeholder="Type a command — build, style, mode, page…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setCursor(Math.min(active + 1, shown.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setCursor(Math.max(active - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              run(shown[active]);
            }
          }}
        />
        <ul className="palette__list" role="listbox">
          {shown.map((command, index) => (
            <li key={command.id}>
              <button
                type="button"
                className="palette__row"
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setCursor(index)}
                onClick={() => run(command)}
              >
                <span className="palette__label">{command.label}</span>
                {command.hint && <span className="palette__hint">{command.hint}</span>}
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="palette__empty">Nothing matches “{query}”.</li>}
        </ul>
      </div>
    </div>
  );
}
