/**
 * Sending a world into Minecraft, one region at a time.
 *
 * A world does not go through the mod in one send and could not: the builder bot places a few
 * hundred blocks a second and a region alone is hundreds of thousands of them. So a run is a
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
  type Region,
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
  region: Region,
  index: number,
  total: number,
  agentId: string,
  catalogue: Catalogue,
): Promise<{ jobId: string; blocks: number }> {
  const { rx, rz } = region;
  /*
   * The region, *including its y slab*.
   *
   * `regionsOf` returns one entry per (rx, ry, rz) — a world taller than a single build is
   * cut into stacked slabs — and this used to take a bare rx/rz and call `materializeRegion`
   * with no slab at all. That silently kept the top 160 layers and dropped everything under
   * them (`clippedY`), while the run still counted the slabs it was not sending. A tall world
   * delivered its roof and none of its ground, and said nothing.
   */
  const built = materializeRegion(doc, rx, rz, prefabsOf(catalogue), region);

  const { id: buildId } = await saveToLibrary({
    name: `${doc.name} — region ${rx},${rz}`,
    grid: built.grid,
    // The program is only the placements; the ground is in the grid. Sending it anyway means a
    // region can be reopened in the editor as something with named parts rather than a slab.
    program: built.program,
    detached: false,
    kind: 'structure',
    // Not in the library. It has to exist as a row so the mod can fetch it, but a region is
    // a unit of shipping, not a thing anybody saved.
    library: false,
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
        //
        // `y` was hardcoded to zero while the materialised origin sat right there unused.
        // Harmless while every region bottoms out at the world floor, and wrong the moment one
        // is a slab of a tall world, where each slab starts somewhere different.
        offset: {
          x: built.stats.origin[0],
          y: built.stats.origin[1] - doc.settings.minY,
          z: built.stats.origin[2],
        },
      },
    }),
  });

  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string; error?: string };
  if (!response.ok) {
    // The server distinguishes a refusal from a queue now, and its own words are the ones worth
    // showing: "over the ceiling" and "region 0 has not said where it landed" are different
    // problems with different answers, and both are things the user can act on.
    throw new Error(body.message ?? body.error ?? `could not queue the region (HTTP ${response.status})`);
  }
  return { jobId: body.id ?? '', blocks: built.stats.blocks };
}

/** Every region of a world, in the order they must be sent — slabs and all. */
export function runOf(doc: WorldDoc): Region[] {
  return regionsOf(doc.settings);
}

/**
 * Wait for one job to stop being in flight.
 *
 * The run has to be sequential and the server enforces it twice over: an agent takes one job
 * at a time, and a region after the first is refused until region 0 reports where it landed.
 * So sending a whole world means waiting, and the only thing that knows when a build has
 * finished is the event stream the editor already uses for its progress bar.
 *
 * Resolves rather than rejects on a failed job: the caller is walking a run and needs to stop
 * cleanly with a reason, not unwind through a throw. A stream that simply dies also resolves —
 * pessimistically, as not-done — because a run that hangs forever on a dropped connection is
 * worse than one that stops and says so.
 */
export function waitForJob(
  jobId: string,
  onProgress?: (placed: number, total: number) => void,
): Promise<{ ok: boolean; status: string; error?: string }> {
  return new Promise((resolve) => {
    const source = new EventSource(`/api/agent/jobs/${jobId}/events`);
    let settled = false;
    const finish = (result: { ok: boolean; status: string; error?: string }) => {
      if (settled) return;
      settled = true;
      source.close();
      resolve(result);
    };

    source.onmessage = (event) => {
      const progress = JSON.parse(event.data) as {
        status: string;
        placed?: number;
        total?: number;
        error?: string;
      };
      if (progress.status === 'building' || progress.status === 'offered') {
        onProgress?.(progress.placed ?? 0, progress.total ?? 0);
        return;
      }
      if (progress.status === 'done') finish({ ok: true, status: progress.status });
      else if (progress.status === 'failed' || progress.status === 'cancelled') {
        finish({ ok: false, status: progress.status, error: progress.error });
      }
    };

    source.onerror = () => {
      finish({ ok: false, status: 'disconnected', error: 'lost the connection while building' });
    };
  });
}
