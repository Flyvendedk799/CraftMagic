/**
 * What the viewport shows, as opposed to what the build *is*.
 *
 * Deliberately separate from the URL state. `?build=` and `?p.height=` describe a build and
 * are worth sharing; where the camera happens to be pointing and whether the ground grid is
 * on are preferences about *looking* at one. Putting them in the query string would make
 * every shared link carry someone else's camera, and putting them in React state alone would
 * make them evaporate on reload — so they live in localStorage, per browser, and never
 * travel.
 */

/** A canonical camera angle. `frame` re-fits the current one without rotating. */
export type CameraPreset = 'frame' | 'iso' | 'front' | 'side' | 'top';

/**
 * A camera move, as a command rather than a state.
 *
 * The camera is owned by OrbitControls once the user drags it, so "the view is iso" stops
 * being true the moment they move. Pressing Front twice in a row still has to work, which is
 * why this carries a nonce: the canvas reacts to a *new command*, not to a changed value.
 */
export interface ViewCommand {
  preset: CameraPreset;
  nonce: number;
}

export interface DisplayOptions {
  /** The ground grid under the build. */
  grid: boolean;
  /** The wireframe box around the build volume. */
  bounds: boolean;
  /** The hover highlight — off for screenshots and for people who find it noisy. */
  highlight: boolean;
}

export const DEFAULT_DISPLAY: DisplayOptions = { grid: true, bounds: true, highlight: true };

const STORAGE_KEY = 'craftmagic.display';

export function readDisplay(): DisplayOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DISPLAY;
    const parsed = JSON.parse(raw) as Partial<DisplayOptions>;
    return {
      grid: parsed.grid ?? DEFAULT_DISPLAY.grid,
      bounds: parsed.bounds ?? DEFAULT_DISPLAY.bounds,
      highlight: parsed.highlight ?? DEFAULT_DISPLAY.highlight,
    };
  } catch {
    // Blocked storage or a hand-mangled value: the defaults are always a usable view.
    return DEFAULT_DISPLAY;
  }
}

export function writeDisplay(display: DisplayOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(display));
  } catch {
    // Not remembering is survivable; refusing to toggle is not.
  }
}

/**
 * The visible slice of the build, as a closed range of layers.
 *
 * `null` means the whole thing, which is not the same as `0..top`: only the null case can
 * skip clipping entirely, and only it survives a build changing height without silently
 * hiding the new top of the structure.
 */
export interface LayerRange {
  min: number;
  max: number;
}

/**
 * Read `?layer=` / `?layer0=` into a range, clamped to a build that may have changed height.
 *
 * A stale or hand-edited link must not be able to clip the whole structure away, so an
 * inverted or out-of-range pair is repaired rather than rejected.
 */
export function readLayerRange(
  rawMax: string | null,
  rawMin: string | null,
  topLayer: number,
): LayerRange | null {
  if (rawMax === null && rawMin === null) return null;

  const clamp = (value: number) => Math.min(topLayer, Math.max(0, value));
  const parse = (raw: string | null, fallback: number) => {
    const value = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(value) ? clamp(value) : fallback;
  };

  const max = parse(rawMax, topLayer);
  const min = parse(rawMin, 0);
  return min <= max ? { min, max } : { min: max, max: min };
}

/** True when a range shows everything there is — i.e. when clipping is pointless. */
export function isWholeBuild(range: LayerRange | null, topLayer: number): boolean {
  return range === null || (range.min <= 0 && range.max >= topLayer);
}
