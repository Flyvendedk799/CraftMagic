/** The mounted document's file verbs, shared by the Studio header and command palette.
 *
 * Each editor still owns its document format. The workbench owns when a user asks to save,
 * start again, or reach delivery. Registering a getter keeps these actions live through edits
 * without lifting voxel grids, floorplans, or heightfields into the shell.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { StudioMode } from './mode.js';

export interface WorkbenchActions {
  saveLabel: string;
  save: () => void | Promise<unknown>;
  canSave: boolean;
  saveHint?: string;
  create: () => void;
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
    return () => setRegistration((current) => current === entry ? null : current);
  }, []);
  const refresh = useCallback(() => setRevision((revision) => revision + 1), []);
  const api = useMemo(() => ({ registration, register, refresh }), [registration, register, refresh, revision]);
  return <WorkbenchContext.Provider value={api}>{children}</WorkbenchContext.Provider>;
}

/** Register once per mount. The getter always calls the latest callbacks and reads the latest grid. */
export function useRegisterWorkbench(mode: StudioMode, actions: WorkbenchActions): void {
  const api = useContext(WorkbenchContext);
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => api?.register({ mode, get: () => latest.current }), [api?.register, mode]);
  useEffect(() => api?.refresh(), [api?.refresh, actions.saveLabel, actions.canSave, actions.saveHint]);
}

export function useWorkbenchActions(mode: StudioMode): WorkbenchActions | null {
  const entry = useContext(WorkbenchContext)?.registration;
  return entry?.mode === mode ? entry.get() : null;
}
