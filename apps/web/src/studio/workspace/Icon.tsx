import type { SVGProps } from 'react';
export type IconName =
  | 'cube'
  | 'plan'
  | 'world'
  | 'search'
  | 'close'
  | 'chevron'
  | 'undo'
  | 'redo'
  | 'save'
  | 'export'
  | 'folder'
  | 'plus'
  | 'panelLeft'
  | 'panelRight'
  | 'focus'
  | 'history'
  | 'settings'
  | 'pin'
  | 'check'
  | 'warning'
  | 'spark'
  | 'arrow'
  | 'home'
  | 'more';
const paths: Record<IconName, string> = {
  cube: 'M12 3 3 8v9l9 5 9-5V8l-9-5ZM3 8l9 5 9-5M12 13v9',
  plan: 'M4 4h16v16H4zM4 11h9V4M13 11v9M13 15h7',
  world: 'M3 5l6-2 6 2 6-2v16l-6 2-6-2-6 2V5ZM9 3v16M15 5v16',
  search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  close: 'm6 6 12 12M6 18 18 6',
  chevron: 'm9 5 7 7-7 7',
  undo: 'M8 4 3 9l5 5M3 9h10a7 7 0 0 1 0 14',
  redo: 'm16 4 5 5-5 5M21 9H11a7 7 0 0 0 0 14',
  save: 'M4 3h13l4 4v14H3V3h1ZM7 3v6h10V3M7 21v-8h10v8',
  export: 'M12 16V3m-5 5 5-5 5 5M4 14v7h16v-7',
  folder: 'M3 6V3h6l3 3h9v15H3V6Z',
  plus: 'M12 4v16M4 12h16',
  panelLeft: 'M3 4h18v16H3zM9 4v16',
  panelRight: 'M3 4h18v16H3zM15 4v16',
  focus: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  history: 'M3 12a9 9 0 1 0 3-7L3 8m0-5v5h5m4-1v5l3 2',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
  pin: 'm8 3 8 0-1 7 4 4H5l4-4-1-7Zm4 11v8',
  check: 'm4 12 5 5L20 6',
  warning: 'm12 3 10 18H2L12 3Zm0 6v5m0 3v1',
  spark: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  home: 'm3 10 9-7 9 7v11h-7v-7h-4v7H3V10Z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};
export function StudioIcon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
