/**
 * How much of the building the model shows.
 *
 * A finished building is opaque. That is the point of a building and it is the problem with
 * previewing one: the moment a plan has more than one room, the thing you drew is behind a
 * wall, and the moment it has more than one storey, half of it is behind a floor. The
 * layouter had one control for this — a checkbox that cut everything above the storey you
 * were editing — which lets you look *down* onto a stack of floors and still leaves every
 * room enclosed by its own four walls.
 *
 * So there are three ways to look at it, and they are three answers to three different
 * questions:
 *
 *   **Whole** — what does it look like? The building as it will be built, no cuts.
 *   **Storey** — how does this floor work? One storey, its slab and its walls, cut top and
 *     bottom. A doll's house: every room on the level open to the sky at once.
 *   **Room** — is this room right? One room, its own four walls, framed so it fills the view.
 *
 * Pure, and separate from the page, because the boxes are arithmetic on the plan's own storey
 * layout — `foundation + i * storeyHeight` and so on — and getting that wrong by one block
 * either slices the floor slab off the storey you are looking at or leaves the ceiling on.
 * That is a thing to unit-test, not to eyeball in a viewport.
 */

import type { FocusBox } from '../editor/EditorCanvas.js';
import type { ClipBox } from '../editor/VoxelWorld.js';
import { itemFootprint } from './geometry.js';
import { floorHeight, slabY, type LayoutPlan, type PlanItem } from './plan.js';

export type ModelMode = 'whole' | 'storey' | 'room';

export const MODEL_MODES: readonly { id: ModelMode; label: string; hint: string }[] = [
  { id: 'whole', label: 'Whole', hint: 'The building as it will be built' },
  { id: 'storey', label: 'Storey', hint: 'This storey alone, with its ceiling off' },
  { id: 'room', label: 'Room', hint: 'The selected room alone, framed close' },
];

/**
 * The block band one storey occupies.
 *
 * The slab is the *first* block of the storey and the ceiling is the first block of the next
 * one, so the band runs from the slab to one below the slab above: keep the floor you stand
 * on, lose the lid. Getting this off by one is the difference between a doll's house and a
 * storey with no floor.
 */
export function storeyBand(plan: LayoutPlan, floorIndex: number): { min: number; max: number } {
  const base = slabY(plan, floorIndex);
  return { min: base, max: base + floorHeight(plan, floorIndex) - 1 };
}

export interface ModelViewInput {
  plan: LayoutPlan;
  mode: ModelMode;
  floorIndex: number;
  /** The selection, if it is on the storey being viewed. Only rooms can be isolated. */
  selected: PlanItem | null;
  /** Size of the compiled grid, so a cut never claims a block the build does not have. */
  grid: { x: number; y: number; z: number };
  /**
   * Plan coordinate of the grid's (0,0).
   *
   * The compiler crops the build to what is drawn plus an eave, so a room at plan x=30 can be
   * at grid x=2. Every horizontal face below is in *grid* space for that reason, and the
   * mistake this exists to prevent is silent: a clip box in plan coordinates lands on empty
   * air beside the building and the viewport renders nothing at all.
   */
  origin: { x: number; z: number };
}

export interface ModelView {
  clip: ClipBox | null;
  /** What the camera should frame, or null to leave it framing the whole build. */
  focus: FocusBox | null;
  /** Why the requested mode is not in force, if it is not. Shown under the buttons. */
  fallback: string | null;
}

/**
 * Resolve a mode into a cut and a camera framing.
 *
 * Room mode degrades rather than refusing: with nothing selected, or with something selected
 * that is not a room, it shows the storey and says so. A mode that silently showed the whole
 * building instead would look like the button was broken, and one that greyed itself out
 * would make the user work out the precondition from an absence.
 */
export function modelView({ plan, mode, floorIndex, selected, grid, origin }: ModelViewInput): ModelView {
  if (mode === 'whole') return { clip: null, focus: null, fallback: null };

  const band = storeyBand(plan, floorIndex);
  // Y needs no translation: the grid's y=0 is the bottom of the foundation in both spaces.
  const top = Math.min(band.max, Math.max(0, grid.y - 1));
  const storeyClip: ClipBox = { minY: band.min, maxY: top };

  if (mode === 'storey') return { clip: storeyClip, focus: null, fallback: null };

  if (!selected) {
    return { clip: storeyClip, focus: null, fallback: 'Select a room on the plan to look inside it.' };
  }
  if (selected.kind !== 'room') {
    return {
      clip: storeyClip,
      focus: null,
      fallback: `A ${selected.kind} is not a room — showing the whole storey.`,
    };
  }

  const rect = itemFootprint(selected, plan.wallThickness, floorHeight(plan, floorIndex));
  // Into grid space, then clamped: a room drawn against the site edge can sit outside the
  // cropped build once the eave padding is accounted for, and a clip box that starts past the
  // far edge of the grid hides everything.
  const minX = clamp(rect.x - origin.x, 0, grid.x - 1);
  const maxX = clamp(rect.x + rect.w - 1 - origin.x, minX, grid.x - 1);
  const minZ = clamp(rect.z - origin.z, 0, grid.z - 1);
  const maxZ = clamp(rect.z + rect.d - 1 - origin.z, minZ, grid.z - 1);

  return {
    clip: { ...storeyClip, minX, maxX, minZ, maxZ },
    focus: { min: { x: minX, y: band.min, z: minZ }, max: { x: maxX, y: top, z: maxZ } },
    fallback: null,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
