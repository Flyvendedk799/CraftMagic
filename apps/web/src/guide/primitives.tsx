/**
 * The build guide's document primitives.
 *
 * Every page of a booklet is built from these five pieces, and they exist so that the design
 * decisions inside them are made once. A sheet's padding, the tracking on an eyebrow, the
 * fact that an art frame is paper-white in both themes and shows "Rendering…" until its
 * image lands — those are properties of *the guide*, not of the cover or of step 34, and a
 * component is the only way to say so in a way that cannot drift.
 *
 * They are deliberately thin: markup and class names, no state, no layout logic. The tokens
 * in `tokens.css` are what they are really made of.
 */

import type { CSSProperties, ReactNode } from 'react';
import { colorOf } from '@craftmagic/core';

/* --- sheets ----------------------------------------------------------------------------- */

/**
 * One page of the booklet.
 *
 * `break` is what a sheet does at a page boundary in print: `after` starts the next sheet on
 * a fresh page (the cover and the parts list each own one), `avoid` keeps a sheet whole
 * (a step card, which is useless split across a fold).
 */
export function Sheet({
  variant,
  break: breakMode,
  children,
}: {
  variant?: 'cover' | 'materials' | 'parts' | 'oversize';
  break?: 'after' | 'avoid';
  children: ReactNode;
}) {
  const className = [
    'sheet',
    variant ? `sheet--${variant}` : '',
    // Also the legacy hook the print rules already key off, kept so a stylesheet override
    // written against `.cover` or `.materials` does not silently stop applying.
    variant ?? '',
    breakMode ? `sheet--break-${breakMode}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return <article className={className}>{children}</article>;
}

/** The small uppercase label above a section. Never the page's own title. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

export function SheetTitle({ children }: { children: ReactNode }) {
  return <h2 className="sheet__title">{children}</h2>;
}

/** The one paragraph under a section title that says what the section is for. */
export function Lede({ children }: { children: ReactNode }) {
  return <p className="sheet__lede">{children}</p>;
}

/* --- art -------------------------------------------------------------------------------- */

/**
 * The paper-white box a drawing sits in.
 *
 * Takes children rather than a source because the booklet has two kinds of art with the same
 * frame — a `<canvas>` the layer plan is drawn into synchronously, and a `<img>` read back
 * from WebGL some seconds later — and the frame is the part that must not differ between
 * them.
 */
export function ArtFrame({
  size,
  caption,
  className,
  children,
}: {
  /** `cover` reserves a tall box; `panel` sits in the two-up step grid. */
  size: 'cover' | 'panel';
  caption?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={['art', `art--${size}`, className].filter(Boolean).join(' ')}>
      {children}
      {caption !== undefined && <figcaption className="art__caption">{caption}</figcaption>}
    </figure>
  );
}

/**
 * A rendered image, or the space it will occupy.
 *
 * The placeholder is the reason this exists rather than a bare `<img>`. A guide fills in over
 * several seconds; a frame that collapses to nothing until its image arrives makes the page
 * jump under the reader's cursor for the whole of that time. Reserving the box costs nothing
 * and the layout never moves.
 */
export function ArtImage({
  src,
  alt,
  className,
}: {
  src: string | undefined | null;
  alt: string;
  className?: string;
}) {
  if (!src) return <span className="art__wait">Rendering…</span>;
  return <img className={['art__image', className].filter(Boolean).join(' ')} src={src} alt={alt} />;
}

/* --- data ------------------------------------------------------------------------------- */

/** A block's colour, as the reader will see it in the world. */
export function Swatch({ block, small }: { block: string; small?: boolean }) {
  const [r, g, b] = colorOf(block);
  const style: CSSProperties = { background: `rgb(${r}, ${g}, ${b})` };
  return (
    <span
      className={small ? 'swatch swatch--small' : 'swatch'}
      style={style}
      aria-hidden="true"
    />
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <dl className="stats">{children}</dl>;
}

/**
 * One figure on the cover: a label, the number, and the caveat underneath.
 *
 * The note is not decoration. "4 layers" under a step count, "W × H × L" under three
 * dimensions — each answers the question the bare number provokes, and leaving it out is how
 * a cover ends up with a figure nobody can interpret.
 */
export function Stat({
  label,
  value,
  note,
  plain,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  /** Set for a word rather than a number, which should not be set in the mono face. */
  plain?: boolean;
}) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd className={plain ? 'stat__value stat__value--plain' : 'stat__value'}>{value}</dd>
      {note !== undefined && <dd className="stat__note">{note}</dd>}
    </div>
  );
}
