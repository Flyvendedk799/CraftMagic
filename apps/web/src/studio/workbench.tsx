import type { Command } from './CommandPalette.js';
/** The mounted document's file verbs, shared by the Studio header and command palette.
 *
 * Each editor still owns its document format. The workbench owns when a user asks to save,
 * start again, or reach delivery. Registering a getter keeps these actions live through edits
 * without lifting voxel grids, floorplans, or heightfields into the shell.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { StudioMode } from './mode.js';

export interface WorkbenchActions {
  saveLabel: string;
  save: () => void | Promise<unknown>;
  canSave: boolean;
  saveHint?: string;
  create: () => void;
  commands?: Command[];
  saving?: boolean;
  saveError?: string | null;
  activity?: string | null;
}

type Registration = { mode: StudioMode; get: () => WorkbenchActions };
interface WorkbenchApi {
  registration: Registration | null;
  register: (entry: Registration) => () => void;
  refresh: () => void;
}

const WorkbenchContext = createContext<WorkbenchApi | null>(null);

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [revision, setRevision] = useState(0);
  const register = useCallback((entry: Registration) => {
    setRegistration(entry);
    return () =>
      setRegistration((current) => (current === entry ? null : current));
  }, []);
  const refresh = useCallback(
    () => setRevision((revision) => revision + 1),
    [],
  );
  const api = useMemo(
    () => ({ registration, register, refresh }),
    [registration, register, refresh, revision],
  );
  return (
    <WorkbenchContext.Provider value={api}>
      {children}
    </WorkbenchContext.Provider>
  );
}

/** Register once per mount. The getter always calls the latest callbacks and reads the latest grid. */
export function useRegisterWorkbench(
  mode: StudioMode,
  actions: WorkbenchActions,
): void {
  const api = useContext(WorkbenchContext);
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(
    () => api?.register({ mode, get: () => latest.current }),
    [api?.register, mode],
  );
  useEffect(
    () => api?.refresh(),
    [
      api?.refresh,
      actions.saveLabel,
      actions.canSave,
      actions.saveHint,
      actions.saving,
      actions.saveError,
      actions.activity,
      JSON.stringify(
        actions.commands?.map(({ id, label, disabled, checked }) => ({
          id,
          label,
          disabled,
          checked,
        })),
      ),
    ],
  );
}

export function useWorkbenchActions(mode: StudioMode): WorkbenchActions | null {
  const entry = useContext(WorkbenchContext)?.registration;
  return entry?.mode === mode ? entry.get() : null;
}

/** Keyboard and palette saves need the same failure surface as the toolbar, without unhandled promises. */
export function requestWorkbenchSave(actions: WorkbenchActions | null): void {
  if (!actions?.canSave || actions.saving) return;
  const href = window.location.href;
  void Promise.resolve()
    .then(() => actions.save())
    .catch((error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : 'Could not save this document.';
      window.dispatchEvent(
        new CustomEvent('studio:save-error', { detail: { message, href } }),
      );
    });
}
