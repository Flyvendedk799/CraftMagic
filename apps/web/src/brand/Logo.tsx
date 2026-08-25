/**
 * The CraftMagic mark and lockup.
 *
 * One voxel drawn as three faces, with a spark of magic on the top corner — a build and the
 * AI that makes it, in a single glyph. Every place that draws the logo draws it from here, so
 * the geometry exists once: the nav, the landing footer and `public/brand/*.svg` are the same
 * four paths, and a change to the mark cannot land in one of them and miss the others.
 *
 * The variants are the ones the brand pack specifies, not a free-form colour prop. A logo that
 * can be tinted arbitrarily stops being a logo, and the two that matter in practice — mint on
 * the dark UI, and a darker mix that survives a light or printed background — are easy to pick
 * wrong when the caller has to name six hex values to get one.
 */

import './brand.css';

/** Which fixed colourway to draw. See `public/brand/README.md` for when each one applies. */
export type MarkVariant =
  /** Default. Mint on the dark UI. */
  | 'brand'
  /** Darkened faces for light and printed backgrounds. */
  | 'light'
  /** White, for a single-ink context. */
  | 'mono'
  /** Mint-only, for a tinted single-ink context. */
  | 'mint'
  /** Near-black, for sitting *inside* a mint fill. */
  | 'knockout';

interface Faces {
  top: string;
  left: string;
  right: string;
  spark: string;
}

const FACES: Record<MarkVariant, Faces> = {
  brand: { top: '#6ee7b7', left: '#2f8f6f', right: '#227a5c', spark: '#bff7e2' },
  light: { top: '#3fbf90', left: '#227a5c', right: '#186247', spark: '#0f1216' },
  mono: { top: '#ffffff', left: '#b8bdc4', right: '#8b929b', spark: '#ffffff' },
  mint: { top: '#9df3d0', left: '#4bbf95', right: '#2f8f6f', spark: '#d6faec' },
  knockout: { top: '#0f1216', left: '#0a3226', right: '#072019', spark: '#0f1216' },
};

export interface MarkProps {
  /** Rendered edge length in px. The mark is square. */
  size?: number;
  variant?: MarkVariant;
  /**
   * The spark is four thin points and turns to mush below about 24px, so anything smaller
   * should drop it. Defaults to on, since the sizes that need it off are the rare ones.
   */
  spark?: boolean;
  className?: string;
  /**
   * Only set this when the mark is the *only* thing identifying CraftMagic. Beside the
   * wordmark it is decorative, and a second "CraftMagic" in the accessibility tree is noise.
   */
  title?: string;
}

export function Mark({ size = 32, variant = 'brand', spark = true, className, title }: MarkProps) {
  const faces = FACES[variant];
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d="M16 3 L28 9.5 L16 16 L4 9.5 Z" fill={faces.top} />
      <path d="M4 9.5 L16 16 L16 29 L4 22.5 Z" fill={faces.left} />
      <path d="M28 9.5 L16 16 L16 29 L28 22.5 Z" fill={faces.right} />
      {spark && (
        <path
          d="M24.5 3.5 l1 2.4 2.4 1 -2.4 1 -1 2.4 -1 -2.4 -2.4 -1 2.4 -1 Z"
          fill={faces.spark}
        />
      )}
    </svg>
  );
}

export interface LogoProps extends Omit<MarkProps, 'title' | 'className'> {
  /** Wordmark size in px. Defaults to a ratio the brand pack's primary lockup uses. */
  wordSize?: number;
  /**
   * Colours "Magic" mint. The brand pack keeps this for the wordmark standing alone — beside
   * the mark, two mint elements compete.
   */
  twoTone?: boolean;
  className?: string;
}

/**
 * Mark plus wordmark, the primary lockup.
 *
 * The wordmark is live text in Space Grotesk rather than an SVG outline, so it stays selectable,
 * scales with the user's font settings and needs no separate asset per colourway. It degrades to
 * the body stack if the webfont has not arrived — a slightly wrong logo for one frame beats an
 * invisible one.
 */
export function Logo({
  size = 30,
  wordSize,
  variant = 'brand',
  spark = true,
  twoTone = false,
  className,
}: LogoProps) {
  return (
    <span className={className ? `logo ${className}` : 'logo'}>
      <Mark size={size} variant={variant} spark={spark} />
      <span className="logo__word" style={wordSize ? { fontSize: `${wordSize}px` } : undefined}>
        Craft
        <span className={twoTone ? 'logo__word-accent' : undefined}>Magic</span>
      </span>
    </span>
  );
}
