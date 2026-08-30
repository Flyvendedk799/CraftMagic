/**
 * The studio: one address for both ways of making a building.
 *
 * Two modes, not two products. **Build** is the voxel editor — you place blocks, the building
 * is what the blocks add up to. **Plan** is the layouter — you draw rooms, the blocks are a
 * consequence. Both compile to the same `BuildProgram` and reach the same exports, and the
 * fact that they were two routes with two nav entries made them read as two tools when they
 * are two hands of one.
 *
 * The shell owns exactly three things: which mode is mounted, the switcher pill that flips
 * it, and the Ctrl+K command palette. `EditorPage` and `LayouterPage` render here *intact* —
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
import { LayouterPage } from '../layouter/LayouterPage.js';
import { CommandPalette, type Command } from './CommandPalette.js';
import './studio.css';

export type StudioMode = 'build' | 'plan';

export function StudioPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const mode: StudioMode = searchParams.get('mode') === 'plan' ? 'plan' : 'build';
  const [palette, setPalette] = useState(false);

  const setMode = useCallback(
    (next: StudioMode) => {
      setSearchParams(
        (params) => {
          // Absent means build — the default every redirected `/editor?…` link relies on.
          if (next === 'plan') params.set('mode', 'plan');
          else params.delete('mode');
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

    const list: Command[] = [
      mode === 'plan'
        ? {
            id: 'mode-build',
            label: 'Switch to Build mode',
            hint: 'Blocks, brushes and the voxel editor',
            run: () => setMode('build'),
          }
        : {
            id: 'mode-plan',
            label: 'Switch to Plan mode',
            hint: 'Rooms, storeys and the floorplan tool',
            run: () => setMode('plan'),
          },
    ];

    for (const id of BUILD_IDS) {
      list.push({
        id: `build-${id}`,
        label: `Open build: ${id[0]!.toUpperCase()}${id.slice(1)}`,
        hint: 'Sample',
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

  return (
    <div className="studio">
      {mode === 'plan' ? <LayouterPage /> : <EditorPage />}

      <div className="studio__switch" role="group" aria-label="Studio mode">
        <button
          type="button"
          aria-pressed={mode === 'build'}
          title="The voxel editor — place blocks"
          onClick={() => setMode('build')}
        >
          Build
        </button>
        <button
          type="button"
          aria-pressed={mode === 'plan'}
          title="The layouter — draw rooms"
          onClick={() => setMode('plan')}
        >
          Plan
        </button>
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
