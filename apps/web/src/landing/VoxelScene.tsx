/**
 * The landing page's two three.js scenes.
 *
 * `assemble` is the hero: the cottage builds itself block by block, holds, lifts away and
 * starts again — the product's one-sentence pitch, running. `idle` is the editor showcase
 * behind the mock chrome, where the same cottage just turns, already finished.
 *
 * Imperative three rather than `@react-three/fiber`, which the editor uses. This scene has no
 * React state in it: every frame is a write to a `Mesh` the reconciler would otherwise have to
 * be told to leave alone, and the block count is fixed at mount. Fiber earns its keep in the
 * editor, where the scene graph *is* application state; here it would be a wrapper around one
 * `useEffect`.
 *
 * Two things this does that the design prototype could not:
 *
 * - It stops. The loop only runs while the canvas is on screen, so scrolling to the footer
 *   does not leave two WebGL contexts spinning, and everything is disposed on unmount — the
 *   landing page is one route in an SPA, and a leaked context per visit is a browser that
 *   eventually refuses to make another one.
 * - It respects `prefers-reduced-motion`: one frame of the finished build, no loop at all.
 */

import { useEffect, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import { buildCottage } from './cottage.js';

export interface VoxelSceneProps {
  /** `assemble` runs the build-up cycle; `idle` shows the finished cottage turning. */
  mode: 'assemble' | 'idle';
  /**
   * Element whose pointer position tilts the scene. The hero passes its own section rather
   * than the canvas: the canvas sits behind the headline and the buttons, so tracking it
   * directly would drop the parallax exactly where the cursor spends its time.
   */
  parallaxRef?: RefObject<HTMLElement | null>;
  className?: string;
}

/** Seconds between one block landing and the next starting to fall. */
const BLOCK_INTERVAL = 0.045;
/** Seconds a single block takes to drop in. */
const DROP_DURATION = 0.5;
/** Seconds the finished build is held before it lifts away. */
const HOLD = 2;
/** Seconds the build takes to rise and fade out. */
const DISPERSE = 1;
/** Seconds of empty stage before it starts again. */
const GAP = 0.4;

/**
 * A frame that took longer than this is treated as this long.
 *
 * Backgrounded tabs stop firing `requestAnimationFrame`, so the first frame after returning
 * carries the whole time away. Without the clamp the cottage jumps to a random point in its
 * cycle and every background cube teleports.
 */
const MAX_FRAME = 1 / 15;

export function VoxelScene({ mode, parallaxRef, className }: VoxelSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Written by the pointer handler, read by the frame loop. A ref rather than state: this
  // changes on every mouse move and no React output depends on it.
  const pointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const assembling = mode === 'assemble';
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

    const scene = new THREE.Scene();
    // Fogged to the page colour so the background cubes fade into it instead of ending.
    scene.fog = new THREE.Fog(0x0b0e12, 22, 46);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);

    // Ambient is high for a lit scene on purpose. three renders in managed colour space, where
    // an unlit face of a mid-tone block falls away to near-black against a near-black page and
    // the build loses its silhouette. Lifting the ambient fill puts the shaded faces back
    // where the design has them without touching any hue.
    scene.add(new THREE.AmbientLight(0x8fa6b4, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 0.95);
    key.position.set(7, 14, 9);
    scene.add(key);
    // A mint rim from behind, so the silhouette separates from a near-black background.
    const rim = new THREE.DirectionalLight(0x6ee7b7, 0.4);
    rim.position.set(-8, 4, -6);
    scene.add(rim);
    const fill = new THREE.PointLight(0x6ee7b7, 0.6, 30, 1);
    fill.position.set(0, 4, 0);
    scene.add(fill);

    // Two groups: `spin` turns the build on its own axis, `tilt` leans the whole scene toward
    // the cursor. Nesting them keeps the parallax from fighting the rotation.
    const tilt = new THREE.Group();
    const spin = new THREE.Group();
    tilt.add(spin);
    scene.add(tilt);

    const model = buildCottage();
    const cube = new THREE.BoxGeometry(0.92, 0.92, 0.92);
    // One material per colour, not per block: 1,200 meshes sharing eight materials batch far
    // better than 1,200 materials, and the model only has eight colours in it.
    const materials = new Map<string, THREE.MeshLambertMaterial>();
    const blocks = model.map((block) => {
      const materialKey = `${block.colour}${block.glow ? 'g' : ''}`;
      let material = materials.get(materialKey);
      if (!material) {
        material = new THREE.MeshLambertMaterial({
          color: block.colour,
          emissive: block.glow ? 0x1f6f52 : 0x000000,
          transparent: true,
          opacity: block.glow ? 0.9 : 1,
        });
        materials.set(materialKey, material);
      }
      const mesh = new THREE.Mesh(cube, material);
      mesh.position.set(block.x, block.y, block.z);
      spin.add(mesh);
      return { mesh, block };
    });
    // The model spans y 0–7, so drop it by roughly half its height to turn about its middle.
    spin.position.set(0, -3.4, 0);

    // Ambient voxels drifting upward through the fog, well behind the build.
    const drifters = Array.from({ length: 46 }, (_, i) => {
      const edge = 0.15 + Math.random() * 0.4;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(edge, edge, edge),
        new THREE.MeshBasicMaterial({
          color: i % 2 ? 0x4ade80 : 0x6ee7b7,
          transparent: true,
          opacity: i % 2 ? 0.12 : 0.16,
        }),
      );
      mesh.position.set(
        (Math.random() - 0.5) * 34,
        (Math.random() - 0.5) * 26,
        -6 - Math.random() * 22,
      );
      mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
      scene.add(mesh);
      return { mesh, rise: 0.006 + Math.random() * 0.02, turn: 0.002 + Math.random() * 0.006 };
    });

    const assembleFor = model.length * BLOCK_INTERVAL + DROP_DURATION;
    const cycle = assembleFor + HOLD + DISPERSE + GAP;

    const resize = () => {
      const width = canvas.clientWidth || 1;
      const height = canvas.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();

      // Framing is recomputed here, not once at mount, because it depends on the shape of the
      // viewport. The hero looks well left of the build so the cottage lands in the right-hand
      // column beside the headline — but that only works while there *is* a right-hand column.
      // On a phone the copy runs the full width, so the build is centred behind it and pulled
      // back: the camera's field of view is vertical, and a narrow viewport crops the
      // horizontal one until a 7-block cottage fills the frame edge to edge.
      const beside = assembling && camera.aspect > 1.05;
      const distance = assembling ? (beside ? 22 : 32) : 18.5;
      camera.position.set(distance * 0.62, distance * 0.5, distance * 0.72);
      camera.lookAt(beside ? -6.2 : 0, 0.4, 0);
    };
    resize();

    /** Places every block for a given point in the assembly cycle. */
    const layout = (time: number) => {
      const disperseStart = assembleFor + HOLD;
      const away = time > disperseStart ? Math.min(1, (time - disperseStart) / DISPERSE) : 0;
      const lift = away * away;
      for (let i = 0; i < blocks.length; i++) {
        const entry = blocks[i];
        if (!entry) continue;
        const { mesh, block } = entry;
        const arrived = Math.min(1, Math.max(0, (time - i * BLOCK_INTERVAL) / DROP_DURATION));
        const eased = 1 - Math.pow(1 - arrived, 3);
        const scale = Math.max(0, eased * (1 - lift)) * 0.92;
        // Hidden rather than drawn at zero scale: a degenerate mesh still costs a draw call,
        // and for most of the cycle most of the build has not arrived yet.
        mesh.visible = scale > 0.002;
        mesh.scale.setScalar(scale);
        mesh.position.set(block.x, block.y + (1 - eased) * 6 + lift * 9, block.z);
      }
    };

    if (still) {
      // No cycle and no loop — one frame of the finished cottage, held.
      if (assembling) layout(assembleFor);
      renderer.render(scene, camera);
      const onResizeStill = () => {
        resize();
        renderer.render(scene, camera);
      };
      window.addEventListener('resize', onResizeStill);
      return () => {
        window.removeEventListener('resize', onResizeStill);
        dispose();
      };
    }

    const clock = new THREE.Clock();
    let elapsed = 0;
    let frame = 0;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const delta = Math.min(MAX_FRAME, clock.getDelta());
      elapsed += delta;
      // Per-frame increments below are written for 60fps and scaled by this, so a 120Hz
      // display does not run the whole scene at double speed.
      const steps = delta * 60;

      for (const drifter of drifters) {
        drifter.mesh.position.y += drifter.rise * steps;
        drifter.mesh.rotation.x += drifter.turn * steps;
        drifter.mesh.rotation.y += drifter.turn * steps;
        if (drifter.mesh.position.y > 15) drifter.mesh.position.y = -15;
      }

      spin.rotation.y += 0.0032 * steps;

      const towardX = assembling ? pointer.current.y * 0.12 : Math.sin(elapsed * 0.25) * 0.05;
      const towardZ = assembling ? -pointer.current.x * 0.12 : 0;
      // Framerate-independent easing: the same fraction of the remaining distance per unit of
      // time, rather than per frame.
      const ease = 1 - Math.pow(0.95, steps);
      tilt.rotation.x += (towardX - tilt.rotation.x) * ease;
      tilt.rotation.z += (towardZ - tilt.rotation.z) * ease;

      if (assembling) layout(elapsed % cycle);
      renderer.render(scene, camera);
    };

    // Only run while the canvas is on screen. Two WebGL contexts rendering a page the reader
    // has scrolled past is the most expensive thing this page could do for no benefit.
    const visibility = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          if (!frame) {
            // Discard the time spent off screen, or the first frame back would carry it.
            clock.getDelta();
            frame = requestAnimationFrame(draw);
          }
        } else if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
      },
      { threshold: 0 },
    );
    visibility.observe(canvas);

    window.addEventListener('resize', resize);

    const parallaxTarget = parallaxRef?.current;
    const onPointerMove = (event: PointerEvent) => {
      const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
      pointer.current.x = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
      pointer.current.y = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
    };
    if (assembling && parallaxTarget) {
      parallaxTarget.addEventListener('pointermove', onPointerMove);
    }

    function dispose() {
      renderer.dispose();
      cube.dispose();
      for (const material of materials.values()) material.dispose();
      for (const drifter of drifters) {
        drifter.mesh.geometry.dispose();
        (drifter.mesh.material as THREE.Material).dispose();
      }
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
      visibility.disconnect();
      window.removeEventListener('resize', resize);
      if (assembling && parallaxTarget) {
        parallaxTarget.removeEventListener('pointermove', onPointerMove);
      }
      dispose();
    };
  }, [mode, parallaxRef]);

  return <canvas className={className} ref={canvasRef} aria-hidden="true" />;
}
