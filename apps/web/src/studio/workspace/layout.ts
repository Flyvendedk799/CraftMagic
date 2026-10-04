import type { StudioMode } from '../mode.js';
export type DockSide = 'left' | 'right';
export type DockTab =
  | 'tools'
  | 'shape'
  | 'assets'
  | 'inspect'
  | 'create'
  | 'deliver'
  | 'world';
export interface DockSpec {
  id: DockTab;
  label: string;
  description: string;
}
const tools = {
  id: 'tools',
  label: 'Tools',
  description: 'Draw, select and edit',
} as const;
const assets = {
  id: 'assets',
  label: 'Assets',
  description: 'Reusable starting points and components',
} as const;
const inspect = {
  id: 'inspect',
  label: 'Inspect',
  description: 'Selection, structure and checks',
} as const;
const deliver = {
  id: 'deliver',
  label: 'Deliver',
  description: 'Save, export and build in Minecraft',
} as const;
const create = {
  id: 'create',
  label: 'AI',
  description: 'Generate or refine with your connected provider',
} as const;
export const DOCKS: Record<StudioMode, Record<DockSide, DockSpec[]>> = {
  build: {
    left: [
      tools,
      {
        id: 'shape',
        label: 'Shape',
        description: 'Scale, parameters and materials',
      },
      assets,
    ],
    right: [inspect, create, deliver],
  },
  arch: {
    left: [
      tools,
      {
        id: 'shape',
        label: 'Storeys',
        description: 'Floors and building settings',
      },
      assets,
    ],
    right: [inspect, create, deliver],
  },
  world: {
    left: [tools, assets],
    right: [
      inspect,
      { id: 'world', label: 'Map', description: 'Map extent and regions' },
      deliver,
    ],
  },
};
export interface WorkspaceLayout {
  version: 1;
  leftWidth: number;
  rightWidth: number;
  leftVisible: boolean;
  rightVisible: boolean;
  focus: boolean;
  density: 'comfortable' | 'compact';
  split: 'both' | 'primary' | 'preview';
  active: Record<StudioMode, Record<DockSide, DockTab>>;
}
export function defaultLayout(): WorkspaceLayout {
  return {
    version: 1,
    leftWidth: 272,
    rightWidth: 300,
    leftVisible: true,
    rightVisible: true,
    focus: false,
    density: 'comfortable',
    split: 'both',
    active: {
      build: { left: 'tools', right: 'inspect' },
      arch: { left: 'tools', right: 'inspect' },
      world: { left: 'tools', right: 'inspect' },
    },
  };
}
export function clampWidth(value: number): number {
  return Math.round(
    Math.min(480, Math.max(224, Number.isFinite(value) ? value : 272)),
  );
}
export function readLayout(raw: string | null): WorkspaceLayout {
  const result = defaultLayout();
  try {
    const v = JSON.parse(raw ?? 'null');
    if (v?.version !== 1) return result;
    result.leftWidth = clampWidth(
      typeof v.leftWidth === 'number' ? v.leftWidth : result.leftWidth,
    );
    result.rightWidth = clampWidth(
      typeof v.rightWidth === 'number' ? v.rightWidth : result.rightWidth,
    );
    result.leftVisible = v.leftVisible !== false;
    result.rightVisible = v.rightVisible !== false;
    result.density = v.density === 'compact' ? 'compact' : 'comfortable';
    result.split = ['both', 'primary', 'preview'].includes(v.split)
      ? v.split
      : 'both';
    for (const mode of ['build', 'arch', 'world'] as const)
      for (const side of ['left', 'right'] as const) {
        if (
          DOCKS[mode][side].some((tab) => tab.id === v.active?.[mode]?.[side])
        )
          result.active[mode][side] = v.active[mode][side];
      }
  } catch {
    /* Defaults remain usable when storage is corrupt or unavailable. */
  }
  return result;
}
export function sectionDock(
  id: string,
): { side: DockSide; tab: DockTab } | null {
  if (
    [
      'tools',
      'layouter-tools',
      'world-tools',
      'world-brush',
      'world-target',
      'world-ground',
    ].includes(id)
  )
    return { side: 'left', tab: 'tools' };
  if (['shape', 'layouter-floors', 'layouter-site'].includes(id))
    return { side: 'left', tab: 'shape' };
  if (['assets', 'layouter-components', 'world-shelf'].includes(id))
    return { side: 'left', tab: 'assets' };
  if (
    [
      'stats',
      'outline',
      'layouter-inspector',
      'layouter-schedule',
      'layouter-issues',
      'layouter-stats',
      'world-placed',
      'world-inspector',
    ].includes(id)
  )
    return { side: 'right', tab: 'inspect' };
  if (['picture', 'layouter-ai', 'assistant'].includes(id))
    return { side: 'right', tab: 'create' };
  if (['world-doc', 'world-extent', 'world-regions'].includes(id))
    return { side: 'right', tab: 'world' };
  if (
    [
      'save-library-v2',
      'export',
      'sendtogame',
      'layouter-plans',
      'layouter-handoff',
      'account',
      'delivery-state',
    ].includes(id)
  )
    return { side: 'right', tab: 'deliver' };
  return null;
}
