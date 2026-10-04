import { ownsParam, parseMode, type StudioMode } from '../mode.js';

/** Navigation metadata only. The editors continue to own and persist document contents. */
export interface WorkspaceDocument {
  key: string;
  href: string;
  mode: StudioMode;
  title: string;
  pinned: boolean;
  lastOpened: number;
}
export interface DocumentSession {
  version: 1;
  tabs: WorkspaceDocument[];
  recent: WorkspaceDocument[];
}
export const EMPTY_SESSION: DocumentSession = {
  version: 1,
  tabs: [],
  recent: [],
};
export const MAX_TABS = 16;
export const MAX_RECENT = 40;
const ORIGIN = 'https://workspace.invalid';

export function canonicalDocument(
  href: string,
): { key: string; href: string; mode: StudioMode } | null {
  if (
    typeof href !== 'string' ||
    href.length > 4096 ||
    !href.startsWith('/studio') ||
    href.startsWith('//')
  )
    return null;
  let url: URL;
  try {
    url = new URL(href, ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN || url.pathname !== '/studio') return null;
  const mode = parseMode(url.searchParams.get('mode'));
  const params = new URLSearchParams();
  if (mode !== 'build') params.set('mode', mode);
  for (const [key, value] of url.searchParams)
    if (ownsParam(mode, key)) params.set(key, value);
  params.sort();
  const id =
    params.get(
      mode === 'build' ? 'build' : mode === 'arch' ? 'plan' : 'world',
    ) || 'draft';
  const search = params.toString();
  return {
    key: `${mode}:${id}`,
    mode,
    href: `/studio${search ? `?${search}` : ''}`,
  };
}

function readDocument(value: unknown): WorkspaceDocument | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const doc = typeof v.href === 'string' ? canonicalDocument(v.href) : null;
  if (!doc || typeof v.title !== 'string') return null;
  return {
    ...doc,
    title: v.title.slice(0, 120) || 'Untitled',
    pinned: v.pinned === true,
    lastOpened:
      typeof v.lastOpened === 'number' && Number.isFinite(v.lastOpened)
        ? Math.max(0, v.lastOpened)
        : 0,
  };
}
function unique(values: unknown, max: number): WorkspaceDocument[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values
    .map(readDocument)
    .filter(
      (v): v is WorkspaceDocument =>
        !!v && !seen.has(v.key) && !!seen.add(v.key),
    )
    .slice(0, max);
}
export function readSession(raw: string | null): DocumentSession {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (value?.version !== 1) return { ...EMPTY_SESSION };
    return {
      version: 1,
      tabs: unique(value.tabs, MAX_TABS + 1),
      recent: unique(value.recent, MAX_RECENT),
    };
  } catch {
    return { ...EMPTY_SESSION };
  }
}
export function visitDocument(
  session: DocumentSession,
  href: string,
  title: string,
  now = Date.now(),
): DocumentSession {
  const doc = canonicalDocument(href);
  if (!doc) return session;
  const existing = session.tabs.find((v) => v.key === doc.key);
  const next: WorkspaceDocument = {
    ...doc,
    title: title.slice(0, 120),
    pinned: existing?.pinned ?? false,
    lastOpened: now,
  };
  let tabs = existing
    ? session.tabs.map((v) => (v.key === doc.key ? next : v))
    : [...session.tabs, next];
  if (tabs.length > MAX_TABS) {
    const removable = tabs
      .filter((v) => !v.pinned && v.key !== doc.key)
      .sort((a, b) => a.lastOpened - b.lastOpened)[0];
    // Pinned documents keep their slots. One overflow slot keeps the active document visible.
    tabs = removable ? tabs.filter((v) => v.key !== removable.key) : tabs;
  }
  return {
    version: 1,
    tabs,
    recent: [next, ...session.recent.filter((v) => v.key !== doc.key)].slice(
      0,
      MAX_RECENT,
    ),
  };
}
export function closeDocument(
  session: DocumentSession,
  key: string,
): DocumentSession {
  return { ...session, tabs: session.tabs.filter((v) => v.key !== key) };
}
export function pinDocument(
  session: DocumentSession,
  key: string,
): DocumentSession {
  const target = session.tabs.find((tab) => tab.key === key);
  if (
    !target ||
    (!target.pinned &&
      session.tabs.filter((tab) => tab.pinned).length >= MAX_TABS)
  )
    return session;
  return {
    ...session,
    tabs: session.tabs.map((tab) =>
      tab.key === key ? { ...tab, pinned: !tab.pinned } : tab,
    ),
  };
}
export function adjacentDocument(
  tabs: WorkspaceDocument[],
  key: string,
): WorkspaceDocument | null {
  const index = tabs.findIndex((v) => v.key === key);
  if (index < 0) return null;
  return tabs[index + 1] ?? tabs[index - 1] ?? null;
}
export function moveDocument(
  session: DocumentSession,
  key: string,
  by: -1 | 1,
): DocumentSession {
  const tabs = [...session.tabs],
    index = tabs.findIndex((v) => v.key === key),
    target = index + by;
  if (index < 0 || target < 0 || target >= tabs.length) return session;
  [tabs[index], tabs[target]] = [tabs[target]!, tabs[index]!];
  return { ...session, tabs };
}
