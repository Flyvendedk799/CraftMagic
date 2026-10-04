import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  DOCKS,
  sectionDock,
  type DockSide,
  type DockTab,
  type WorkspaceLayout,
} from './layout.js';
import type { StudioMode } from '../mode.js';
import { StudioIcon } from './Icon.js';

type Slots = Partial<Record<`${DockSide}:${DockTab}`, HTMLElement>>;
interface DockContextValue {
  enabled: true;
  slots: Slots;
  setSlot: (key: keyof Slots, node: HTMLElement | null) => void;
  reveal: (side: DockSide, tab: DockTab) => void;
}
const DockContext = createContext<DockContextValue | null>(null);
export function DockProvider({
  children,
  reveal,
}: {
  children: ReactNode;
  reveal: DockContextValue['reveal'];
}) {
  const [slots, setSlots] = useState<Slots>({});
  const setSlot = useCallback(
    (key: keyof Slots, node: HTMLElement | null) =>
      setSlots((current) => {
        if (current[key] === (node ?? undefined)) return current;
        const next = { ...current };
        if (node) next[key] = node;
        else delete next[key];
        return next;
      }),
    [],
  );
  const value = useMemo<DockContextValue>(
    () => ({ enabled: true, slots, setSlot, reveal }),
    [slots, setSlot, reveal],
  );
  return <DockContext.Provider value={value}>{children}</DockContext.Provider>;
}
export function useDockedStudio(): boolean {
  return useContext(DockContext) !== null;
}
/** The editor retains ownership and callbacks; only presentation moves to the shell's dock. */
export function DockItem({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const context = useContext(DockContext),
    destination = sectionDock(id);
  if (!context || !destination) return <>{children}</>;
  const slot = context.slots[`${destination.side}:${destination.tab}`];
  return slot ? createPortal(children, slot, id) : null;
}
export function useRevealDock() {
  return useContext(DockContext)?.reveal;
}
function Slot({
  side,
  tab,
  active,
}: {
  side: DockSide;
  tab: DockTab;
  active: boolean;
}) {
  const context = useContext(DockContext)!;
  const set = useCallback(
    (node: HTMLDivElement | null) => context.setSlot(`${side}:${tab}`, node),
    [context.setSlot, side, tab],
  );
  return (
    <div
      id={`dock-${side}-${tab}`}
      role="tabpanel"
      aria-labelledby={`dock-tab-${side}-${tab}`}
      hidden={!active}
      tabIndex={0}
      className="workspace-dock__content"
      ref={set}
    />
  );
}
export function WorkspaceDock({
  side,
  mode,
  layout,
  onTab,
  onClose,
}: {
  side: DockSide;
  mode: StudioMode;
  layout: WorkspaceLayout;
  onTab: (tab: DockTab) => void;
  onClose: () => void;
}) {
  const specs = DOCKS[mode][side],
    active = layout.active[mode][side];
  return (
    <aside
      className={`workspace-dock workspace-dock--${side}`}
      aria-label={side === 'left' ? 'Editing tools' : 'Inspector and delivery'}
    >
      <div className="workspace-dock__tabs">
        <div
          className="workspace-dock__tablist"
          role="tablist"
          aria-label={`${side === 'left' ? 'Tool' : 'Inspector'} panels`}
        >
          {specs.map((tab, index) => (
            <button
              key={tab.id}
              id={`dock-tab-${side}-${tab.id}`}
              role="tab"
              aria-selected={active === tab.id}
              aria-controls={`dock-${side}-${tab.id}`}
              tabIndex={active === tab.id ? 0 : -1}
              title={tab.description}
              onClick={() => onTab(tab.id)}
              onKeyDown={(event) => {
                let target: number | null = null;
                if (event.key === 'ArrowRight')
                  target = (index + 1) % specs.length;
                if (event.key === 'ArrowLeft')
                  target = (index - 1 + specs.length) % specs.length;
                if (event.key === 'Home') target = 0;
                if (event.key === 'End') target = specs.length - 1;
                if (target !== null) {
                  event.preventDefault();
                  onTab(specs[target]!.id);
                  document
                    .getElementById(`dock-tab-${side}-${specs[target]!.id}`)
                    ?.focus();
                }
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          className="workspace-dock__collapse"
          title={`Hide ${side} panel`}
          aria-label={`Hide ${side} panel`}
          onClick={onClose}
        >
          <StudioIcon name={side === 'left' ? 'panelLeft' : 'panelRight'} />
        </button>
      </div>
      {specs.map((tab) => (
        <Slot
          key={tab.id}
          side={side}
          tab={tab.id}
          active={active === tab.id}
        />
      ))}
    </aside>
  );
}
