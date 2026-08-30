/**
 * The studio: one address for both ways of making a building.
 *
 * Two modes, not two products. **Build** is the voxel editor — you place blocks, the building
 * is what the blocks add up to. **Plan** is Architecture mode — you draw rooms, the blocks are a
 * consequence. Both compile to the same `BuildProgram` and reach the same exports, and the
 * fact that they were two routes with two nav entries made them read as two tools when they
 * are two hands of one.
 *
 * The shell owns exactly three things: which mode is mounted, the switcher pill that flips
 * it, and the Ctrl+K command palette. `EditorPage` and `ArchitecturePage` render here *intact* —
 * their HUDs, shortcuts, autosave and undo are untouched, and each keeps its own history
 * (undo in Plan never unwinds a Build edit). Everything the palette does is a navigation, so
 * the pages react to a command exactly as they would to a typed URL.
 *
 * Mode lives in the query (`?mode=plan`) rather than the path so that `/editor?build=…`
 * links — the product's main way of spreading — redirect here with their whole query intact
 * and land in the right mode by default.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { STYLE_PACKS } from '@craftmagic/core';
import { BUILD_IDS, generatedBuilds } from '../editor/builds.js';
import { EditorPage } from '../editor/EditorPage.js';
import { ArchitecturePage } from '../architecture/ArchitecturePage.js';
import { WorldPage } from '../world/WorldPage.js';
import { CommandPalette, type Command } from './CommandPalette.js';
import { MODE_SPECS, STUDIO_MODES, modeParam, parseMode, type StudioMode } from './mode.js';
import './studio.css';

export type { StudioMode } from './mode.js';

/**
 * Which page each mode mounts.
 *
 * A record rather than a chain of ternaries. Two modes fit in a ternary; three is where one
 * gets forgotten in the mount but not the switch, and the symptom is a pill that lights up
 * over the wrong page.
 */
const MODE_PAGES: Readonly<Record<StudioMode, () => JSX.Element>> = {
  build: EditorPage,
  arch: ArchitecturePage,
  world: WorldPage,
};

export function StudioPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const mode = parseMode(searchParams.get('mode'));
  const [palette, setPalette] = useState(false);

  const setMode = useCallback(
    (next: StudioMode) => {
      setSearchParams(
        (params) => {
          // Absent means build — the default every redirected `/editor?…` link relies on.
          const value = modeParam(next);
          if (value === null) params.delete('mode');
          else params.set('mode', value);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Ctrl+K (or ⌘K) from anywhere on the page, text fields included — the palette is how you
  // leave wherever you are, so no context may swallow it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /**
   * The command list, rebuilt when the palette opens.
   *
   * Every command is a navigation into state the pages already read from the URL — builds,
   * style packs, modes, routes — so the palette needs no channel into either page's
   * internals, and a command can never do something a link could not.
   */
  const commands = useMemo<Command[]>(() => {
    if (!palette) return [];
    const withSearch = (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams);
      mutate(params);
      const search = params.toString();
      navigate({ pathname: '/studio', search: search ? `?${search}` : '' });
    };

    // Every mode except the one you are in. This was a ternary offering the single other
    // mode, which with three of them would silently hide one.
    const list: Command[] = STUDIO_MODES.filter((id) => id !== mode).map((id) => ({
      id: `mode-${id}`,
      label: `Switch to ${MODE_SPECS[id].label} mode`,
      hint: MODE_SPECS[id].hint,
      run: () => setMode(id),
    }));

    for (const id of BUILD_IDS) {
      list.push({
        id: `build-${id}`,
        label: `Open build: ${id[0]!.toUpperCase()}${id.slice(1)}`,
        hint: 'Sample',
        // Deleting the mode is what makes this land in Build, which is where a build opens.
        run: () => withSearch((params) => {
          params.delete('mode');
          params.set('build', id);
        }),
      });
    }
    // Recent generations, newest first — the builds someone actually comes back for.
    for (const entry of generatedBuilds().slice(-3).reverse()) {
      list.push({
        id: `build-${entry.id}`,
        label: `Open build: ${entry.name}`,
        hint: 'Generated',
        run: () => withSearch((params) => {
          params.delete('mode');
          params.set('build', entry.id);
        }),
      });
    }

    if (mode === 'build') {
      for (const pack of STYLE_PACKS) {
        list.push({
          id: `style-${pack.id}`,
          label: `Restyle: ${pack.label}`,
          hint: pack.description,
          run: () => withSearch((params) => params.set('style', pack.id)),
        });
      }
      list.push({
        id: 'style-off',
        label: 'Restyle: original materials',
        hint: 'Back to the build’s own palette',
        run: () => withSearch((params) => params.delete('style')),
      });
      list.push({
        id: 'guide',
        label: 'Open the build guide',
        hint: 'Printable, layer by layer, in a new tab',
        run: () => {
          const params = new URLSearchParams(searchParams);
          params.delete('mode');
          window.open(`/guide?${params.toString()}`, '_blank', 'noreferrer');
        },
      });
    }

    list.push(
      { id: 'go-library', label: 'Go to the library', hint: 'Saved builds', run: () => navigate('/library') },
      { id: 'go-dashboard', label: 'Go to the dashboard', hint: 'Account, quota, worlds', run: () => navigate('/dashboard') },
      { id: 'go-mod', label: 'Go to the Minecraft mod page', hint: 'Pairing and downloads', run: () => navigate('/mod') },
    );

    return list;
  }, [palette, mode, searchParams, navigate, setMode]);

  // Resolved once per render rather than inside the JSX: mounting through a variable is what
  // keeps "which page" and "which pill is lit" reading from the same table.
  const Mounted = MODE_PAGES[mode];

  return (
    <div className="studio">
      <Mounted />

      <div className="studio__switch" role="group" aria-label="Studio mode">
        {STUDIO_MODES.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={mode === id}
            title={MODE_SPECS[id].hint}
            onClick={() => setMode(id)}
          >
            {MODE_SPECS[id].label}
          </button>
        ))}
        <button
          type="button"
          className="studio__palette-key"
          title="Command palette  (Ctrl+K)"
          onClick={() => setPalette(true)}
        >
          ⌘K
        </button>
      </div>

      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
    </div>
  );
}
