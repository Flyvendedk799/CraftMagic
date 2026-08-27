/**
 * A saved build, as a picture.
 *
 * Three states and all three are drawn, because the frame has to hold its size from the
 * first paint: a card grid whose images pop in at their natural height reflows the whole
 * page under the pointer as the renders land. Idle and loading share a shimmer, failure
 * falls back to the build's silhouette in outline — still a picture, still the right shape,
 * and it says "no render" without saying "error" about something nobody asked for.
 *
 * Shared by the library and the dashboard rather than owned by either. They show the same
 * builds, and two thumbnails of one build that disagreed about framing or size would look
 * like two different things.
 */

import { useThumbnail } from './thumbnail.js';
import type { LibraryBuild } from './library.js';
import './thumb.css';

export interface BuildThumbProps {
  build: LibraryBuild;
  /** `card` fills a wide frame above a title; `row` is the small square beside a list row. */
  variant?: 'card' | 'row';
}

export function BuildThumb({ build, variant = 'card' }: BuildThumbProps) {
  const [state, ref] = useThumbnail(build.id, build.updatedAt);

  return (
    <div className="thumb" data-variant={variant} data-state={state.status} ref={ref}>
      {state.status === 'ready' ? (
        <img
          className="thumb__img"
          src={state.src}
          // The name is already beside every one of these, so announcing it again is noise
          // in a screen reader. What the picture adds is the shape, and a raster of a voxel
          // model cannot be described; it is decoration for that reader.
          alt=""
          loading="lazy"
          draggable={false}
        />
      ) : (
        <span className="thumb__placeholder" aria-hidden="true">
          <ProxyBox size={build} />
        </span>
      )}
    </div>
  );
}

/**
 * The build's bounding box, drawn isometrically at its real proportions.
 *
 * Stands in for the render before it arrives and instead of it if it never does. Proportions
 * from the actual size, so a tower is tall here too — the placeholder is the first thing
 * that tells a squat cottage from a watchtower, and a generic grey rectangle would tell
 * neither.
 */
function ProxyBox({ size }: { size: { sizeX: number; sizeY: number; sizeZ: number } }) {
  // Isometric unit vectors: x goes down-right, z down-left, y straight up.
  const unit = 22 / Math.max(size.sizeX, size.sizeY, size.sizeZ, 1);
  const w = size.sizeX * unit;
  const h = size.sizeY * unit;
  const d = size.sizeZ * unit;

  // Screen offsets for one block along each axis, at the 2:1 isometric the renders use.
  const p = (x: number, y: number, z: number): string =>
    `${(x - z) * 0.866},${-y + (x + z) * 0.5}`;

  const top = `${p(0, h, 0)} ${p(w, h, 0)} ${p(w, h, d)} ${p(0, h, d)}`;
  const left = `${p(0, h, d)} ${p(w, h, d)} ${p(w, 0, d)} ${p(0, 0, d)}`;
  const right = `${p(w, h, 0)} ${p(w, h, d)} ${p(w, 0, d)} ${p(w, 0, 0)}`;

  return (
    <svg className="thumb__proxy" viewBox="-30 -34 60 60" role="presentation">
      <polygon points={top} className="thumb__face thumb__face--top" />
      <polygon points={left} className="thumb__face thumb__face--left" />
      <polygon points={right} className="thumb__face thumb__face--right" />
    </svg>
  );
}
