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
 */

import { useMemo, useState } from 'react';
import { allBlocks, colorOf, displayName, type BlockRef } from '@craftmagic/core';

/** Enough to make a family visible at a glance, short enough to stay one screen. */
const MAX_RESULTS = 40;

export interface BlockPickerProps {
  value: BlockRef;
  onChange: (block: BlockRef) => void;
}

export function BlockPicker({ value, onChange }: BlockPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const results = useMemo(() => search(query), [query]);

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

      {open && (
        <>
          <input
            className="picker__search"
            type="search"
            value={query}
            placeholder="Search 499 blocks…"
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search blocks"
          />
          <ul className="picker__list">
            {results.blocks.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  className="picker__item"
                  aria-pressed={id === value}
                  onClick={() => {
                    onChange(id);
                    setOpen(false);
                  }}
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
        </>
      )}
    </div>
  );
}

function Swatch({ block }: { block: BlockRef }) {
  const [r, g, b] = colorOf(block);
  return <span className="picker__swatch" style={{ background: `rgb(${r} ${g} ${b})` }} />;
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
