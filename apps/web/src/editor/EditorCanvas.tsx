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
import { classicMaterials, enhancedMaterials } from './materials.js';
import { VoxelWorld, type ClipBox } from './VoxelWorld.js';
import type { Preview } from './preview.js';
import { raycastVoxel, type VoxelHit } from './raycast.js';

/** Camera presets. `iso` is the framing a build opens on. */
export type ViewKind = 'iso' | 'top' | 'front' | 'side';

/** An inclusive block-coordinate box, for framing part of a build rather than all of it. */
export interface FocusBox {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/** A view request. The nonce is what makes pressing the same preset twice re-frame. */
export interface ViewRequest {
  kind: ViewKind;
  nonce: number;
  /**
   * Frame this box instead of the whole build.
   *
   * What makes "show me that room" mean anything: clipping the model to one room leaves the
   * camera still framed on a building that is now mostly missing, so the room ends up a
   * fingernail in the corner of an empty viewport.
   */
  focus?: FocusBox | null;
}

export interface EditorCanvasProps {
  grid: VoxelGrid;
  paletteColors: Uint8Array;
  paletteFlags: Uint8Array;
  /** Highest visible layer; `null` shows the whole structure. Omit it entirely when passing `clip`. */
  layerClip?: number | null;
  /** Lowest visible layer, for the isolate mode that shows one slice at a time. */
  layerFloor?: number;
  /**
   * Hide everything outside this box.
   *
   * Takes over from `layerClip`/`layerFloor` entirely when given, rather than intersecting
   * with them: two ways of saying where the top cut is would eventually disagree, and the
   * caller that wants a box is not also operating a layer slider. The editor passes layers,
   * the layouter passes a box.
   */
  clip?: ClipBox | null;
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
  /** A standing box selection, drawn until it is dismissed rather than until the pointer moves. */
  region?: Box | null;
  /**
   * True while a tool that owns rectangular selections is active.
   *
   * The canvas claims a plain primary drag only then, and only when the press lands on the
   * build — pressing the sky still orbits. That is what makes "drag out a box" possible
   * without a modifier key, on a surface whose default gesture is spinning the camera.
   */
  regionDrag?: boolean;
  /** A selection being drawn or moved. See `RegionDrag`. */
  onRegionDrag?: (drag: RegionDrag) => void;
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
  /**
   * Handed a screenshot-taker on mount and `null` on teardown.
   *
   * A function rather than an imperative ref because the canvas draws without
   * `preserveDrawingBuffer`: the pixels are only defined immediately after a render, so the
   * taker renders one frame itself and reads the canvas in the same breath.
   */
  onSnapshot?: (take: (() => string) | null) => void;
  /**
   * The Enhanced render style: lit flat-shaded materials with per-voxel grain, a sky
   * gradient, fog and filmic tonemapping. Off means the Classic unlit look, unchanged.
   */
  enhanced?: boolean;
  /** Orthographic camera — the view that makes a floor plan measurable. */
  ortho?: boolean;
}

const BACKGROUND = '#0f1216';
const HOVER_COLOR = '#6ee7b7';
const PREVIEW_COLOR = '#fbbf24';

// The Enhanced sky: a cold dusk gradient. Horizon doubles as the fog colour so distant
// chunks dissolve into the sky instead of ending at a hard silhouette.
const SKY_ZENITH = '#16233c';
const SKY_HORIZON = '#3a4a66';
const SUN_COLOR = '#ffe9c4';

export function EditorCanvas(props: EditorCanvasProps) {
  const ortho = props.ortho ?? false;
  return (
    <Canvas
      // Remounted when the projection changes: a camera cannot switch class in place, and a
      // fresh GL context on an explicit toggle is cheaper than two cameras kept in step.
      key={ortho ? 'ortho' : 'persp'}
      dpr={[1, 2]}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      orthographic={ortho}
      camera={ortho ? { near: 0.1, far: 8000, zoom: 8 } : { fov: 50, near: 0.1, far: 4000 }}
      // `localClippingEnabled` is a renderer field, not a WebGLRenderer constructor
      // parameter, so it cannot ride in on `gl` — it has to be set after creation.
      onCreated={({ gl }) => {
        gl.localClippingEnabled = true;
      }}
    >
      <color attach="background" args={[props.enhanced ? SKY_HORIZON : BACKGROUND]} />
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
  layerClip = null,
  layerFloor = 0,
  clip,
  onHover,
  onClick,
  onStroke,
  onPick,
  marker,
  region,
  regionDrag,
  onRegionDrag,
  preview,
  onProgress,
  onWorld,
  view,
  onSnapshot,
  enhanced = false,
}: EditorCanvasProps) {
  const scene = useThree((state) => state.scene);
  const worldRef = useRef<VoxelWorld | null>(null);
  // Resolved once, here, so the mount effect and the update effect cannot disagree about
  // which of the two ways of expressing a cut is in force.
  const box: ClipBox | null = clip ?? (layerClip === null ? null : { maxY: layerClip, minY: layerFloor > 0 ? layerFloor : null });
  const clipRef = useRef(box);
  clipRef.current = box;
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
    const world = new VoxelWorld(enhanced ? enhancedMaterials() : classicMaterials());
    worldRef.current = world;
    scene.add(world.group);
    world.load(grid, paletteColors, paletteFlags);
    world.setClip(clipRef.current);
    worldCallback.current?.(world);
    return () => {
      worldCallback.current?.(null);
      scene.remove(world.group);
      world.dispose();
      worldRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [scene, grid, enhanced]);

  // Keyed on the resolved faces rather than on the object, which is rebuilt every render.
  const boxKey = JSON.stringify(box);
  useEffect(() => {
    worldRef.current?.setClip(clipRef.current);
  }, [boxKey]);

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
      <Snapshot register={onSnapshot} />
      {enhanced && <Environment size={grid.size} />}
      <Fly />
      <Furniture size={grid.size} />
      <Picker
        grid={grid}
        layerClip={layerClip}
        layerFloor={layerFloor}
        region={region}
        regionDrag={regionDrag}
        onHover={onHover}
        onClick={onClick}
        onStroke={onStroke}
        onPick={onPick}
        onRegionDrag={onRegionDrag}
      />
      {marker && <Highlight at={marker} color={PREVIEW_COLOR} />}
      {region && <RegionOutline min={region.min} max={region.max} />}
      {preview && <PreviewOutline preview={preview} />}
    </>
  );
}

/** An inclusive cell box: a selection, in grid coordinates. */
export interface Box {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * A primary drag on the build while a selection tool is active.
 *
 * The canvas decides *which* of the two gestures it is, because only the canvas knows where
 * the press landed: inside the current selection means "move this", anywhere else means
 * "draw a new one". The page is told which and acts on it — it never has to hit-test a
 * pointer position against a box it drew.
 */
export interface RegionDrag {
  mode: 'draw' | 'move';
  /** For `draw`, the fixed corner. For `move`, the cell the pointer grabbed. */
  from: { x: number; y: number; z: number };
  /** For `draw`, the moving corner. For `move`, where that grabbed cell has got to. */
  to: { x: number; y: number; z: number };
  /** `move` frames are previews; `end` is the one that should be committed. */
  phase: 'move' | 'end';
}

interface OrbitLike {
  target: THREE.Vector3;
  update: () => void;
  enabled: boolean;
}

/**
 * Hands the page a function that renders one frame and returns it as a PNG data URL.
 *
 * The explicit render is the load-bearing line: without `preserveDrawingBuffer` (off for
 * performance, and rightly), the drawing buffer's contents are undefined the moment the
 * browser composites, so reading the canvas cold returns black. Rendering and reading in the
 * same task is defined behavior everywhere.
 */
function Snapshot({ register }: { register?: (take: (() => string) | null) => void }) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    if (!register) return;
    register(() => {
      gl.render(scene, camera);
      return gl.domElement.toDataURL('image/png');
    });
    return () => register(null);
  }, [register, gl, scene, camera]);

  return null;
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

  // Read by the auto-frame below without being a dependency of it: a re-frame provoked by the
  // build changing shape must keep whatever the camera was pointed at, and taking the focus
  // as a dependency would instead make every change of focus re-run the *automatic* framing
  // as well as the requested one.
  const focus = useRef(view?.focus ?? null);
  focus.current = view?.focus ?? null;

  // On the build changing *shape* — a new structure, a resize — and on nothing else. Keyed on
  // the three numbers rather than on the size object, which the layouter rebuilds on every
  // recompile: an object identity here meant the camera snapped back to the whole building
  // every time a wall moved, which is unusable once it is pointed at one room.
  useEffect(() => {
    frameCamera(camera, controls, size, 'iso', empty, focus.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [camera, controls, size.x, size.y, size.z, empty]);

  useEffect(() => {
    if (!view) return;
    frameCamera(camera, controls, size, view.kind, empty, view.focus ?? null);
    // `view.nonce` rather than `view`: pressing the same preset twice must re-frame, and the
    // page hands over a new object either way.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [camera, controls, size.x, size.y, size.z, empty, view?.nonce]);

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
  focus: FocusBox | null = null,
): void {
  if (focus) {
    frameBox(camera, controls, focus, kind);
    return;
  }
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
  } else if (camera instanceof THREE.OrthographicCamera) {
    frameOrtho(camera, radius * 1.35);
  }
  if (controls) {
    controls.target.copy(target);
    controls.update();
  } else {
    camera.lookAt(target);
  }
}

/**
 * Size an orthographic camera so a sphere of `radius` blocks fills the frame.
 *
 * An ortho camera has no distance-based framing — position only decides what is clipped —
 * so the zoom is solved against the camera's own half-extents, which r3f keeps equal to the
 * viewport's pixel dimensions. The narrower axis governs, same as the perspective solve.
 */
function frameOrtho(camera: THREE.OrthographicCamera, radius: number): void {
  const halfWidth = (camera.right - camera.left) / 2;
  const halfHeight = (camera.top - camera.bottom) / 2;
  camera.zoom = Math.min(halfWidth, halfHeight) / Math.max(1, radius);
  camera.far = 8000;
  camera.updateProjectionMatrix();
}

/** Breathing room around a framed box, as a fraction of its bounding sphere. */
const FOCUS_MARGIN = 1.25;

/**
 * Point the camera at a box, close enough that the box fills the frame.
 *
 * The distance is solved against the camera's own field of view rather than taken as a
 * multiple of the box, and specifically against the *narrower* of the two: the layouter's
 * model sits in a tall, narrow column, where the horizontal field is barely half the vertical
 * one, and a distance chosen from the vertical field alone puts the near walls of a room off
 * both sides of the panel. Solving it means the framing is right in a column, in a wide panel
 * and on a phone, with no multiplier to re-tune per layout.
 */
function frameBox(camera: THREE.Camera, controls: OrbitLike | null, box: FocusBox, kind: ViewKind): void {
  // `max` is inclusive, so the far face is one block past it.
  const target = new THREE.Vector3(
    (box.min.x + box.max.x + 1) / 2,
    (box.min.y + box.max.y + 1) / 2,
    (box.min.z + box.max.z + 1) / 2,
  );
  const half = new THREE.Vector3(
    (box.max.x - box.min.x + 1) / 2,
    (box.max.y - box.min.y + 1) / 2,
    (box.max.z - box.min.z + 1) / 2,
  );
  const radius = Math.max(1, half.length()) * FOCUS_MARGIN;

  const direction = (
    kind === 'top'
      ? new THREE.Vector3(0.001, 1, 0.001)
      : kind === 'front'
        ? new THREE.Vector3(0, 0.35, 1)
        : kind === 'side'
          ? new THREE.Vector3(1, 0.35, 0)
          : new THREE.Vector3(0.85, 0.8, 1)
  ).normalize();

  let distance = radius * 2.4;
  if (camera instanceof THREE.PerspectiveCamera) {
    const vertical = THREE.MathUtils.degToRad(camera.fov);
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
    distance = radius / Math.sin(Math.min(vertical, horizontal) / 2);
    camera.near = Math.max(0.05, distance / 500);
    camera.far = Math.max(2000, distance * 8);
    camera.updateProjectionMatrix();
  } else if (camera instanceof THREE.OrthographicCamera) {
    frameOrtho(camera, radius);
  }

  camera.position.copy(target).addScaledVector(direction, distance);
  if (controls) {
    controls.target.copy(target);
    controls.update();
  } else {
    camera.lookAt(target);
  }
}

/**
 * Everything that makes the Enhanced style a *place* rather than a void: sun, sky light,
 * a gradient dome, fog, and filmic tonemapping. Mounted only when Enhanced is on, and its
 * teardown puts every renderer-level setting back, so toggling to Classic really is Classic.
 */
function Environment({ size }: { size: VoxelGrid['size'] }) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const radius = Math.max(size.x, size.y, size.z);

  useEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.35;
    // Fog from the build's own scale: near enough to feel the air, far enough that the
    // whole structure is always crisp at its opening framing.
    scene.fog = new THREE.Fog(SKY_HORIZON, radius * 3.5, radius * 14);
    return () => {
      gl.toneMapping = THREE.NoToneMapping;
      gl.toneMappingExposure = 1;
      scene.fog = null;
    };
  }, [gl, scene, radius]);

  const sky = useMemo(() => {
    const geometry = new THREE.SphereGeometry(1600, 24, 16);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        zenith: { value: new THREE.Color(SKY_ZENITH) },
        horizon: { value: new THREE.Color(SKY_HORIZON) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 zenith;
        uniform vec3 horizon;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          gl_FragColor = vec4(mix(horizon, zenith, pow(h, 0.55)), 1.0);
        }
      `,
    });
    return { geometry, material };
  }, []);

  useEffect(
    () => () => {
      sky.geometry.dispose();
      sky.material.dispose();
    },
    [sky],
  );

  return (
    <>
      {/* Physically-sized lights (r155+ semantics): Lambert divides by π, so intensities
          look large. The hemisphere carries the scene; the sun carries the direction. */}
      <hemisphereLight args={['#c3d7ff', '#57503f', 2.5]} />
      <directionalLight
        color={SUN_COLOR}
        intensity={2.8}
        position={[size.x * 1.1, radius * 1.5, size.z * 0.55]}
      />
      <mesh
        geometry={sky.geometry}
        material={sky.material}
        position={[size.x / 2, 0, size.z / 2]}
        renderOrder={-1}
      />
    </>
  );
}

/**
 * WASD flight (E up, Q down), layered over the orbit controls rather than replacing them:
 * the keys translate the camera *and* its orbit target together, so flying and orbiting
 * compose instead of fighting. Speed scales with the build so a cottage and a castle both
 * feel right.
 */
const FLY_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);

function Fly() {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as unknown as OrbitLike | null;
  const held = useRef(new Set<string>());

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const key = event.key.toLowerCase();
      if (FLY_KEYS.has(key)) held.current.add(key);
    };
    const up = (event: KeyboardEvent) => held.current.delete(event.key.toLowerCase());
    const clear = () => held.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    // Alt-tabbing away mid-flight must not leave a key latched down forever.
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
    };
  }, []);

  const forward = useMemo(() => new THREE.Vector3(), []);
  const right = useMemo(() => new THREE.Vector3(), []);
  const move = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, delta) => {
    const keys = held.current;
    if (keys.size === 0) return;
    const anchor = controls?.target ?? camera.position;
    const speed = Math.max(12, anchor.distanceTo(camera.position) * 0.9) * Math.min(delta, 0.1);

    camera.getWorldDirection(forward);
    // Travel stays level: flying forward moves across the world, not into the ground.
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    right.crossVectors(forward, UP);

    move.set(0, 0, 0);
    if (keys.has('w')) move.add(forward);
    if (keys.has('s')) move.sub(forward);
    if (keys.has('d')) move.add(right);
    if (keys.has('a')) move.sub(right);
    if (keys.has('e')) move.y += 1;
    if (keys.has('q')) move.y -= 1;
    if (move.lengthSq() === 0) return;

    move.normalize().multiplyScalar(speed);
    camera.position.add(move);
    if (controls) {
      controls.target.add(move);
      controls.update();
    }
  });

  return null;
}

const UP = new THREE.Vector3(0, 1, 0);

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
  region,
  regionDrag = false,
  onHover,
  onClick,
  onStroke,
  onPick,
  onRegionDrag,
}: {
  grid: VoxelGrid;
  layerClip: number | null;
  layerFloor: number;
  region?: Box | null;
  /** True while a tool that owns rectangular selections is active. */
  regionDrag?: boolean;
  onHover?: (hit: VoxelHit | null) => void;
  onClick?: (hit: VoxelHit) => void;
  onStroke?: (hits: VoxelHit[]) => void;
  onPick?: (hit: VoxelHit) => void;
  onRegionDrag?: (drag: RegionDrag) => void;
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
  const notifyRegion = useRef(onRegionDrag);
  notifyRegion.current = onRegionDrag;
  // Read inside the pointer handlers, which are bound once — a re-bind on every selection
  // change would drop the gesture halfway through the drag that caused it.
  const live = useRef({ region, regionDrag });
  live.current = { region, regionDrag };

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

    /**
     * A selection being drawn or moved.
     *
     * `plane` is only used by a move: dragging a box across uneven geometry by whatever cell
     * the ray happens to hit makes it jump a storey every time the pointer crosses a roof.
     * Projecting onto the horizontal plane the grab started on keeps the motion equal to the
     * pointer's, which is what "dragging" is supposed to mean.
     */
    let boxDrag: { mode: 'draw' | 'move'; from: VoxelHit; plane: THREE.Plane | null } | null = null;
    const planePoint = new THREE.Vector3();

    const onPlane = (event: PointerEvent, plane: THREE.Plane): { x: number; z: number } | null => {
      const rect = canvas.getBoundingClientRect();
      ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const point = raycaster.ray.intersectPlane(plane, planePoint);
      return point ? { x: point.x, z: point.z } : null;
    };

    const inside = (box: Box, at: VoxelHit) =>
      at.x >= box.min.x && at.x <= box.max.x &&
      at.y >= box.min.y && at.y <= box.max.y &&
      at.z >= box.min.z && at.z <= box.max.z;

    const endBoxDrag = (event: PointerEvent, deliver: boolean) => {
      const drag = boxDrag;
      boxDrag = null;
      if (controls) controls.enabled = true;
      if (!drag || !deliver) return;
      const to = boxTarget(event, drag);
      if (to) notifyRegion.current?.({ mode: drag.mode, from: drag.from, to, phase: 'end' });
    };

    /** Where the drag has got to, in the space the drag runs in. */
    const boxTarget = (
      event: PointerEvent,
      drag: { mode: 'draw' | 'move'; from: VoxelHit; plane: THREE.Plane | null },
    ): { x: number; y: number; z: number } | null => {
      if (drag.mode === 'draw') return cast(event);
      if (!drag.plane) return null;
      const at = onPlane(event, drag.plane);
      if (!at) return null;
      // Floor, not round: the plane point is a position on a face and the cell it belongs to
      // is the one it sits inside. Rounding puts a half-block bias into every drag.
      return { x: Math.floor(at.x), y: drag.from.y, z: Math.floor(at.z) };
    };

    const endStroke = (deliver: boolean) => {
      const cells = stroke;
      stroke = null;
      if (controls) controls.enabled = true;
      if (deliver && cells && cells.length > 0) notifyStroke.current?.(cells);
    };

    const down = (event: PointerEvent) => {
      downAt = { x: event.clientX, y: event.clientY, button: event.button };

      // A selection drag, when a selection tool is active and the press landed on something.
      // Pressing empty space still orbits, which is what keeps the camera usable without a
      // modifier: the build is the thing you draw boxes on, the sky is the thing you spin.
      if (event.button === 0 && !event.shiftKey && live.current.regionDrag && notifyRegion.current) {
        const first = cast(event);
        if (first) {
          const current = live.current.region;
          const mode = current && inside(current, first) ? 'move' : 'draw';
          boxDrag = {
            mode,
            from: first,
            plane:
              mode === 'move'
                // The horizontal plane through the top of the grabbed cell, so the box slides
                // along the surface it was picked up from.
                ? new THREE.Plane(new THREE.Vector3(0, 1, 0), -(first.y + 0.5))
                : null,
          };
          if (controls) controls.enabled = false;
          canvas.setPointerCapture(event.pointerId);
          event.preventDefault();
          // Report the press itself, so a click that never moves still starts a 1x1x1 box
          // rather than doing nothing at all.
          notifyRegion.current({ mode, from: first, to: first, phase: 'move' });
          return;
        }
      }

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
      if (boxDrag) {
        const to = boxTarget(event, boxDrag);
        if (to) notifyRegion.current?.({ mode: boxDrag.mode, from: boxDrag.from, to, phase: 'move' });
        return;
      }

      const next = cast(event);
      show(next);
      if (!stroke || !next) return;
      const last = stroke[stroke.length - 1];
      if (last && last.x === next.x && last.y === next.y && last.z === next.z) return;
      stroke.push(next);
    };

    const up = (event: PointerEvent) => {
      if (boxDrag) {
        endBoxDrag(event, true);
        downAt = null;
        return;
      }

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

    const cancel = (event: PointerEvent) => {
      endBoxDrag(event, false);
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

/**
 * The standing box selection.
 *
 * Mint rather than the preview's amber, and that separation earns its keep: both are on screen
 * at once whenever the pointer is over a build with a box already selected, and two amber
 * outlines would be two guesses about which one the next click acts on.
 */
function RegionOutline({
  min,
  max,
}: {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}) {
  const object = useMemo(() => {
    const box = new THREE.Box3(
      new THREE.Vector3(min.x, min.y, min.z),
      new THREE.Vector3(max.x + 1, max.y + 1, max.z + 1),
    );
    const helper = new THREE.Box3Helper(box, new THREE.Color(HOVER_COLOR));
    (helper.material as THREE.Material).dispose();
    helper.material = new THREE.LineBasicMaterial({
      color: HOVER_COLOR,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
    });
    helper.renderOrder = 4;
    return helper;
  }, [min.x, min.y, min.z, max.x, max.y, max.z]);

  useEffect(
    () => () => {
      object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    },
    [object],
  );

  return <primitive object={object} renderOrder={4} />;
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
