import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { colorOf, displayName, type BlockRef } from '@craftmagic/core';
import {
  MATERIAL_CATEGORIES,
  findMaterials,
  readFavourites,
  toggleFavourite,
  type MaterialCategory,
} from './materials.js';
import { StudioIcon } from './Icon.js';
export const MaterialBrowser = memo(function MaterialBrowser({
  value,
  onChange,
}: {
  value: BlockRef;
  onChange: (block: BlockRef) => void;
}) {
  const [query, setQuery] = useState(''),
    [category, setCategory] = useState<MaterialCategory>('all'),
    [limit, setLimit] = useState(48);
  const [favourites, setFavourites] = useState(() => {
    try {
      return readFavourites(
        localStorage.getItem('craftmagic.workspace.materialFavourites'),
      );
    } catch {
      return [];
    }
  });
  const [storageError, setStorageError] = useState(false);
  const found = useMemo(
    () => findMaterials(query, category, favourites),
    [query, category, favourites],
  );
  useEffect(() => setLimit(48), [query, category]);
  const favourite = (id: string) =>
    setFavourites((current) => {
      const next = toggleFavourite(current, id);
      try {
        localStorage.setItem(
          'craftmagic.workspace.materialFavourites',
          JSON.stringify(next),
        );
        setStorageError(false);
      } catch {
        setStorageError(true);
      }
      return next;
    });
  return (
    <div className="material-browser">
      <header>
        <StudioIcon name="cube" />
        <div>
          <strong>Block library</strong>
          <small>Choose a material for the active tool</small>
        </div>
      </header>
      <input
        type="search"
        aria-label="Search material library"
        placeholder="Search blocks…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div
        className="material-browser__filters"
        role="group"
        aria-label="Material categories"
      >
        {MATERIAL_CATEGORIES.map((entry) => (
          <button
            key={entry.id}
            aria-pressed={entry.id === category}
            onClick={() => setCategory(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <p className="material-browser__active">
        Active <strong>{displayName(value)}</strong>
      </p>
      <div
        className="material-browser__grid"
        role="list"
        aria-label="Materials"
      >
        {found.slice(0, limit).map((block) => {
          const [r, g, b] = colorOf(block.id);
          return (
            <div
              role="listitem"
              key={block.id}
              className="material-browser__tile"
              data-selected={value === block.id}
            >
              <button
                className="material-browser__choose"
                aria-label={`Use ${block.label}`}
                aria-pressed={value === block.id}
                title={block.id}
                onClick={() => onChange(block.id)}
              >
                <span
                  className="material-browser__cube"
                  style={
                    { '--material': `rgb(${r} ${g} ${b})` } as CSSProperties
                  }
                />
                <span>{block.label}</span>
              </button>
              <button
                className="material-browser__favourite"
                aria-label={`${favourites.includes(block.id) ? 'Unfavourite' : 'Favourite'} ${block.label}`}
                aria-pressed={favourites.includes(block.id)}
                onClick={() => favourite(block.id)}
              >
                {favourites.includes(block.id) ? '★' : '☆'}
              </button>
            </div>
          );
        })}
      </div>
      {!found.length && (
        <p className="material-browser__empty">
          {category === 'favourites'
            ? 'Star a block to keep it here.'
            : 'No blocks match this search.'}
        </p>
      )}
      {found.length > limit && (
        <button
          className="material-browser__more"
          onClick={() => setLimit((n) => Math.min(n + 48, found.length))}
        >
          Show 48 more · {found.length - limit} remaining
        </button>
      )}
      <small>{found.length} matching blocks · colour previews</small>
      {storageError && (
        <p role="status">
          Favourites work this session, but could not be saved on this device.
        </p>
      )}
    </div>
  );
});
