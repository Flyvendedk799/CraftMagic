/**
 * World mode.
 *
 * The third tier. Build makes a structure; Architecture makes what is inside one; World is
 * where saved builds become the components of something much larger — a spawn hub, a map, an
 * environment — standing on terrain you sculpt.
 *
 * A world can never be one `VoxelGrid`. At 1024×160×1024 that is 320 MB and 40,960 mesh
 * chunks, against a renderer that meshes every chunk at load and keeps every mesh in the scene
 * forever. So a world is a *description* — a heightfield, a sparse overlay for the caves and
 * overhangs a heightfield cannot express, and a list of placements — which materialises into
 * an ordinary grid one region at a time. That is also exactly the shape region-by-region
 * delivery needs, so the two constraints agree with each other.
 *
 * This is the shell. The document model lands in `packages/core/src/world/`, and the terrain
 * tools and the parts bin follow.
 */

import { AppNav } from '../shell/AppNav.js';
import './world.css';

export function WorldPage() {
  return (
    <div className="world">
      <AppNav current="world" />

      <section className="hud world__panel">
        <h1 className="hud__title">World</h1>
        <p className="hud__sub">Terrain, and your saved builds placed on it</p>

        <div className="world__soon">
          <p>
            This is where a spawn hub gets assembled: sculpt the ground, then place the builds
            you have saved — as many copies as you like, turned however you like.
          </p>
          <p>
            <strong>Terrainer</strong> paints ground materials along a drag.{' '}
            <strong>Leveler</strong> raises and lowers it into hills and mountains.{' '}
            <strong>Carve</strong> cuts the tunnels and overhangs a heightfield cannot describe.
          </p>
          <p className="world__note">
            The finished world goes into Minecraft a region at a time — the builder bot places
            8,000 blocks a second, so a map is a queue rather than a single send.
          </p>
        </div>
      </section>

      <div className="world__stage">
        <p className="world__empty">The plot appears here.</p>
      </div>
    </div>
  );
}
