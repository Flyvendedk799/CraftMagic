/**
 * The r3f side of the viewer.
 *
 * React's only job here is lifecycle: mount one `VoxelWorld` group into the scene, hand it
 * the grid, and tick it once a frame. Everything per-chunk stays out of the reconciler.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { VoxelGrid } from '@imaginecraft/core';
import { VoxelWorld } from './VoxelWorld.js';
import { raycastVoxel, type VoxelHit } from './raycast.js';

export interface EditorCanvasProps {
  grid: VoxelGrid;
  paletteColors: Uint8Array;
  paletteFlags: Uint8Array;
  /** Highest visible layer; `null` shows the whole structure. */
  layerClip: number | null;
  onHover?: (hit: VoxelHit | null) => void;
  /**
   * A click that was not a drag. The canvas only reports where it landed — which tool that
   * means, and what to do about it, is the page's business.
   */
  onClick?: (hit: VoxelHit) => void;
  /** A second highlight, e.g. the first corner of a box in progress. */
  marker?: { x: number; y: number; z: number } | null;
  /** Chunks still queued or in flight, for a loading indicator. Fires only on change. */
  onProgress?: (remaining: number) => void;
  /**
   * Handed the live mesh manager on mount and `null` on teardown. Edits are applied through
   * it rather than by re-loading the grid, so the caller needs the handle.
   */
  onWorld?: (world: VoxelWorld | null) => void;
}

const BACKGROUND = '#0f1216';

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
  onHover,
  onClick,
  marker,
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
      <Framing size={grid.size} />
      <Furniture size={grid.size} />
      <Picker grid={grid} layerClip={layerClip} onHover={onHover} onClick={onClick} />
      {marker && <Highlight at={marker} color="#fbbf24" />}
    </>
  );
}

/** Point the camera at a new structure without remounting the canvas (and its GL context). */
function Framing({ size }: { size: VoxelGrid['size'] }) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as unknown as OrbitLike | null;

  useEffect(() => {
    const target = new THREE.Vector3(size.x / 2, size.y * 0.45, size.z / 2);
    const radius = Math.max(size.x, size.y, size.z);
    camera.position.set(
      target.x + radius * 1.15,
      target.y + radius * 0.8,
      target.z + radius * 1.35,
    );
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.far = Math.max(2000, radius * 12);
      camera.updateProjectionMatrix();
    }
    if (controls) {
      controls.target.copy(target);
      controls.update();
    }
  }, [camera, controls, size]);

  return null;
}

interface OrbitLike {
  target: THREE.Vector3;
  update: () => void;
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
 * Hover highlight and click reporting, driven by the grid raycaster rather than r3f's
 * pointer events — the chunk meshes are not r3f objects, so they generate no pointer events
 * at all.
 */
function Picker({
  grid,
  layerClip,
  onHover,
  onClick,
}: {
  grid: VoxelGrid;
  layerClip: number | null;
  onHover?: (hit: VoxelHit | null) => void;
  onClick?: (hit: VoxelHit) => void;
}) {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  const [hit, setHit] = useState<VoxelHit | null>(null);

  // Through refs, because the parent re-renders on every hover and inline callbacks in the
  // dependency list would rebind the listeners on every pointer move.
  const notify = useRef(onHover);
  notify.current = onHover;
  const notifyClick = useRef(onClick);
  notifyClick.current = onClick;

  useEffect(() => {
    const canvas = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    const cast = (event: PointerEvent): VoxelHit | null => {
      const rect = canvas.getBoundingClientRect();
      ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      return raycastVoxel(grid, raycaster.ray.origin, raycaster.ray.direction, {
        // The layer slider clips with a plane, so the picker has to be told where the cut is.
        maxY: layerClip ?? undefined,
      });
    };

    const pick = (event: PointerEvent) => {
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
    const DRAG_SLOP = 4;

    const down = (event: PointerEvent) => {
      downAt = { x: event.clientX, y: event.clientY, button: event.button };
    };

    const up = (event: PointerEvent) => {
      const start = downAt;
      downAt = null;
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
    };
  }, [gl, camera, grid, layerClip]);

  if (!hit) return null;
  return <Highlight at={hit} color="#6ee7b7" />;
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
