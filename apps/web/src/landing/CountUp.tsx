/**
 * A number that counts up to itself the first time it is scrolled into view.
 *
 * The three figures in the hero are the ones worth arguing with — the block registry's size,
 * the mesher's real timing, the number of export paths — so they animate rather than sit
 * there. It runs once: a stat that re-counts every time it scrolls past reads as a widget
 * instead of a fact.
 */

import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './useLandingMotion.js';

export interface CountUpProps {
  /** The figure to land on. */
  value: number;
}

const DURATION = 1300;

export function CountUp({ value }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? value : 0));

  useEffect(() => {
    const element = ref.current;
    if (!element || prefersReducedMotion()) return;

    let frame = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        const start = performance.now();
        const step = (now: number) => {
          const progress = Math.min(1, (now - start) / DURATION);
          // Cubic ease-out: fast enough to register as motion, settling rather than stopping.
          setShown(Math.round(value * (1 - Math.pow(1 - progress, 3))));
          if (progress < 1) frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
      },
      // Most of the number has to be on screen: these sit low in the hero, and counting up
      // where only the top pixel is visible spends the animation off screen.
      { threshold: 0.6 },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [value]);

  return <span ref={ref}>{shown.toLocaleString()}</span>;
}
