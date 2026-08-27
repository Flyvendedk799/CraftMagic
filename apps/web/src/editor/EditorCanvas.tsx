/**
 * The r3f side of the viewer.
 *
 * React's only job here is lifecycle: mount one `VoxelWorld` group into the scene, hand it
 * the grid, and tick it once a frame. Everything per-chunk stays out of the reconciler.
 *
 * The pointer is the other half of the job, and it is deliberately hand-rolled rather than
 * left to r3f's event system: the chunk meshes are not r3f objects, so they raise no pointer
 * events at all. That also makes this the one place that can tell a camera drag from an
 * editing drag, which is what lets Shift-drag paint a stroke while a plain drag still
 * orbits.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { VoxelGrid } from '@craftmagic/core';
import { VoxelWorld } from './VoxelWorld.js';
import type { Preview } from './preview.js';
import { raycastVoxel, type VoxelHit } from './raycast.js';

/** Camera presets. `iso` is the framing a build opens on. */
export type ViewKind = 'iso' | 'top' | 'front' | 'side';

/** A view request. The nonce is what makes pressing the same preset twice re-frame. */
export interface ViewRequest {
  kind: ViewKind;
  nonce: number;
}

export interface EditorCanvasProps {
  grid: VoxelGrid;
  paletteColors: Uint8Array;
  paletteFlags: Uint8Array;
  /** Highest visible layer; `null` shows the whole structure. */
  layerClip: number | null;
  /** Lowest visible layer, for the isolate mode that shows one slice at a time. */
  layerFloor?: number;
  onHover?: (hit: VoxelHit | null) => void;
  /**
   * A click that was not a drag. The canvas only reports where it landed — which tool that
   * means, and what to do about it, is the page's business.
   */
  onClick?: (hit: VoxelHit) => void;
  /**
   * A Shift-drag, reported once on release with every cell it crossed. One callback for the
   * whole gesture rather than one per move, so the page can fold it into a single edit.
   */
  onStroke?: (hits: VoxelHit[]) => void;
  /** Alt-click: sample rather than edit. */
  onPick?: (hit: VoxelHit) => void;
  /** A second highlight, e.g. the first corner of a box in progress. */
  marker?: { x: number; y: number; z: number } | null;
  /** Outline of what the next click would change. */
  preview?: Preview | null;
  /** Chunks still queued or in flight, for a loading indicator. Fires only on change. */
  onProgress?: (remaining: number) => void;
  /**
   * Handed the live mesh manager on mount and `null` on teardown. Edits are applied through
   * it rather than by re-loading the grid, so the caller needs the handle.
   */
  onWorld?: (world: VoxelWorld | null) => void;
  /** Camera preset to move to. Changing the nonce re-applies it. */
  view?: ViewRequest | null;
}

const BACKGROUND = '#0f1216';
const HOVER_COLOR = '#6ee7b7';
const PREVIEW_COLOR = '#fbbf24';

export function EditorCanvas(props: EditorCanvasProps) {
  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      camera={{ fov: 50, near: 0.1, far: 4000 }}
      // `localClippingEnabled` is a renderer field, not a WebGLRenderer constructor
      // parameter, so it cannot ride in on `gl` — it has to be set after creation.
      onCreated={({ gl }) => {
        gl.localClippingEnabled = true;
      }}
    >
      <color attach="background" args={[BACKGROUND]} />
      <Scene {...props} />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        panSpeed={0.8}
        zoomSpeed={0.9}
        // Stop just short of horizontal so the build never flips below the ground plane.
        maxPolarAngle={Math.PI * 0.495}
      />
    </Canvas>
  );
}

function Scene({
  grid,
  paletteColors,
  paletteFlags,
  layerClip,
  layerFloor = 0,
  onHover,
  onClick,
  onStroke,
  onPick,
  marker,
  preview,
  onProgress,
  onWorld,
  view,
}: EditorCanvasProps) {
  const scene = useThree((state) => state.scene);
  const worldRef = useRef<VoxelWorld | null>(null);
  const clipRef = useRef({ top: layerClip, floor: layerFloor });
  clipRef.current = { top: layerClip, floor: layerFloor };
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;
  const worldCallback = useRef(onWorld);
  worldCallback.current = onWorld;
  const lastRemaining = useRef(-1);

  // Keyed on the grid, not on its contents, and that is the point: edits write straight into
  // `grid.voxels`, so an answer recomputed per render would flip the moment the first block
  // landed and yank the camera to a new framing as a reward for using the tool.
  const startedEmpty = useMemo(() => isEmpty(grid), [grid]);

  // Keyed on the grid identity: a new structure is a full teardown, and building the world
  // inside the effect (rather than useMemo) keeps StrictMode's double-mount honest.
  //
  // The palette arrays are read here but are deliberately *not* dependencies. They change
  // identity whenever an edit appends a slot, and re-running this would tear down every
  // chunk and respawn the mesher worker for a change that cannot alter an existing mesh.
  // Growth goes through `VoxelWorld.setPalette` instead, pushed by whoever grew the palette
  // so it lands before the edit that uses the new slot.
  useEffect(() => {
    const world = new VoxelWorld();
    worldRef.current = world;
    scene.add(world.group);
    world.load(grid, paletteColors, paletteFlags);
    world.setLayerClip(clipRef.current.top, clipRef.current.floor);
    worldCallback.current?.(world);
    return () => {
      worldCallback.current?.(null);
      scene.remove(world.group);
      world.dispose();
      worldRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [scene, grid]);

  useEffect(() => {
    worldRef.current?.setLayerClip(layerClip, layerFloor);
  }, [layerClip, layerFloor]);

  useFrame(() => {
    const world = worldRef.current;
    if (!world) return;
    world.update();
    // Reporting every frame would re-render the HUD at 60Hz for no reason.
    if (world.remaining !== lastRemaining.current) {
      lastRemaining.current = world.remaining;
      progressRef.current?.(world.remaining);
    }
  });

  return (
    <>
      <Framing size={grid.size} empty={startedEmpty} view={view ?? null} />
      <Furniture size={grid.size} />
      <Picker
        grid={grid}
        layerClip={layerClip}
        layerFloor={layerFloor}
        onHover={onHover}
        onClick={onClick}
        onStroke={onStroke}
        onPick={onPick}
      />
      {marker && <Highlight at={marker} color={PREVIEW_COLOR} />}
      {preview && <PreviewOutline preview={preview} />}
    </>
  );
}

interface OrbitLike {
  target: THREE.Vector3;
  update: () => void;
  enabled: boolean;
}

/**
 * Point the camera at a structure without remounting the canvas (and its GL context).
 *
 * Re-frames on a new structure, and on demand for the view presets. The presets matter more
 * than they look: an orbit camera is very good at ending up somewhere with no horizon and no
 * way back, and "straight down" is the view that makes a floor plan readable.
 */
function Framing({
  size,
  empty,
  view,
}: {
  size: VoxelGrid['size'];
  empty: boolean;
  view: ViewRequest | null;
}) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as unknown as OrbitLike | null;

  useEffect(() => {
    frameCamera(camera, controls, size, 'iso', empty);
  }, [camera, controls, size, empty]);

  useEffect(() => {
    if (!view) return;
    frameCamera(camera, controls, size, view.kind, empty);
    // `view.nonce` rather than `view`: pressing the same preset twice must re-frame, and the
    // page hands over a new object either way.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [camera, controls, size, empty, view?.nonce]);

  return null;
}

/**
 * Is there anything in this build at all?
 *
 * Bails on the first block, and a build with blocks in it almost always has its foundation
 * at y=0 — the very start of the array — so the scan that matters costs nothing. Only a
 * genuinely empty grid is walked end to end, and that is the one case where the answer is
 * worth having.
 */
function isEmpty(grid: VoxelGrid): boolean {
  const { voxels } = grid;
  for (let i = 0; i < voxels.length; i++) if (voxels[i] !== 0) return false;
  return true;
}

function frameCamera(
  camera: THREE.Camera,
  controls: OrbitLike | null,
  size: VoxelGrid['size'],
  kind: ViewKind,
  empty = false,
): void {
  // An empty plot is framed on its floor, not on the middle of the volume it could grow
  // into. Aimed at mid-height it shows thirty courses of nothing with the ground squeezed
  // into a strip along the bottom edge — and the ground is the only surface a first click
  // can land on, so the plot reads as one that ignores the pointer. Sighting down at the
  // floor, and sizing the frame to the footprint rather than the height, makes the empty
  // build look like what it is: a plot to start on.
  const target = new THREE.Vector3(size.x / 2, empty ? 0 : size.y * 0.45, size.z / 2);
  const radius = empty ? Math.max(size.x, size.z) : Math.max(size.x, size.y, size.z);

  // Offsets in units of the build's own radius, so every preset frames a cottage and a
  // 200-block tower equally well.
  const offset =
    kind === 'top'
      ? new THREE.Vector3(0.001, 2.1, 0.001)
      : kind === 'front'
        ? new THREE.Vector3(0, 0.15, 2.0)
        : kind === 'side'
          ? new THREE.Vector3(2.0, 0.15, 0)
          : new THREE.Vector3(1.15, 0.8, 1.35);

  camera.position.copy(target).addScaledVector(offset, radius);
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.far = Math.max(2000, radius * 12);
    camera.updateProjectionMatrix();
  }
  if (controls) {
    controls.target.copy(target);
    controls.update();
  } else {
    camera.lookAt(target);
  }
}

/** Ground grid and a bounds outline — without them a floating build has no readable scale. */
function Furniture({ size }: { size: VoxelGrid['size'] }) {
  const helpers = useMemo(() => {
    const span = Math.ceil((Math.max(size.x, size.z) * 1.8) / 8) * 8;
    const grid = new THREE.GridHelper(span, span / 4, 0x38424f, 0x1e242c);
    // A hair below y=0, or it z-fights with the bottom faces of the foundation.
    grid.position.set(size.x / 2, -0.02, size.z / 2);

    const bounds = new THREE.Box3Helper(
      new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(size.x, size.y, size.z)),
      new THREE.Color(0x39485c),
    );

    return { grid, bounds };
  }, [size]);

  useEffect(
    () => () => {
      helpers.grid.geometry.dispose();
      helpers.bounds.geometry.dispose();
    },
    [helpers],
  );

  return (
    <>
      <primitive object={helpers.grid} />
      <primitive object={helpers.bounds} />
    </>
  );
}

/**
 * Hover highlight, clicks, strokes and picks, driven by the grid raycaster rather than r3f's
 * pointer events — the chunk meshes are not r3f objects, so they generate no pointer events
 * at all.
 */
function Picker({
  grid,
  layerClip,
  layerFloor,
  onHover,
  onClick,
  onStroke,
  onPick,
}: {
  grid: VoxelGrid;
  layerClip: number | null;
  layerFloor: number;
  onHover?: (hit: VoxelHit | null) => void;
  onClick?: (hit: VoxelHit) => void;
  onStroke?: (hits: VoxelHit[]) => void;
  onPick?: (hit: VoxelHit) => void;
}) {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as unknown as OrbitLike | null;
  const [hit, setHit] = useState<VoxelHit | null>(null);

  // Through refs, because the parent re-renders on every hover and inline callbacks in the
  // dependency list would rebind the listeners on every pointer move.
  const notify = useRef(onHover);
  notify.current = onHover;
  const notifyClick = useRef(onClick);
  notifyClick.current = onClick;
  const notifyStroke = useRef(onStroke);
  notifyStroke.current = onStroke;
  const notifyPick = useRef(onPick);
  notifyPick.current = onPick;

  useEffect(() => {
    const canvas = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    // Whatever was under the pointer belonged to the previous grid or the previous layer
    // cut. Keeping it would leave a highlight floating around a block that is no longer
    // visible until the pointer happens to move.
    setHit(null);
    notify.current?.(null);

    const cast = (event: PointerEvent): VoxelHit | null => {
      const rect = canvas.getBoundingClientRect();
      ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      return raycastVoxel(grid, raycaster.ray.origin, raycaster.ray.direction, {
        // The layer slider clips with planes, so the picker has to be told where the cuts
        // are — otherwise it happily returns a block nobody can see.
        maxY: layerClip ?? undefined,
        minY: layerFloor,
        // A ray that touches nothing lands on the floor instead of being thrown away. It is
        // what makes the ground grid under the build a surface you can build on, and the
        // only reason an empty plot is anything other than an inert grey box.
        ground: true,
      });
    };

    const show = (next: VoxelHit | null) => {
      setHit(next);
      notify.current?.(next);
    };

    // The same drag that orbits the camera would otherwise also land an edit under the
    // cursor, so a click has to be distinguished from a drag by how far the pointer moved.
    // The threshold is in CSS pixels and generous enough to survive a shaky click.
    let downAt: { x: number; y: number; button: number } | null = null;
    const DRAG_SLOP = 4;

    /** Cells crossed by a Shift-drag, oldest first. Null when no stroke is in progress. */
    let stroke: VoxelHit[] | null = null;

    const endStroke = (deliver: boolean) => {
      const cells = stroke;
      stroke = null;
      if (controls) controls.enabled = true;
      if (deliver && cells && cells.length > 0) notifyStroke.current?.(cells);
    };

    const down = (event: PointerEvent) => {
      downAt = { x: event.clientX, y: event.clientY, button: event.button };

      // A stroke takes the camera's drag away for its duration, so it starts only on the
      // exact gesture that asked for it: primary button, Shift held, and a tool that wants
      // strokes at all.
      if (event.button !== 0 || !event.shiftKey || !notifyStroke.current) return;
      const first = cast(event);
      stroke = first ? [first] : [];
      if (controls) controls.enabled = false;
      // Capture, so a drag that leaves the canvas still ends here rather than stranding the
      // camera with its controls switched off.
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    };

    const move = (event: PointerEvent) => {
      const next = cast(event);
      show(next);
      if (!stroke || !next) return;
      const last = stroke[stroke.length - 1];
      if (last && last.x === next.x && last.y === next.y && last.z === next.z) return;
      stroke.push(next);
    };

    const up = (event: PointerEvent) => {
      if (stroke) {
        endStroke(true);
        downAt = null;
        return;
      }

      const start = downAt;
      downAt = null;
      if (!start || start.button !== 0 || event.button !== 0) return;
      if (Math.abs(event.clientX - start.x) > DRAG_SLOP) return;
      if (Math.abs(event.clientY - start.y) > DRAG_SLOP) return;

      // Re-cast at the release point rather than reusing the hover state: hover is a frame
      // behind on a moving camera, and an edit landing one block off is not forgivable.
      const target = cast(event);
      if (!target) return;
      if (event.altKey) notifyPick.current?.(target);
      else notifyClick.current?.(target);
    };

    const leave = () => {
      if (!stroke) show(null);
    };

    const cancel = () => {
      endStroke(false);
      downAt = null;
    };

    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', cancel);
    return () => {
      // A teardown mid-stroke (a new grid, an unmount) must not leave the camera frozen.
      if (stroke) endStroke(false);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
    };
  }, [gl, camera, controls, grid, layerClip, layerFloor]);

  if (!hit) return null;
  return <Highlight at={hit} color={HOVER_COLOR} />;
}

/** The outline of what the next click would change. */
function PreviewOutline({ preview }: { preview: Preview }) {
  const object = useMemo(() => {
    const material = new THREE.LineBasicMaterial({
      color: PREVIEW_COLOR,
      transparent: true,
      opacity: 0.75,
      // Drawn through the build: an outline you can only see the near face of is no use for
      // judging how deep a box reaches.
      depthTest: false,
    });

    if (preview.kind === 'box') {
      const box = new THREE.Box3(
        new THREE.Vector3(preview.min.x, preview.min.y, preview.min.z),
        new THREE.Vector3(preview.max.x + 1, preview.max.y + 1, preview.max.z + 1),
      );
      const helper = new THREE.Box3Helper(box, new THREE.Color(PREVIEW_COLOR));
      // Box3Helper builds its own material; swapping ours in without disposing that one
      // would leak a material per pointer move.
      (helper.material as THREE.Material).dispose();
      helper.material = material;
      helper.renderOrder = 3;
      return helper;
    }

    return new THREE.LineSegments(cellEdges(preview.cells), material);
  }, [preview]);

  useEffect(
    () => () => {
      object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    },
    [object],
  );

  return <primitive object={object} renderOrder={3} />;
}

/** The twelve edges of every cell, in one buffer — one draw call for the whole preview. */
function cellEdges(cells: readonly { x: number; y: number; z: number }[]): THREE.BufferGeometry {
  const positions = new Float32Array(cells.length * EDGES.length * 3);
  let at = 0;
  for (const cell of cells) {
    for (const [dx, dy, dz] of EDGES) {
      positions[at++] = cell.x + dx;
      positions[at++] = cell.y + dy;
      positions[at++] = cell.z + dz;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

/** Endpoint pairs for a unit cube's twelve edges. */
const EDGES: readonly (readonly [number, number, number])[] = (() => {
  const corners: [number, number, number][] = [];
  for (let i = 0; i < 8; i++) corners.push([i & 1, (i >> 1) & 1, (i >> 2) & 1]);

  const out: [number, number, number][] = [];
  for (let a = 0; a < 8; a++) {
    for (let b = a + 1; b < 8; b++) {
      const [ax, ay, az] = corners[a]!;
      const [bx, by, bz] = corners[b]!;
      // Corners that differ on exactly one axis are the ones joined by an edge.
      if (Math.abs(ax - bx) + Math.abs(ay - by) + Math.abs(az - bz) !== 1) continue;
      out.push(corners[a]!, corners[b]!);
    }
  }
  return out;
})();

function Highlight({ at, color }: { at: { x: number; y: number; z: number }; color: string }) {
  return (
    <lineSegments position={[at.x + 0.5, at.y + 0.5, at.z + 0.5]} renderOrder={2}>
      <edgesGeometry args={[HIGHLIGHT_BOX]} />
      <lineBasicMaterial color={color} depthTest={false} transparent opacity={0.9} />
    </lineSegments>
  );
}

/** Shared, because the highlight is remounted on every pointer move. */
const HIGHLIGHT_BOX = new THREE.BoxGeometry(1.02, 1.02, 1.02);
