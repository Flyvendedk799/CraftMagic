/**
 * The hero's prompt box, typing itself.
 *
 * Its own component so that typing a character re-renders a span rather than the landing page.
 *
 * The prompts are real ones — the same phrasing the generator is good at, and the first of
 * them is the cottage the hero is assembling behind the text. Showing a prompt the product
 * would handle badly is a promise the next screen has to break.
 */

import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './useLandingMotion.js';

const PROMPTS = [
  'a cozy oak cottage with a stone chimney',
  'a round stone watchtower on a cliff',
  'a small fishing hut on wooden stilts',
  'a medieval market stall with a striped awning',
];

/** Milliseconds. Typing is jittered so it reads as typed rather than as a marquee. */
const TYPE_MIN = 42;
const TYPE_JITTER = 45;
const DELETE = 22;
/** Long enough to read the finished prompt before it is taken away. */
const HOLD = 1700;
const BETWEEN = 320;

export function TypedPrompt() {
  const [text, setText] = useState(() => (prefersReducedMotion() ? (PROMPTS[0] ?? '') : ''));
  // Held across timeouts so the cleanup can cancel whichever one is pending.
  const timer = useRef(0);

  useEffect(() => {
    if (prefersReducedMotion()) return;

    let promptIndex = 0;
    let length = 0;
    let deleting = false;

    const tick = () => {
      const prompt = PROMPTS[promptIndex] ?? '';
      if (deleting) {
        length--;
        setText(prompt.slice(0, length));
        if (length <= 0) {
          deleting = false;
          promptIndex = (promptIndex + 1) % PROMPTS.length;
          timer.current = window.setTimeout(tick, BETWEEN);
          return;
        }
        timer.current = window.setTimeout(tick, DELETE);
        return;
      }

      length++;
      setText(prompt.slice(0, length));
      if (length >= prompt.length) {
        deleting = true;
        timer.current = window.setTimeout(tick, HOLD);
        return;
      }
      timer.current = window.setTimeout(tick, TYPE_MIN + Math.random() * TYPE_JITTER);
    };

    tick();
    return () => window.clearTimeout(timer.current);
  }, []);

  return (
    <div className="landing__prompt">
      <span className="landing__prompt-chevron" aria-hidden="true">
        &gt;
      </span>
      {/* Announced as one changing region rather than letter by letter: a screen reader
          reading a prompt being typed out one character at a time is unusable. */}
      <span className="landing__prompt-text" aria-live="polite" aria-atomic="true">
        {text}
      </span>
      <span className="landing__caret" aria-hidden="true" />
    </div>
  );
}
