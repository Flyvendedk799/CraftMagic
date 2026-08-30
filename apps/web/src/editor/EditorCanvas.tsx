/**
 * The r3f side of the viewer.
 *
 * React's only job here is lifecycle: mount one `VoxelWorld` group into the scene, hand it
 * the grid, and tick it once a frame. Everything per-chunk stays out of the reconciler.
 *
 * The camera is *shared* rather than owned: OrbitControls drives it while the pointer is
 * down, and the view buttons in the status bar drive it the rest of the time. That works
 * only because a view button sends a command with a nonce instead of setting a value —
 * "put the camera at the front" is an event, and pressing it twice has to move the camera
 * twice.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { VoxelGrid } from '@craftmagic/core';
import { VoxelWorld } from './VoxelWorld.js';
import { raycastVoxel, type VoxelHit } from './raycast.js';
import type { CameraPreset, DisplayOptions, LayerRange, ViewCommand } from './viewport.js';

interface Vec3Int {
  x: number;
  y: number;
  z: number;
}

/** Where a ray crossed the horizontal plane, in grid coordinates. Fractional on purpose. */
export interface Ground {
  x: number;
  z: number;
}

export interface EditorCanvasProps {
  grid: VoxelGrid;
  paletteColors: Uint8Array;
  paletteFlags: Uint8Array;
  /** The visible band of layers; `null` shows the whole structure. */
  layerClip: LayerRange | null;
  display: DisplayOptions;
  /** Latest camera command from the status bar, or null before any has been issued. */
  view: ViewCommand | null;
  onHover?: (hit: VoxelHit | null) => void;
  /**
   * A click that was not a drag. The canvas only reports where it landed — which tool that
   * means, and what to do about it, is the page's business.
   */
  onClick?: (hit: VoxelHit) => void;
  /** A second highlight, e.g. the first corner of a box in progress. */
  marker?: { x: number; y: number; z: number } | null;
  /**
   * A box drawn around a region of the grid — the planner outlines whichever placement is
   * selected. Inclusive of `max`, like every other box in this codebase.
   */
  region?: { min: Vec3Int; max: Vec3Int } | null;
  /**
   * A press, offered to the caller before the camera gets it.
   *
   * The caller is handed both what the ray hit and where it crossed the ground plane, and
   * returns whether it wants the drag. Returning true takes the gesture: OrbitControls is
   * switched off for its duration and `onDragMove`/`onDragEnd` follow. This is how the
   * planner drags a building around without the camera orbiting underneath it, and it is a
   * gesture protocol rather than a planner feature so the canvas stays ignorant of plans.
   */
  onPress?: (hit: VoxelHit | null, ground: Ground) => boolean;
  onDragMove?: (ground: Ground) => void;
  onDragEnd?: (ground: Ground) => void;
  /** Chunks still queued or in flight, for a loading indicator. Fires only on change. */
  onProgress?: (remaining: number) => void;
  /**
   * Handed the live mesh manager on mount and `null` on teardown. Edits are applied through
   * it rather than by re-loading the grid, so the caller needs the handle.
   */
  onWorld?: (world: VoxelWorld | null) => void;
}

const BACKGROUND = '#0b0e13';

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
  display,
  view,
  onHover,
  onClick,
  marker,
  region,
  onPress,
  onDragMove,
  onDragEnd,
  onProgress,
  onWorld,
}: EditorCanvasProps) {
  const scene = useThree((state) => state.scene);
  const worldRef = useRef<VoxelWorld | null>(null);
  const clipRef = useRef(layerClip);
  clipRef.current = layerClip;
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;
  const worldCallback = useRef(onWorld);
  worldCallback.current = onWorld;
  const lastRemaining = useRef(-1);

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
    world.setLayerClip(clipRef.current);
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
    worldRef.current?.setLayerClip(layerClip);
  }, [layerClip]);

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
      <Framing size={grid.size} view={view} />
      <Furniture size={grid.size} display={display} />
      <Picker
        grid={grid}
        layerClip={layerClip}
        highlight={display.highlight}
        onHover={onHover}
        onClick={onClick}
        onPress={onPress}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
      />
      {marker && <Highlight at={marker} color="#fbbf24" />}
      {region && <RegionOutline region={region} />}
    </>
  );
}

/** Where a preset puts the camera, as a direction from the build's centre. */
const PRESET_DIRECTIONS: Record<Exclude<CameraPreset, 'frame'>, [number, number, number]> = {
  iso: [1.15, 0.8, 1.35],
  front: [0, 0.12, 1.9],
  side: [1.9, 0.12, 0],
  // Not perfectly vertical: OrbitControls has no defined azimuth looking straight down, and
  // the first drag afterwards snaps the scene through a quarter turn.
  top: [0.001, 1.9, 0.35],
};

/**
 * Point the camera at a new structure without remounting the canvas (and its GL context).
 *
 * Two triggers, and they mean different things. A new `size` is a *different build*: the
 * camera has to be re-framed or the old distance leaves a resized structure off screen.
 * A new `view` is the user asking, and `frame` re-fits from wherever they happen to be
 * standing rather than snapping back to iso.
 */
function Framing({ size, view }: { size: VoxelGrid['size']; view: ViewCommand | null }) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as unknown as OrbitLike | null;
  const lastNonce = useRef(view?.nonce ?? -1);

  const place = (preset: CameraPreset) => {
    const target = new THREE.Vector3(size.x / 2, size.y * 0.45, size.z / 2);
    const radius = Math.max(size.x, size.y, size.z);

    if (preset === 'frame') {
      // Keep the angle, fix the distance: framing is about seeing all of it, not about
      // disagreeing with the user over which side of the build is interesting.
      const direction = camera.position.clone().sub(controls?.target ?? target);
      if (direction.lengthSq() < 1e-6) direction.set(...PRESET_DIRECTIONS.iso);
      direction.setLength(radius * 1.9);
      camera.position.copy(target).add(direction);
    } else {
      const [dx, dy, dz] = PRESET_DIRECTIONS[preset];
      camera.position.set(target.x + radius * dx, target.y + radius * dy, target.z + radius * dz);
    }

    if (camera instanceof THREE.PerspectiveCamera) {
      camera.far = Math.max(2000, radius * 12);
      camera.updateProjectionMatrix();
    }
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
  };

  // A new build: frame it from the default angle.
  useEffect(() => {
    place('iso');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `place` closes over the props it needs
  }, [camera, controls, size]);

  // A view button. Guarded by the nonce so it fires once per press and not on every render.
  useEffect(() => {
    if (!view || view.nonce === lastNonce.current) return;
    lastNonce.current = view.nonce;
    place(view.preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [view, camera, controls]);

  return null;
}

interface OrbitLike {
  target: THREE.Vector3;
  update: () => void;
}

/** Ground grid and a bounds outline — without them a floating build has no readable scale. */
function Furniture({ size, display }: { size: VoxelGrid['size']; display: DisplayOptions }) {
  const helpers = useMemo(() => {
    const span = Math.ceil((Math.max(size.x, size.z) * 1.8) / 8) * 8;
    const grid = new THREE.GridHelper(span, span / 4, 0x3d4b5c, 0x1e242c);
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
      {/* `visible` rather than unmounting: these are two shared objects, and toggling them
          off should not cost a geometry rebuild the next time they come back. */}
      <primitive object={helpers.grid} visible={display.grid} />
      <primitive object={helpers.bounds} visible={display.bounds} />
    </>
  );
}

/**
 * Hover highlight, click reporting and the drag gesture, driven by the grid raycaster rather
 * than r3f's pointer events — the chunk meshes are not r3f objects, so they generate no
 * pointer events at all.
 */
function Picker({
  grid,
  layerClip,
  highlight,
  onHover,
  onClick,
  onPress,
  onDragMove,
  onDragEnd,
}: {
  grid: VoxelGrid;
  layerClip: LayerRange | null;
  highlight: boolean;
  onHover?: (hit: VoxelHit | null) => void;
  onClick?: (hit: VoxelHit) => void;
  onPress?: (hit: VoxelHit | null, ground: Ground) => boolean;
  onDragMove?: (ground: Ground) => void;
  onDragEnd?: (ground: Ground) => void;
}) {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as unknown as { enabled: boolean } | null;
  const [hit, setHit] = useState<VoxelHit | null>(null);

  // Through refs, because the parent re-renders on every hover and inline callbacks in the
  // dependency list would rebind the listeners on every pointer move.
  const notify = useRef(onHover);
  notify.current = onHover;
  const notifyClick = useRef(onClick);
  notifyClick.current = onClick;
  const press = useRef(onPress);
  press.current = onPress;
  const dragMove = useRef(onDragMove);
  dragMove.current = onDragMove;
  const dragEnd = useRef(onDragEnd);
  dragEnd.current = onDragEnd;

  useEffect(() => {
    const canvas = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    // The plane the drag runs on: y = 0, the ground the whole plot stands on.
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const groundPoint = new THREE.Vector3();

    const aim = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
    };

    const cast = (event: PointerEvent): VoxelHit | null => {
      aim(event);
      return raycastVoxel(grid, raycaster.ray.origin, raycaster.ray.direction, {
        // The layer range clips with planes, so the picker has to be told where the cuts are
        // or it would happily edit a block nobody on screen can see.
        maxY: layerClip?.max,
        minY: layerClip?.min,
      });
    };

    /**
     * Where the ray crosses the ground.
     *
     * Null when it does not — looking up at the sky, or exactly along the horizon. A drag
     * that cannot be projected is dropped rather than clamped to some enormous coordinate:
     * the alternative is a building teleporting to the far edge of the plot because the
     * camera drifted a degree above level.
     */
    const ground = (event: PointerEvent): Ground | null => {
      aim(event);
      const point = raycaster.ray.intersectPlane(groundPlane, groundPoint);
      return point ? { x: point.x, z: point.z } : null;
    };

    const pick = (event: PointerEvent) => {
      if (dragging) {
        const at = ground(event);
        if (at) dragMove.current?.(at);
        return;
      }
      const next = cast(event);
      setHit(next);
      notify.current?.(next);
    };

    const clear = () => {
      setHit(null);
      notify.current?.(null);
    };

    // The same drag that orbits the camera would otherwise also land an edit under the
    // cursor, so a click has to be distinguished from a drag by how far the pointer moved.
    // The threshold is in CSS pixels and generous enough to survive a shaky click.
    let downAt: { x: number; y: number; button: number } | null = null;
    let dragging = false;
    const DRAG_SLOP = 4;

    const down = (event: PointerEvent) => {
      downAt = { x: event.clientX, y: event.clientY, button: event.button };
      if (event.button !== 0) return;

      const at = ground(event);
      if (!at || !press.current) return;
      if (!press.current(cast(event), at)) return;

      // Taken. The camera must not orbit underneath a building being dragged, and the
      // pointer is captured so the gesture survives leaving the canvas.
      dragging = true;
      if (controls) controls.enabled = false;
      canvas.setPointerCapture(event.pointerId);
    };

    const up = (event: PointerEvent) => {
      const start = downAt;
      downAt = null;

      if (dragging) {
        dragging = false;
        if (controls) controls.enabled = true;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        const at = ground(event);
        if (at) dragEnd.current?.(at);
        return;
      }

      if (!start || start.button !== 0 || event.button !== 0) return;
      if (Math.abs(event.clientX - start.x) > DRAG_SLOP) return;
      if (Math.abs(event.clientY - start.y) > DRAG_SLOP) return;

      // Re-cast at the release point rather than reusing the hover state: hover is a frame
      // behind on a moving camera, and an edit landing one block off is not forgivable.
      const target = cast(event);
      if (target) notifyClick.current?.(target);
    };

    canvas.addEventListener('pointermove', pick);
    canvas.addEventListener('pointerleave', clear);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointerup', up);
    return () => {
      canvas.removeEventListener('pointermove', pick);
      canvas.removeEventListener('pointerleave', clear);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointerup', up);
      // A teardown mid-drag — the plan changed under the pointer — must not leave the camera
      // switched off for the rest of the session.
      if (dragging && controls) controls.enabled = true;
    };
  }, [gl, camera, controls, grid, layerClip]);

  if (!hit || !highlight) return null;
  return <Highlight at={hit} color="#6ee7b7" />;
}

/**
 * The outline around a selected region.
 *
 * `depthTest` off, like the hover highlight: the point of the outline is to tell you which
 * building you are about to move, and one hidden behind another is exactly when you need it.
 */
function RegionOutline({ region }: { region: { min: Vec3Int; max: Vec3Int } }) {
  const box = useMemo(
    () =>
      new THREE.Box3(
        new THREE.Vector3(region.min.x, region.min.y, region.min.z),
        new THREE.Vector3(region.max.x + 1, region.max.y + 1, region.max.z + 1),
      ),
    [region.min.x, region.min.y, region.min.z, region.max.x, region.max.y, region.max.z],
  );

  const helper = useMemo(() => {
    const created = new THREE.Box3Helper(box, new THREE.Color(0x6ee7b7));
    const material = created.material as THREE.LineBasicMaterial;
    material.depthTest = false;
    material.transparent = true;
    material.opacity = 0.95;
    created.renderOrder = 3;
    return created;
  }, [box]);

  useEffect(() => () => helper.geometry.dispose(), [helper]);

  return <primitive object={helper} />;
}

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
