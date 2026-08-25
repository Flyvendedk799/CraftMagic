/**
 * Block chooser over the whole 499-block registry.
 *
 * Never renders the unfiltered registry. 499 rows is 499 DOM nodes and 499 swatches inside a
 * panel that re-renders on every pointer move over the canvas, and it is unusable as a list
 * anyway — nobody scrolls 499 blocks to find spruce planks. The list stays closed until it
 * is asked for, filters as you type, and shows at most `MAX_RESULTS` matches.
 *
 * Matching is on the block id rather than the display name, because ids are what the search
 * terms people type actually look like (`oak_st`, `deepslate`) and the display name is a
 * mechanical transform of the id anyway.
 *
 * The recents strip is the other half of the tool. Building is not a walk through the
 * registry; it is four or five blocks used over and over, and reaching each of them through
 * open-type-click was most of the clicking anyone did here. Recents are per browser rather
 * than per build: the palette someone reaches for is a habit, not a property of the thing
 * they are working on.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { allBlocks, colorOf, displayName, type BlockRef } from '@craftmagic/core';

/** Enough to make a family visible at a glance, short enough to stay one screen. */
const MAX_RESULTS = 40;

/** One row of swatches at the panel's width. More would wrap and push the list down. */
export const MAX_RECENT = 8;

const RECENT_KEY = 'craftmagic.recentBlocks';

export interface BlockPickerProps {
  value: BlockRef;
  onChange: (block: BlockRef) => void;
}

export function BlockPicker({ value, onChange }: BlockPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => search(query), [query]);

  // The active row is an index into a list that shrinks as you type; clamping it here rather
  // than on every keystroke keeps Enter from selecting whatever happens to be at a stale
  // index after the results narrowed.
  const activeIndex = Math.min(active, Math.max(0, results.blocks.length - 1));

  const choose = useCallback(
    (block: BlockRef) => {
      onChange(block);
      setRecent((prev) => writeRecent(block, prev));
      setOpen(false);
      setQuery('');
      setActive(0);
    },
    [onChange],
  );

  // Recents follow the active block however it was chosen — including Alt+click on the
  // canvas, which is the fastest way to pick one and would otherwise never be remembered.
  useEffect(() => {
    setRecent((prev) => (prev[0] === value ? prev : writeRecent(value, prev)));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(results.blocks.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const picked = results.blocks[activeIndex];
      if (picked) choose(picked);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="picker">
      <button
        type="button"
        className="picker__current"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={value}
      >
        <Swatch block={value} />
        <span className="picker__name">{displayName(value)}</span>
        <span className="picker__caret">{open ? '▴' : '▾'}</span>
      </button>

      {recent.length > 1 && (
        <div className="picker__recent" role="group" aria-label="Recent blocks">
          {recent.map((block) => (
            <button
              key={block}
              type="button"
              className="picker__chip"
              aria-pressed={block === value}
              title={displayName(block)}
              onClick={() => choose(block)}
            >
              <Swatch block={block} />
            </button>
          ))}
        </div>
      )}

      {open && (
        <>
          <input
            className="picker__search"
            type="search"
            value={query}
            placeholder="Search 499 blocks…"
            autoFocus
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onSearchKey}
            aria-label="Search blocks"
          />
          <ul className="picker__list" ref={listRef}>
            {results.blocks.map((id, index) => (
              <li key={id}>
                <button
                  type="button"
                  className="picker__item"
                  aria-pressed={id === value}
                  data-active={index === activeIndex}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(id)}
                >
                  <Swatch block={id} />
                  <span className="picker__name">{displayName(id)}</span>
                </button>
              </li>
            ))}
            {results.blocks.length === 0 && <li className="picker__empty">No block matches.</li>}
          </ul>
          {results.hidden > 0 && (
            <p className="picker__more">+{results.hidden} more — keep typing</p>
          )}
          <p className="picker__more">↑↓ to move · Enter to choose · Esc to close</p>
        </>
      )}
    </div>
  );
}

function Swatch({ block }: { block: BlockRef }) {
  const [r, g, b] = colorOf(block);
  return <span className="picker__swatch" style={{ background: `rgb(${r} ${g} ${b})` }} />;
}

function readRecent(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_RECENT);
  } catch {
    // Storage blocked (private mode, embedded) or holding something that is not a list —
    // an empty strip is a fine outcome for either.
    return [];
  }
}

/** Most recent first, no duplicates. Exported shape is the new list; storage is a side effect. */
export function writeRecent(block: string, prev: readonly string[]): string[] {
  const next = [block, ...prev.filter((entry) => entry !== block)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Not remembering across reloads is survivable; losing the click is not.
  }
  return next;
}

interface SearchResult {
  blocks: string[];
  /** Matches beyond the cap, so the count can say what is not on screen. */
  hidden: number;
}

function search(query: string): SearchResult {
  const needle = query.trim().toLowerCase().replace(/\s+/g, '_');
  const matched: string[] = [];
  const suffixMatched: string[] = [];

  for (const block of allBlocks()) {
    const bare = block.id.slice('minecraft:'.length);
    if (needle === '') {
      matched.push(block.id);
    } else if (bare.startsWith(needle)) {
      // Prefix hits first: typing "oak" should not bury `oak_planks` under `dark_oak_door`.
      matched.push(block.id);
    } else if (bare.includes(needle)) {
      suffixMatched.push(block.id);
    }
  }

  const all = matched.concat(suffixMatched);
  return { blocks: all.slice(0, MAX_RESULTS), hidden: Math.max(0, all.length - MAX_RESULTS) };
}
