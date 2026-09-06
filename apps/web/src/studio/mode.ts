/**
 * Which of the studio's modes is on screen, and how that survives a URL.
 *
 * Extracted from `StudioPage` for one reason: it is the only part of the shell that can break
 * a link somebody already shared, and a pure function is a thing a test can pin. The mode used
 * to be a ternary — `get('mode') === 'plan' ? 'plan' : 'build'` — which was fine for two modes
 * and becomes a silent bug for three, because every value it does not recognise lands the
 * visitor in Build without saying so.
 *
 * `plan` is kept as an alias for Architecture forever. It is the value in every link shared
 * while the mode was called the layouter, and those links are how this product spreads.
 * Absent still means Build, because that is what every redirected `/editor?…` link relies on.
 */

export type StudioMode = 'build' | 'arch' | 'world';

export const STUDIO_MODES: readonly StudioMode[] = ['build', 'arch', 'world'];

export interface StudioModeSpec {
  id: StudioMode;
  label: string;
  /** What this mode is for, on the switch and in the command palette. */
  hint: string;
}

export const MODE_SPECS: Readonly<Record<StudioMode, StudioModeSpec>> = {
  build: { id: 'build', label: 'Build', hint: 'Make a structure: blocks, brushes and the voxel editor' },
  arch: { id: 'arch', label: 'Architecture', hint: 'Draw a floorplan: rooms, storeys and what goes in them' },
  world: { id: 'world', label: 'World', hint: 'Compose a map: sculpt terrain and place your saved builds on it' },
};

/**
 * Which query parameters each mode reads, so the shell can say when it is ignoring one.
 *
 * Switching the pill keeps the whole query — that is what lets Build get its `?build=` back
 * after a look at World — but it also means a visitor who lands in World with a build in the
 * address bar sees nothing happen and no word about why. `mode` is the shell's own and belongs
 * to nobody here. Build's `p.*` and `s.*` families are matched by prefix in `ownsParam`.
 */
export const MODE_PARAMS: Readonly<Record<StudioMode, readonly string[]>> = {
  build: ['build', 'layer', 'only', 'style', 'prompt'],
  arch: ['plan'],
  world: ['world', 'place'],
};

export function ownsParam(mode: StudioMode, key: string): boolean {
  if (MODE_PARAMS[mode].includes(key)) return true;
  return mode === 'build' && (key.startsWith('p.') || key.startsWith('s.'));
}

/** A parameter in the query that another mode reads and this one does not. */
export interface ForeignParam {
  key: string;
  owner: StudioMode;
}

/**
 * The parameters in the query that belong to a mode other than the one on screen.
 *
 * Keys nobody owns are not reported: an unknown parameter is not a claim about any mode, and
 * flagging it would nag about links from tools this shell has never heard of.
 */
export function foreignParams(mode: StudioMode, params: URLSearchParams): ForeignParam[] {
  const out: ForeignParam[] = [];
  for (const key of new Set(params.keys())) {
    if (ownsParam(mode, key)) continue;
    const owner = STUDIO_MODES.find((other) => other !== mode && ownsParam(other, key));
    if (owner) out.push({ key, owner });
  }
  return out;
}

/**
 * The `?mode=` value, read generously.
 *
 * A whitelist rather than a comparison, so an unknown value cannot quietly mean Build — and so
 * the aliases are declared in one place instead of accumulating across the file.
 */
export function parseMode(raw: string | null | undefined): StudioMode {
  switch (raw) {
    case 'plan':
    case 'arch':
    case 'architecture':
    case 'layouter':
      return 'arch';
    case 'world':
      return 'world';
    default:
      return 'build';
  }
}

/**
 * What to write back, or null to delete the parameter.
 *
 * Build writes nothing at all. Keeping the default absent is what lets `/editor?build=gen:3`
 * redirect into the studio and land where it always did, and it keeps a shared link free of a
 * parameter that means "the normal one".
 */
export function modeParam(mode: StudioMode): string | null {
  return mode === 'build' ? null : mode;
}
