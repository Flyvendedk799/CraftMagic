/**
 * Everything the dashboard shows about an account, in one hook.
 *
 * Four requests, fired together rather than in sequence: the build list, the map list, the
 * job summary and the spend summary are independent, and awaiting one before starting the
 * next multiplies the time the page spends as an empty frame for no reason. Paired Minecraft
 * comes from `useAgents`, which the editor's "Send to game" panel already owns — the
 * dashboard borrows it rather than growing a second, slightly different idea of what a
 * paired agent is.
 *
 * Failure is per-panel and never fatal. A dashboard that renders a single error where six
 * cards should be is a worse answer than a dashboard that draws five of them and says which
 * one is missing, especially when the failure is `/api/spend` on a deployment where nobody
 * configured a budget.
 */

import { useCallback, useEffect, useState } from 'react';
import { listBuilds, type LibraryBuild } from '../library/library.js';
import { listWorlds, type SavedWorld } from '../world/api.js';
import type { SpendSummary } from '../generate/useGeneration.js';

/**
 * The one honest signal the onboarding finale needs: how many sends actually finished.
 *
 * Served by `GET /api/agent/jobs/summary`, which counts this account's jobs in `done`. Not
 * "a Minecraft world has been online", which would tick for somebody who paired and then
 * closed the game without ever sending anything.
 */
export interface JobSummary {
  successful: number;
  lastSuccessAt: string | null;
}

export interface DashboardData {
  builds: LibraryBuild[];
  /** Maps saved to the account, without their heightfields. Empty while signed out. */
  maps: SavedWorld[];
  /** Null while loading, and after a failure the page reports in place. */
  spend: SpendSummary | null;
  /** Null until it arrives, and on a server without a database. */
  jobs: JobSummary | null;
  loading: boolean;
  /** The build list only. The others failing quietly is not worth an alert. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function useDashboard(enabled: boolean): DashboardData {
  const [builds, setBuilds] = useState<LibraryBuild[]>([]);
  const [maps, setMaps] = useState<SavedWorld[]>([]);
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [jobs, setJobs] = useState<JobSummary | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      // Signed out is a real, complete state — not a pending one. Left loading, the page
      // would sit on skeletons forever for exactly the visitor who needs the sign-up form.
      setBuilds([]);
      setMaps([]);
      setSpend(null);
      setJobs(null);
      setLoading(false);
      return;
    }

    const [listed, worlds, spent, summary] = await Promise.allSettled([
      listBuilds(),
      listWorlds(),
      fetch('/api/spend').then((response) => (response.ok ? response.json() : null)),
      fetch('/api/agent/jobs/summary').then((response) => (response.ok ? response.json() : null)),
    ]);

    if (listed.status === 'fulfilled') {
      setBuilds(listed.value);
      setError(null);
    } else {
      setError((listed.reason as Error).message);
    }
    setMaps(worlds.status === 'fulfilled' ? worlds.value : []);
    setSpend(spent.status === 'fulfilled' ? (spent.value as SpendSummary | null) : null);
    setJobs(summary.status === 'fulfilled' ? (summary.value as JobSummary | null) : null);
    setLoading(false);
  }, [enabled]);

  useEffect(() => {
    setLoading(enabled);
    void refresh();
  }, [enabled, refresh]);

  return { builds, maps, spend, jobs, loading, error, refresh };
}

/** Blocks across every saved build — the one number that grows with use. */
export function totalBlocks(builds: LibraryBuild[]): number {
  return builds.reduce((sum, build) => sum + build.blockCount, 0);
}

/**
 * Newest first, capped.
 *
 * The server's order is not part of its contract, and "recent" is the whole promise of the
 * card, so this sorts rather than trusts. `updatedAt`, not `createdAt`: renaming a build is
 * how someone tells you which one they care about.
 */
export function recentBuilds(builds: LibraryBuild[], limit: number): LibraryBuild[] {
  return [...builds]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}

/** Maps with at least one build on them — the evidence the optional onboarding step asks for. */
export function mapsWithPlacements(maps: SavedWorld[]): number {
  return maps.filter((map) => map.placements > 0).length;
}
