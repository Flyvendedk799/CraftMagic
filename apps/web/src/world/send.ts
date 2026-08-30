/**
 * Sending a world into Minecraft, one region at a time.
 *
 * A world does not go through the mod in one send and could not: the builder bot places 400
 * blocks a tick — 8,000 a second — and a region alone is millions of blocks. So a run is a
 * queue of ordinary builds, each materialised on demand, and the only thing that makes them a
 * map rather than sixteen buildings in a heap is the region metadata riding alongside.
 *
 * The ordering is not a nicety either. Region 0 is placed by the player, the way any build is,
 * and reports back where it actually landed; every region after it is measured from that
 * report. The server refuses to offer region *n* until that anchor is in, so this walks the
 * run in order and waits for each to finish rather than firing them all at the agent.
 *
 * Regions are saved with `kind: 'structure'` and land in the library like anything else. That
 * is deliberate — a region is an ordinary build, which is exactly why the schematic writer,
 * the guide and the mod all take one without knowing worlds exist.
 */

import {
  materializeRegion,
  regionsOf,
  type Prefab,
  type WorldDoc,
} from '@craftmagic/core';
import { saveToLibrary } from '../library/library.js';
import type { Catalogue } from '../library/components.js';

export interface RegionSendProgress {
  /** Zero-based index in the run. */
  index: number;
  total: number;
  rx: number;
  rz: number;
  blocks: number;
  stage: 'materialising' | 'saving' | 'queued' | 'done' | 'error';
  message?: string;
}

/** The prefab table `materializeRegion` wants, re-keyed from the loaded component catalogue. */
export function prefabsOf(catalogue: Catalogue): Map<string, Prefab> {
  const map = new Map<string, Prefab>();
  for (const [id, component] of catalogue) map.set(id, component.prefab);
  return map;
}

/**
 * Materialise one region and queue it on an agent.
 *
 * Returns the job id, so a caller can follow its progress on the same event stream a lone
 * build uses. Throws with the server's own message rather than a generic one: the two
 * refusals that matter here — the agent is busy, and region 0 has not reported yet — are both
 * things the user can act on, and flattening them into "could not send" would hide that.
 */
export async function sendRegion(
  doc: WorldDoc,
  rx: number,
  rz: number,
  index: number,
  total: number,
  agentId: string,
  catalogue: Catalogue,
): Promise<{ jobId: string; blocks: number }> {
  const built = materializeRegion(doc, rx, rz, prefabsOf(catalogue));

  const { id: buildId } = await saveToLibrary({
    name: `${doc.name} — region ${rx},${rz}`,
    grid: built.grid,
    // The program is only the placements; the ground is in the grid. Sending it anyway means a
    // region can be reopened in the editor as something with named parts rather than a slab.
    program: built.program,
    detached: false,
    kind: 'structure',
  });

  const response = await fetch('/api/agent/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId,
      buildId,
      region: {
        worldId: doc.id,
        index,
        total,
        rx,
        rz,
        // Blocks from the world's own origin. The mod turns this by however the player rotated
        // region 0 before adding it to the anchor, so a map placed at an angle stays a map.
        offset: {
          x: built.stats.origin[0],
          y: 0,
          z: built.stats.origin[2],
        },
      },
    }),
  });

  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string; error?: string };
  if (!response.ok) {
    throw new Error(body.message ?? body.error ?? `could not queue the region (HTTP ${response.status})`);
  }
  return { jobId: body.id ?? '', blocks: built.stats.blocks };
}

/** Every region of a world, in the order they must be sent. */
export function runOf(doc: WorldDoc): Array<{ rx: number; rz: number; index: number; total: number }> {
  const regions = regionsOf(doc.settings);
  return regions.map((region, index) => ({
    rx: region.rx,
    rz: region.rz,
    index,
    total: regions.length,
  }));
}
