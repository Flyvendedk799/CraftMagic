/**
 * The two pieces of scroll-driven motion the landing page runs.
 *
 * Both write to the DOM rather than to React state, and for the same reason: they fire on
 * every scroll event and neither one changes what the page *is*. Reveals set an attribute the
 * stylesheet already has a rule for; progress sets one custom property that the bar, the rail
 * fill and the travelling block all read. Routed through `useState` this would re-render the
 * whole page a few dozen times a second to move a 2px bar.
 */

import { useEffect, type RefObject } from 'react';

/** True when the reader has asked for less movement. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Fades and lifts every `[data-reveal]` inside `rootRef` as it scrolls into view.
 *
 * Each element is unobserved once it has played. A reveal that re-runs when you scroll back up
 * turns a page you are re-reading into a page that keeps flickering at you.
 */
export function useRevealOnScroll(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));

    if (prefersReducedMotion()) {
      for (const target of targets) target.dataset.reveal = 'shown';
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.reveal = 'shown';
          observer.unobserve(entry.target);
        }
      },
      // The bottom inset holds the reveal back until the element is properly in the viewport
      // rather than one pixel over the edge, so it plays where it can be seen.
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [rootRef]);
}

/**
 * Publishes how far down the page the reader is as `--scroll-progress`, a unitless 0–1.
 *
 * One property, three consumers: the bar across the top, the fill in the left rail, and the
 * block that rides down it. Keeping it a single number is what keeps those three in step —
 * they cannot disagree about where the page is.
 */
export function useScrollProgress(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let queued = 0;
    const write = () => {
      queued = 0;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const progress = scrollable > 0 ? window.scrollY / scrollable : 0;
      root.style.setProperty('--scroll-progress', String(Math.min(1, Math.max(0, progress))));
    };
    // Coalesced to one write per frame. Scroll events can outpace the compositor, and every
    // extra write is a style recalculation that changes nothing visible.
    const onScroll = () => {
      if (!queued) queued = requestAnimationFrame(write);
    };

    write();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      if (queued) cancelAnimationFrame(queued);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [rootRef]);
}
