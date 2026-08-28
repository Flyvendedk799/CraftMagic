/**
 * Isometric pictures of saved builds, rendered in the browser.
 *
 * The library used to be a table, on the reasoning that thumbnails would mean fetching,
 * expanding and meshing every build to draw a grid of pictures. That reasoning was right
 * about the cost and wrong about who pays it: a build is a *thing someone made*, and a list
 * that identifies it by "19×17×19, 818 blocks" asks them to remember which of their builds
 * was the 818-block one. So the cost is paid, but only where it has to be —
 *
 *   **Lazily.** Nothing is fetched until the card is on screen. A library of forty builds
 *   that the user scrolls two rows into renders six pictures, not forty.
 *
 *   **Once.** Results are cached for the session under the build's `updatedAt`, so scrolling
 *   back up, or coming back from the editor, costs nothing and shows nothing stale.
 *
 *   **One at a time.** Meshing is synchronous and the renderer is a single shared WebGL
 *   context. Six cards appearing at once would otherwise mesh six builds back to back in one
 *   frame and freeze the page for as long as that took; a queue turns the same work into
 *   pictures that arrive one after another over a responsive page.
 *
 * The renderer itself is the guide's — the same class that draws its step-by-step
 * filmstrip, from the same mesher the editor uses. A second isometric renderer would be a
 * second set of framing, winding and transparency rules to keep in step with the first, and
 * the first is already load-bearing for something that gets printed.
 */

import { useEffect, useRef, useState } from 'react';
import { paletteColors, paletteFlags } from '@craftmagic/core';
import { IsoFilmstrip } from '../guide/isoRender.js';
import { getBuild } from './library.js';

/** Rendered at 2× the largest size any card displays, so it stays sharp on a retina screen. */
const WIDTH = 512;
const HEIGHT = 384;

export type ThumbnailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; src: string }
  /** Never surfaced as an error: a card without a picture is still a usable card. */
  | { status: 'failed' };

/** Session cache, keyed so an edited build re-renders and a re-listed one does not. */
const cache = new Map<string, string>();

/**
 * The render queue.
 *
 * A promise chain rather than a worker pool, because there is exactly one WebGL context to
 * feed and meshing runs on this thread either way. The chain is what guarantees that two
 * cards coming into view together become two renders in two frames rather than one long one.
 */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  // Failures must not poison the chain for every card behind them.
  queue = next.catch(() => undefined);
  return next;
}

/**
 * A picture of one saved build, fetched and drawn the first time its card is on screen.
 *
 * Returns a ref to attach to the card. Nothing happens until that element intersects the
 * viewport — which, on a library the user opens and immediately scrolls, is most of the work
 * never done at all.
 */
export function useThumbnail(id: string, version: string): [ThumbnailState, (node: Element | null) => void] {
  const key = `${id}@${version}`;
  const [state, setState] = useState<ThumbnailState>(() => {
    const hit = cache.get(key);
    return hit ? { status: 'ready', src: hit } : { status: 'idle' };
  });

  // Held in a ref so the observer effect does not re-run — and re-observe — every time the
  // state it is driving changes.
  const seen = useRef(false);
  const [node, setNode] = useState<Element | null>(null);

  useEffect(() => {
    const hit = cache.get(key);
    if (hit) {
      setState({ status: 'ready', src: hit });
      return;
    }
    // A new key is a different picture, so whatever was on screen no longer describes it.
    seen.current = false;
    setState({ status: 'idle' });
  }, [key]);

  useEffect(() => {
    if (!node || cache.has(key)) return;

    // Unmounting cannot cancel a render already in the queue — it has a WebGL context to
    // hand back — so it only stops the result being written into a component that is gone.
    // The cache still takes it, which is what makes scrolling back up instant.
    let live = true;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        if (seen.current) return;
        seen.current = true;

        setState({ status: 'loading' });
        enqueue(() => render(id))
          .then((src) => {
            cache.set(key, src);
            if (live) setState({ status: 'ready', src });
          })
          .catch(() => {
            if (live) setState({ status: 'failed' });
          });
      },
      // A margin, so a card one flick away is already drawing by the time it lands.
      { rootMargin: '300px' },
    );

    observer.observe(node);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [node, id, key]);

  return [state, setNode];
}

/**
 * Fetch one build and draw it, exactly once.
 *
 * The renderer is disposed on the way out whatever happens: it is refcounted at module scope
 * in `isoRender`, and a leaked reference would keep a WebGL context alive for the session.
 */
async function render(id: string): Promise<string> {
  const detail = await getBuild(id);
  const size = detail.grid.size;
  const palette = detail.grid.palette;

  // `highlight: false`: the two-tone palette exists so a guide can show what one step added,
  // and a thumbnail of a finished build has nothing new in it — with highlighting on, every
  // block would render as the muted "already built" tone.
  const strip = new IsoFilmstrip(size, paletteColors(palette), paletteFlags(palette), false);
  try {
    strip.fill(Uint16Array.from(detail.grid.voxels));
    const src = strip.snapshot(WIDTH, HEIGHT);
    if (!src || src === 'data:,') throw new Error('empty render');
    return src;
  } finally {
    strip.dispose();
  }
}
