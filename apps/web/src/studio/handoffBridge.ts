/**
 * The compiled plan, offered to the shell when the visitor zooms from Plan into Build.
 *
 * Architecture owns the program; the shell owns the address bar. A module-level slot is the
 * seam, cleared when the page unmounts so a stale compile cannot be opened later.
 */

let current: (() => string | null) | null = null;

export function registerPlanHandoff(fn: () => string | null): () => void {
  current = fn;
  return () => {
    if (current === fn) current = null;
  };
}

/** The build id to open, or null when no plan is mounted. */
export function takePlanHandoff(): string | null {
  return current?.() ?? null;
}
