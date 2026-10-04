import type { LibraryBuild } from '../../library/library.js';
import type { SavedWorld } from '../../world/api.js';
import type { SavedPlan } from '../../architecture/storage.js';
import { openInBuild, openMap, openPlan } from '../handoff.js';
export type FileKind = 'map' | 'library' | 'plan' | 'browserBuild';
export interface StudioFile {
  key: string;
  id: string;
  kind: FileKind;
  title: string;
  href: string;
  planHref?: string;
  detail: string;
  storage: 'account' | 'device';
  updatedAt: string | null;
  blocks?: number;
}
export function catalogue(input: {
  builds: LibraryBuild[];
  maps: SavedWorld[];
  plans: SavedPlan[];
  localBuilds: { id: string; name: string }[];
  signedIn: boolean;
}): StudioFile[] {
  return [
    ...input.maps.map((v) => ({
      key: `map:${v.id}`,
      id: v.id,
      kind: 'map' as const,
      title: v.name,
      href: openMap(v.id),
      detail: `${v.sizeX} × ${v.sizeZ} · ${v.placements} structures`,
      storage:
        v.storage ??
        (input.signedIn ? ('account' as const) : ('device' as const)),
      updatedAt: v.updatedAt,
    })),
    ...input.builds.map((v) => ({
      key: `library:${v.id}`,
      id: v.id,
      kind: 'library' as const,
      title: v.name,
      href: openInBuild(`lib:${v.id}`),
      planHref: v.hasPlan ? openPlan(v.id) : undefined,
      detail: `${v.sizeX} × ${v.sizeY} × ${v.sizeZ} · ${v.kind}`,
      storage: 'account' as const,
      updatedAt: v.updatedAt,
      blocks: v.blockCount,
    })),
    ...input.plans.map((v) => ({
      key: `plan:${v.id}`,
      id: v.id,
      kind: 'plan' as const,
      title: v.name,
      href: `/studio?mode=arch&plan=${encodeURIComponent(`local:${v.id}`)}`,
      detail: `${v.plan.floors.length} storeys`,
      storage: 'device' as const,
      updatedAt: v.updatedAt,
    })),
    ...input.localBuilds.map((v) => ({
      key: `browserBuild:${v.id}`,
      id: v.id,
      kind: 'browserBuild' as const,
      title: v.name,
      href: openInBuild(v.id),
      detail: 'Browser build',
      storage: 'device' as const,
      updatedAt: null,
    })),
  ];
}
export type FileFilter =
  | 'all'
  | 'builds'
  | 'plans'
  | 'maps'
  | 'device'
  | 'account';
export type FileSort = 'recent' | 'name' | 'kind';
export function filterFiles(
  files: StudioFile[],
  query: string,
  filter: FileFilter,
  sort: FileSort,
): StudioFile[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return files
    .filter(
      (file) =>
        words.every((word) =>
          `${file.title} ${file.detail}`.toLowerCase().includes(word),
        ) &&
        (filter === 'all' ||
          (filter === 'builds' &&
            (file.kind === 'library' || file.kind === 'browserBuild')) ||
          (filter === 'plans' && file.kind === 'plan') ||
          (filter === 'maps' && file.kind === 'map') ||
          filter === file.storage),
    )
    .sort((a, b) => {
      if (sort === 'recent')
        return (
          (Date.parse(b.updatedAt ?? '') || 0) -
            (Date.parse(a.updatedAt ?? '') || 0) ||
          a.title.localeCompare(b.title)
        );
      if (sort === 'kind')
        return a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title);
      return a.title.localeCompare(b.title);
    });
}
export function validateFileName(name: string): string | null {
  const value = name.trim();
  if (!value) return 'Enter a name.';
  if (value.length > 120) return 'Use 120 characters or fewer.';
  // Reject control characters in user-visible document names.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value))
    return 'Remove control characters from the name.';
  return null;
}
