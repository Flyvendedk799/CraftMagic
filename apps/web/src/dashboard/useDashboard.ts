/**
 * Everything the dashboard shows about an account, in one hook.
 *
 * Two requests, fired together rather than in sequence: the build list and the spend summary
 * are independent, and awaiting one before starting the other doubles the time the page spends
 * as an empty frame for no reason. Paired worlds come from `useAgents`, which the editor's
 * "Send to game" panel already owns — the dashboard borrows it rather than growing a second,
 * slightly different idea of what a paired world is.
 *
 * Failure is per-panel and never fatal. A dashboard that renders a single error where six
 * cards should be is a worse answer than a dashboard that draws five of them and says which
 * one is missing, especially when the failure is `/api/spend` on a deployment where nobody
 * configured a budget.
 */

import { useCallback, useEffect, useState } from 'react';
import { listBuilds, type LibraryBuild } from '../library/library.js';
import type { SpendSummary } from '../generate/useGeneration.js';

export interface DashboardData {
  builds: LibraryBuild[];
  /** Null while loading, and after a failure the page reports in place. */
  spend: SpendSummary | null;
  loading: boolean;
  /** The build list only. Spend failing quietly is not worth an alert. */
  error: string | null;
  refresh: () => Promise<void>;
}

export function useDashboard(enabled: boolean): DashboardData {
  const [builds, setBuilds] = useState<LibraryBuild[]>([]);
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      // Signed out is a real, complete state — not a pending one. Left loading, the page
      // would sit on skeletons forever for exactly the visitor who needs the sign-up form.
      setBuilds([]);
      setSpend(null);
      setLoading(false);
      return;
    }

    const [listed, spent] = await Promise.allSettled([
      listBuilds(),
      fetch('/api/spend').then((response) => (response.ok ? response.json() : null)),
    ]);

    if (listed.status === 'fulfilled') {
      setBuilds(listed.value);
      setError(null);
    } else {
      setError((listed.reason as Error).message);
    }
    setSpend(spent.status === 'fulfilled' ? (spent.value as SpendSummary | null) : null);
    setLoading(false);
  }, [enabled]);

  useEffect(() => {
    setLoading(enabled);
    void refresh();
  }, [enabled, refresh]);

  return { builds, spend, loading, error, refresh };
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
