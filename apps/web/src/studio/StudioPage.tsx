/**
 * The studio: one address for three ways of making something.
 *
 * Three modes, not three products. **Build** is the voxel editor — you place blocks and the
 * building is what they add up to. **Architecture** draws rooms and the blocks are a
 * consequence. **World** sculpts terrain and places the other two on it, as saved builds.
 * Build and Architecture compile to the same `BuildProgram` and reach the same exports; World
 * does neither, because a world is a description that materialises into ordinary builds one
 * region at a time — which is the only reason a map can exist at all here.
 *
 * (This paragraph described two modes for a while after there were three, and said that both
 * compiled to a `BuildProgram`. Worth naming: a shell whose own docstring has not noticed a
 * whole mode is a shell that is not being read as the shell.)
 *
 * What the shell owns is which mode is mounted, the switcher pill, and the Ctrl+K palette.
 * Each page renders here *intact* — its own HUD, its own tools, its own autosave. What they no
 * longer each own is the undo stack's machinery and its keybinding: those live in `studio/` so
 * that Ctrl+Z means the same thing whichever pill is lit. Each mode still keeps its own
 * history, so undo in Architecture never unwinds a Build edit.
 *
 * Everything the palette does is a navigation, so a page reacts to a command exactly as it
 * would to a typed URL — which is also why the palette can offer so little for World, whose
 * state is not in the URL at all.
 *
 * Mode lives in the query (`?mode=arch`) rather than the path so that `/editor?build=…` links —
 * the product's main way of spreading — redirect here with their whole query intact and land
 * in the right mode by default.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { STYLE_PACKS } from '@craftmagic/core';
import { BUILD_IDS, generatedBuilds } from '../editor/builds.js';
import { EditorPage } from '../editor/EditorPage.js';
import { ArchitecturePage } from '../architecture/ArchitecturePage.js';
import { WorldPage } from '../world/WorldPage.js';
import { useAuth } from '../library/auth.js';
import { listBuilds, type LibraryBuild } from '../library/library.js';
import { localStore, remoteStore, type SavedWorld } from '../world/api.js';
import { CommandPalette, type Command } from './CommandPalette.js';
import { composeMap, libRef, openGuide, openInBuild, openMap, placeOnMap } from './handoff.js';
import { MODE_SPECS, STUDIO_MODES, foreignParams, modeParam, parseMode, type StudioMode } from './mode.js';
import './studio.css';

/** Enough recent library builds for the palette to offer without becoming the library. */
const PALETTE_LIBRARY_LIMIT = 5;

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
  const auth = useAuth();

  /**
   * What the palette can name that is not in the bundle: the account's maps and its recent
   * library builds. Fetched when the palette opens rather than on mount, because most visits
   * never open it, and kept as plain lists so every command stays a navigation — the map
   * opens through `?world=`, the build arms through `?place=`, exactly as the dashboard's
   * links do.
   */
  const [maps, setMaps] = useState<SavedWorld[]>([]);
  const [libraryBuilds, setLibraryBuilds] = useState<LibraryBuild[]>([]);
  useEffect(() => {
    if (!palette || auth.status === 'loading') return;
    let live = true;
    const store = auth.status === 'signedIn' ? remoteStore : localStore;
    void store.list().then((rows) => live && setMaps(rows), () => undefined);
    if (auth.status === 'signedIn') {
      void listBuilds().then(
        (rows) => live && setLibraryBuilds(
          [...rows].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, PALETTE_LIBRARY_LIMIT),
        ),
        () => undefined,
      );
    } else {
      setLibraryBuilds([]);
    }
    return () => {
      live = false;
    };
  }, [palette, auth.status]);

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
        hint: 'Generated — this browser only',
        run: () => withSearch((params) => {
          params.delete('mode');
          params.set('build', entry.id);
        }),
      });
    }

    // The account's recent library builds: open, guide, or arm on a map. Every one of these
    // carries a `lib:` id, which is the one kind of id that still resolves tomorrow.
    for (const build of libraryBuilds) {
      list.push({
        id: `lib-open-${build.id}`,
        label: `Open build: ${build.name}`,
        hint: 'Library',
        run: () => navigate(openInBuild(libRef(build.id))),
      });
      list.push({
        id: `lib-place-${build.id}`,
        label: `Place on map: ${build.name}`,
        hint: 'World — armed in the Place tool',
        run: () => navigate(placeOnMap(build.id)),
      });
      list.push({
        id: `lib-guide-${build.id}`,
        label: `Open the build guide: ${build.name}`,
        hint: 'Printable, in a new tab',
        run: () => window.open(openGuide(libRef(build.id)), '_blank', 'noreferrer'),
      });
    }

    // Maps. Nothing here reaches into World mode's state: a map opens through `?world=`, the
    // same door the dashboard uses, and the draft is simply the mode with nothing named.
    list.push({
      id: 'world-draft',
      label: 'Open the map draft',
      hint: 'World — whatever was last sculpted in this browser',
      run: () => navigate(composeMap()),
    });
    for (const map of maps) {
      list.push({
        id: `map-${map.id}`,
        label: `Open map: ${map.name}`,
        hint: `World — ${map.sizeX}×${map.sizeZ}, ${map.placements} placed`,
        run: () => navigate(openMap(map.id)),
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
      { id: 'go-dashboard', label: 'Go to the dashboard', hint: 'Account, quota, paired Minecraft, maps', run: () => navigate('/dashboard') },
      { id: 'go-mod', label: 'Go to the Minecraft mod page', hint: 'Pairing and downloads', run: () => navigate('/mod') },
    );

    return list;
  }, [palette, mode, searchParams, navigate, setMode, maps, libraryBuilds]);

  // Resolved once per render rather than inside the JSX: mounting through a variable is what
  // keeps "which page" and "which pill is lit" reading from the same table.
  const Mounted = MODE_PAGES[mode];

  /**
   * Parameters in the address bar that this mode does not read.
   *
   * A pill switch keeps the whole query on purpose — flip to World and back and your `?build=`
   * is still there — but that silence also let a link like `/studio?mode=world&build=lib:x`
   * look as though it had placed the build on the map. It had not. One line says which
   * parameter is waiting for which mode; "Clear" drops it for anyone who meant to move on.
   */
  const foreign = foreignParams(mode, searchParams);
  const foreignKey = `${mode}|${foreign.map((entry) => entry.key).join(',')}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const clearForeign = useCallback(() => {
    setSearchParams(
      (params) => {
        for (const entry of foreign) params.delete(entry.key);
        return params;
      },
      { replace: true },
    );
  }, [foreign, setSearchParams]);

  return (
    <div className="studio">
      <Mounted />

      {foreign.length > 0 && dismissed !== foreignKey && (
        <p className="studio__notice" role="status">
          {describeForeign(foreign)}{' '}
          <button type="button" className="studio__notice-link" onClick={() => setMode(foreign[0]!.owner)}>
            Switch to {MODE_SPECS[foreign[0]!.owner].label}
          </button>
          {' · '}
          <button type="button" className="studio__notice-link" onClick={clearForeign}>
            Clear
          </button>
          <button
            type="button"
            className="studio__notice-close"
            aria-label="Dismiss"
            onClick={() => setDismissed(foreignKey)}
          >
            ×
          </button>
        </p>
      )}

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

/** One sentence, in the visitor's terms rather than the query string's. */
function describeForeign(foreign: ReturnType<typeof foreignParams>): string {
  const first = foreign[0]!;
  const what =
    first.key === 'build'
      ? 'The build in the address bar'
      : first.key === 'plan'
        ? 'The plan in the address bar'
        : first.key === 'place'
          ? 'The build waiting to be placed'
          : first.key === 'world'
            ? 'The map in the address bar'
            : `“${first.key}” in the address bar`;
  const owner = MODE_SPECS[first.owner].label;
  const tail =
    first.owner === 'world' && first.key === 'place'
      ? ' — nothing is placed here.'
      : first.owner === 'build'
        ? ' — it is not on this map or plan.'
        : '.';
  return `${what} belongs to ${owner} mode and is not open here${tail}`;
}
