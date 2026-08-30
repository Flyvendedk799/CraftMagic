/**
 * Assemble-on-open: a build rises out of the ground, layer by layer, when it is opened.
 *
 * Not a shader trick and not a re-mesh storm. While the animation runs the canvas is handed a
 * *masked copy* of the build — same size, same palette, voxels all air — and the animation
 * reveals it by feeding the real values through `VoxelWorld.applyEdit`, the same incremental
 * path an editing stroke uses. YZX order makes this nearly free: a Y layer is one contiguous
 * slice of the voxel array, so revealing bottom-up is a walk forward through memory.
 *
 * The copy is the whole safety story. The session's real grid is never touched, so nothing
 * about editing, undo or export can be corrupted by an animation — the worst a bug here can
 * do is look wrong. When the last layer lands (or the user clicks, or a key is pressed, or
 * the build is huge, or the user prefers reduced motion) the page swaps the real grid back
 * in, the canvas does the same full load it would have done with no animation at all, and
 * the editor is exactly where it would have been anyway.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoxelGrid } from '@craftmagic/core';
import type { LoadedBuild } from './builds.js';
import type { VoxelWorld } from './VoxelWorld.js';

/** Total reveal time. Long enough to read as construction, short enough to never annoy. */
const DURATION_MS = 900;

/**
 * Builds bigger than this open instantly. The reveal applies every voxel through the edit
 * path in under a second; on the 200k-block stress field that is a hitch, not a show.
 */
const MAX_ASSEMBLE_BLOCKS = 150_000;

export interface Assembly {
	/** What the canvas should render right now: the masked copy mid-reveal, else the truth. */
	grid: VoxelGrid;
	assembling: boolean;
	/** Route the canvas's world handle here while assembling. */
	onWorld: (world: VoxelWorld | null) => void;
	/** Jump to the finished build. Any click or keypress during the reveal calls this. */
	skip: () => void;
}

export function useAssembly(build: LoadedBuild): Assembly {
	// Non-null only while the reveal for this exact build id is running.
	const [masked, setMasked] = useState<{ id: string; grid: VoxelGrid } | null>(null);
	const worldRef = useRef<VoxelWorld | null>(null);
	const frameRef = useRef(0);
	// The reveal's cursor: the next Y layer to land, and when the animation started.
	const progress = useRef({ layer: 0, start: 0 });
	const buildRef = useRef(build);
	buildRef.current = build;

	// A new build id starts a reveal; anything else (params, scale, style, edits) does not —
	// re-running the animation because a slider moved would punish the feature that matters.
	//
	// Derived *during render* rather than in an effect, deliberately: an effect runs after
	// the commit, so the finished build would flash for one frame before the mask replaced
	// it — the one artifact that makes a reveal look like a bug. Setting state during the
	// render of the same component is React's own pattern for this, and the `lastId` guard
	// is what keeps it to exactly one extra render per build switch.
	const lastId = useRef<string | null>(null);
	if (lastId.current !== build.id) {
		lastId.current = build.id;
		const still =
			typeof window.matchMedia === 'function' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (still || build.blockCount === 0 || build.blockCount > MAX_ASSEMBLE_BLOCKS) {
			if (masked) setMasked(null);
		} else {
			progress.current = { layer: 0, start: 0 };
			setMasked({
				id: build.id,
				grid: {
					size: build.grid.size,
					palette: [...build.grid.palette],
					voxels: new Uint16Array(build.grid.voxels.length),
				},
			});
		}
	}

	const finish = useCallback(() => {
		cancelAnimationFrame(frameRef.current);
		worldRef.current = null;
		setMasked(null);
	}, []);

	/** Reveal layers `from` (inclusive) to `to` (exclusive) through the edit path. */
	const reveal = useCallback((world: VoxelWorld, from: number, to: number) => {
		const source = buildRef.current.grid;
		const layerSize = source.size.x * source.size.z;
		// Sized for the worst case, trimmed to what the band actually holds.
		const indices: number[] = [];
		const after: number[] = [];
		const start = from * layerSize;
		const end = Math.min(to * layerSize, source.voxels.length);
		for (let i = start; i < end; i++) {
			const value = source.voxels[i]!;
			if (value === 0) continue;
			indices.push(i);
			after.push(value);
		}
		if (indices.length === 0) return;
		world.applyEdit({
			indices: Uint32Array.from(indices),
			// `before` exists for undo; the reveal is not undoable, so all-air is the truth.
			before: new Uint16Array(indices.length),
			after: Uint16Array.from(after),
		});
	}, []);

	const onWorld = useCallback(
		(world: VoxelWorld | null) => {
			worldRef.current = world;
			cancelAnimationFrame(frameRef.current);
			if (!world) return;

			const step = (now: number) => {
				const current = worldRef.current;
				if (!current) return;
				if (progress.current.start === 0) progress.current.start = now;

				const height = buildRef.current.grid.size.y;
				const due = Math.min(
					height,
					Math.ceil(((now - progress.current.start) / DURATION_MS) * height),
				);
				if (due > progress.current.layer) {
					reveal(current, progress.current.layer, due);
					progress.current.layer = due;
				}
				if (progress.current.layer >= height) {
					finish();
					return;
				}
				frameRef.current = requestAnimationFrame(step);
			};
			frameRef.current = requestAnimationFrame(step);
		},
		[reveal, finish],
	);

	useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

	return {
		grid: masked?.grid ?? build.grid,
		assembling: masked !== null,
		onWorld,
		skip: finish,
	};
}
