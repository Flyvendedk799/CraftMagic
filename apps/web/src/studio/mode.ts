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
  build: { id: 'build', label: 'Build', hint: 'Blocks, brushes and the voxel editor' },
  arch: { id: 'arch', label: 'Architecture', hint: 'Rooms, storeys and what goes in them' },
  world: { id: 'world', label: 'World', hint: 'Terrain, and your saved builds placed on it' },
};

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
