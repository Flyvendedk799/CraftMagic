/**
 * The plan: what is placed where, and the composed grid that falls out of it.
 *
 * ## What is stored, and what is not
 *
 * A plan is a short list of `{sourceId, position, rotation}` — a few hundred bytes for a
 * village. The *components* are megabytes, and they already live in the library, so the plan
 * stores ids and fetches the grids. That is also what keeps a plan honest: rename a build in
 * the library and the plan shows the new name; delete it and the plan says so out loud rather
 * than silently drawing a stale copy.
 *
 * The plan itself lives in `localStorage`. It is content rather than view state, so the URL
 * was wrong for it, and there is no plans table on the server yet. The composed *result* is
 * saveable to the library like any other build — which is the loop worth having, because a
 * saved plan then becomes a component you can place inside another one.
 *
 * ## Why composing is deferred during a drag
 *
 * Composing walks every voxel of every component, and moving a placement changes the grid's
 * identity, which re-meshes the whole scene. At 60 Hz that is unusable on anything larger
 * than a shed. So a drag moves a *ghost* — an outline at the provisional position — and the
 * composition is rebuilt once, on release. The cost is that a building does not visually
 * follow the cursor; the outline does, and the outline is what you are aiming with anyway.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clampPosition,
  composePlan,
  paletteColors,
  paletteFlags,
  placementBox,
  rotatedSize,
  type ComposeResult,
  type Placement,
  type PlanComponent,
  type Quarter,
} from '@craftmagic/core';
import { getBuild } from '../library/library.js';

const STORAGE_KEY = 'craftmagic.plan';
const DEFAULT_NAME = 'New plan';

/** Blocks of clear ground left between two auto-placed components. */
const AUTO_GAP = 3;

interface StoredPlan {
  name: string;
  placements: Placement[];
}

export interface PlanState {
  name: string;
  rename: (name: string) => void;

  placements: Placement[];
  components: Map<string, PlanComponent>;
  /** Source ids currently being fetched, so the shelf can say so. */
  loading: Set<string>;
  /** Source ids whose fetch failed — deleted from the library, most likely. */
  failed: Set<string>;

  selected: string | null;
  select: (id: string | null) => void;

  /** The composed grid and its palette tables, ready for the canvas. */
  composed: ComposeResult;
  colors: Uint8Array;
  flags: Uint8Array;

  add: (component: { id: string; name: string }) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  moveTo: (id: string, at: { x: number; y: number; z: number }) => void;
  nudge: (id: string, delta: { x?: number; y?: number; z?: number }) => void;
  turn: (id: string, quarters: number) => void;
  clear: () => void;

  /** The box a placement occupies in plan space, or null when its component is missing. */
  boxOf: (id: string) => { min: PlanVec; max: PlanVec } | null;
}

interface PlanVec {
  x: number;
  y: number;
  z: number;
}

function readStored(): StoredPlan {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { name: DEFAULT_NAME, placements: [] };
    const parsed = JSON.parse(raw) as Partial<StoredPlan>;
    if (!Array.isArray(parsed.placements)) return { name: DEFAULT_NAME, placements: [] };
    // Validated rather than trusted: this is a hand-editable store, and a placement with no
    // `at` would crash compose rather than degrade.
    const placements = parsed.placements.filter(
      (entry): entry is Placement =>
        typeof entry?.id === 'string' &&
        typeof entry.sourceId === 'string' &&
        typeof entry.at?.x === 'number' &&
        typeof entry.at?.y === 'number' &&
        typeof entry.at?.z === 'number',
    );
    return { name: parsed.name ?? DEFAULT_NAME, placements };
  } catch {
    return { name: DEFAULT_NAME, placements: [] };
  }
}

let counter = 0;
const nextId = () => `p${Date.now().toString(36)}${(counter++).toString(36)}`;

export function usePlan(): PlanState {
  const [name, setName] = useState(DEFAULT_NAME);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [components, setComponents] = useState<Map<string, PlanComponent>>(new Map());
  // Read by `ensureComponent`, which must not change identity every time a component arrives.
  const componentsRef = useRef(components);
  componentsRef.current = components;
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const restored = useRef(false);

  // Restored after mount for the same reason the display options are: storage can throw.
  useEffect(() => {
    const stored = readStored();
    setName(stored.name);
    setPlacements(stored.placements);
    restored.current = true;
  }, []);

  useEffect(() => {
    // Guarded on `restored`, or the first render would write an empty plan over a real one
    // before the effect above has had a chance to read it.
    if (!restored.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ name, placements }));
    } catch {
      // A plan that is not remembered across reloads still works for this session.
    }
  }, [name, placements]);

  /**
   * Fetch a component once, ever.
   *
   * The in-flight promise is kept in a ref and handed to every later caller, which is what
   * makes this safe to call from a render-driven effect *and* from the click handler that
   * needs the grid before it can decide where to drop it.
   *
   * The first version cancelled on cleanup and deadlocked on exactly the path that matters
   * most: restoring a saved plan. Marking an id as loading re-runs the effect, the re-run
   * cancels the fetch it just started, and the next pass skips the id because it is already
   * marked loading — so a reloaded plan sat there forever with placements and no components,
   * composing to an empty grid. Nothing is cancelled now; a resolved fetch that nobody is
   * waiting for costs one `setState` on an unmounted component, which React ignores.
   */
  const inFlight = useRef(new Map<string, Promise<PlanComponent | null>>());

  const ensureComponent = useCallback(
    (sourceId: string): Promise<PlanComponent | null> => {
      const known = componentsRef.current.get(sourceId);
      if (known) return Promise.resolve(known);

      const pending = inFlight.current.get(sourceId);
      if (pending) return pending;

      setLoading((prev) => new Set(prev).add(sourceId));

      const request = getBuild(sourceId)
        .then((detail): PlanComponent => {
          const component: PlanComponent = {
            sourceId,
            name: detail.name,
            grid: {
              size: detail.grid.size,
              palette: detail.grid.palette,
              voxels: Uint16Array.from(detail.grid.voxels),
            },
          };
          setComponents((prev) => new Map(prev).set(sourceId, component));
          return component;
        })
        .catch(() => {
          setFailed((prev) => new Set(prev).add(sourceId));
          return null;
        })
        .finally(() => {
          inFlight.current.delete(sourceId);
          setLoading((prev) => {
            const next = new Set(prev);
            next.delete(sourceId);
            return next;
          });
        });

      inFlight.current.set(sourceId, request);
      return request;
    },
    [],
  );

  /**
   * Every component a placement names, keyed on the *set* of distinct source ids rather than
   * on the placements themselves — moving a building must not re-request its grid.
   */
  const needed = useMemo(
    () => [...new Set(placements.map((placement) => placement.sourceId))].sort().join(','),
    [placements],
  );

  useEffect(() => {
    if (needed === '') return;
    for (const sourceId of needed.split(',')) void ensureComponent(sourceId);
  }, [needed, ensureComponent]);

  const composed = useMemo(() => composePlan(placements, components), [placements, components]);

  // The mesher's colour tables. Rebuilt only when the palette actually changes identity,
  // which after a compose it always has — but a hover or a selection must not touch them.
  const colors = useMemo(() => paletteColors(composed.grid.palette), [composed.grid.palette]);
  const flags = useMemo(() => paletteFlags(composed.grid.palette), [composed.grid.palette]);

  const sizeOf = useCallback(
    (placement: Placement) => {
      const component = components.get(placement.sourceId);
      return component ? rotatedSize(component.grid.size, placement.rotation) : null;
    },
    [components],
  );

  /**
   * Somewhere clear to drop a newly added component.
   *
   * To the east of everything already placed, wrapping south when the row runs off the plot.
   * Not clever — a real packing algorithm would be — but it is predictable, which matters more
   * for something the user is about to drag anyway.
   */
  const freeSpot = useCallback(
    (size: PlanVec): PlanVec => {
      let east = 0;
      let south = 0;
      for (const placement of placements) {
        const component = components.get(placement.sourceId);
        if (!component) continue;
        const box = placementBox(placement, component);
        east = Math.max(east, box.max.x + 1 + AUTO_GAP);
        south = Math.max(south, box.max.z + 1 + AUTO_GAP);
      }
      const wraps = east + size.x > 256;
      return clampPosition({ x: wraps ? 0 : east, y: 0, z: wraps ? south : 0 }, size);
    },
    [placements, components],
  );

  const freeSpotRef = useRef(freeSpot);
  freeSpotRef.current = freeSpot;

  const add = useCallback<PlanState['add']>(
    (component) => {
      const id = nextId();
      // Fetched before it is appended, because *where* it lands depends on how big it is:
      // appending first and positioning later drops every new component on the origin and
      // then makes it jump.
      void ensureComponent(component.id).then((fetched) => {
        if (!fetched) return;
        const at = freeSpotRef.current(fetched.grid.size);
        setPlacements((prev) => [...prev, { id, sourceId: component.id, at, rotation: 0 }]);
        setSelected(id);
      });
    },
    [ensureComponent],
  );

  const remove = useCallback((id: string) => {
    setPlacements((prev) => prev.filter((placement) => placement.id !== id));
    setSelected((current) => (current === id ? null : current));
  }, []);

  const duplicate = useCallback(
    (id: string) => {
      setPlacements((prev) => {
        const source = prev.find((placement) => placement.id === id);
        if (!source) return prev;
        const size = sizeOf(source);
        // Offset by its own width so the copy is visible rather than hidden inside the
        // original, which looks exactly like nothing happened.
        const at = size
          ? clampPosition({ ...source.at, x: source.at.x + size.x + AUTO_GAP }, size)
          : source.at;
        const copy: Placement = { ...source, id: nextId(), at };
        setSelected(copy.id);
        return [...prev, copy];
      });
    },
    [sizeOf],
  );

  const moveTo = useCallback<PlanState['moveTo']>(
    (id, at) => {
      setPlacements((prev) =>
        prev.map((placement) => {
          if (placement.id !== id) return placement;
          const size = sizeOf(placement);
          return { ...placement, at: size ? clampPosition(at, size) : placement.at };
        }),
      );
    },
    [sizeOf],
  );

  const nudge = useCallback<PlanState['nudge']>(
    (id, delta) => {
      setPlacements((prev) =>
        prev.map((placement) => {
          if (placement.id !== id) return placement;
          const size = sizeOf(placement);
          if (!size) return placement;
          return {
            ...placement,
            at: clampPosition(
              {
                x: placement.at.x + (delta.x ?? 0),
                y: placement.at.y + (delta.y ?? 0),
                z: placement.at.z + (delta.z ?? 0),
              },
              size,
            ),
          };
        }),
      );
    },
    [sizeOf],
  );

  const turn = useCallback<PlanState['turn']>(
    (id, quarters) => {
      setPlacements((prev) =>
        prev.map((placement) => {
          if (placement.id !== id) return placement;
          const rotation = (((placement.rotation + quarters) % 4) + 4) % 4;
          const component = components.get(placement.sourceId);
          if (!component) return { ...placement, rotation: rotation as Quarter };

          // Turn about the footprint's centre rather than its corner. Rotating around the
          // origin makes a long building swing away from where it was standing, and the user
          // then has to drag it back to the spot they had already chosen.
          const before = rotatedSize(component.grid.size, placement.rotation);
          const after = rotatedSize(component.grid.size, rotation as Quarter);
          const at = clampPosition(
            {
              x: placement.at.x + (before.x - after.x) / 2,
              y: placement.at.y,
              z: placement.at.z + (before.z - after.z) / 2,
            },
            after,
          );
          return { ...placement, rotation: rotation as Quarter, at };
        }),
      );
    },
    [components],
  );

  const clear = useCallback(() => {
    setPlacements([]);
    setSelected(null);
  }, []);

  const boxOf = useCallback<PlanState['boxOf']>(
    (id) => {
      const placement = placements.find((entry) => entry.id === id);
      if (!placement) return null;
      const component = components.get(placement.sourceId);
      return component ? placementBox(placement, component) : null;
    },
    [placements, components],
  );

  return {
    name,
    rename: setName,
    placements,
    components,
    loading,
    failed,
    selected,
    select: setSelected,
    composed,
    colors,
    flags,
    add,
    remove,
    duplicate,
    moveTo,
    nudge,
    turn,
    clear,
    boxOf,
  };
}
