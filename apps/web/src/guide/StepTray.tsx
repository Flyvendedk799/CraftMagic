import type { BlockstateGlyph, StepTrayItem } from '@craftmagic/core';
import { Swatch } from './primitives.js';

export interface StepTrayProps {
  items: readonly StepTrayItem[];
  className?: string;
}

export function StepTray({ items, className }: StepTrayProps) {
  if (!items || items.length === 0) return null;

  return (
    <div className={['step-tray', className].filter(Boolean).join(' ')} role="list">
      {items.map((item) => {
        const pills = getStatePills(item.glyph);
        return (
          <div className="tray-item" key={item.canonicalRef} role="listitem">
            <span className="tray-item__qty">{item.count}×</span>
            <span className="tray-item__swatch">
              <Swatch block={item.block} small />
            </span>
            <span className="tray-item__name">{item.displayName}</span>
            <span className="tray-item__glyph" aria-hidden="true">
              <GlyphIcon glyph={item.glyph} />
            </span>
            {pills.length > 0 && (
              <span className="tray-item__pills">
                {pills.map((pill) => (
                  <span className="tray-item__pill" key={pill}>
                    {pill}
                  </span>
                ))}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatShape(shape: string): string {
  return shape
    .split('_')
    .map(capitalize)
    .join(' ');
}

export function getStatePills(glyph: BlockstateGlyph): string[] {
  const pills: string[] = [];

  switch (glyph.kind) {
    case 'stairs': {
      if (glyph.facing) pills.push(capitalize(glyph.facing));
      if (glyph.half === 'top') pills.push('Upside-Down');
      if (glyph.shape && glyph.shape !== 'straight') pills.push(formatShape(glyph.shape));
      break;
    }
    case 'slab': {
      if (glyph.half === 'top') pills.push('Top');
      else if (glyph.half === 'bottom') pills.push('Bottom');
      break;
    }
    case 'pillar': {
      if (glyph.axis === 'y') pills.push('Vertical');
      else if (glyph.axis === 'x') pills.push('Horizontal X');
      else if (glyph.axis === 'z') pills.push('Horizontal Z');
      break;
    }
    case 'door':
    case 'trapdoor': {
      if (glyph.facing) pills.push(capitalize(glyph.facing));
      if (glyph.half === 'top' || glyph.half === 'upper') pills.push('Upper');
      else if (glyph.half === 'bottom' || glyph.half === 'lower') pills.push('Lower');
      break;
    }
    default:
      break;
  }

  return pills;
}

export function GlyphIcon({ glyph }: { glyph: BlockstateGlyph }) {
  switch (glyph.kind) {
    case 'stairs':
      return <StairsGlyph glyph={glyph} />;
    case 'slab':
      return <SlabGlyph glyph={glyph} />;
    case 'pillar':
      return <PillarGlyph glyph={glyph} />;
    case 'door':
      return <DoorGlyph glyph={glyph} />;
    case 'trapdoor':
      return <TrapdoorGlyph glyph={glyph} />;
    case 'generic':
    default:
      return <GenericGlyph />;
  }
}

function StairsGlyph({ glyph }: { glyph: BlockstateGlyph }) {
  const isTop = glyph.half === 'top';
  // Profile points: upright steps up from left to right; inverted drops down
  const profilePoints = isTop
    ? '2,2 18,2 18,10 10,10 10,18 2,18'
    : '2,18 18,18 18,10 10,10 10,2 2,2';

  // Facing arrow
  let arrow: { x1: number; y1: number; x2: number; y2: number; hx: number; hy: number } | null = null;
  if (glyph.facing === 'north') {
    arrow = { x1: 14, y1: 15, x2: 14, y2: 6, hx: 14, hy: 4 };
  } else if (glyph.facing === 'south') {
    arrow = { x1: 14, y1: 5, x2: 14, y2: 14, hx: 14, hy: 16 };
  } else if (glyph.facing === 'east') {
    arrow = { x1: 5, y1: 6, x2: 14, y2: 6, hx: 16, hy: 6 };
  } else if (glyph.facing === 'west') {
    arrow = { x1: 15, y1: 6, x2: 6, y2: 6, hx: 4, hy: 6 };
  }

  return (
    <svg viewBox="0 0 20 20" width="16" height="16" className="glyph-svg glyph--stairs">
      <polygon
        points={profilePoints}
        fill="currentColor"
        fillOpacity="0.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {arrow && (
        <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1={arrow.x1} y1={arrow.y1} x2={arrow.x2} y2={arrow.y2} />
          {glyph.facing === 'north' && <polyline points="11,8 14,5 17,8" fill="none" />}
          {glyph.facing === 'south' && <polyline points="11,12 14,15 17,12" fill="none" />}
          {glyph.facing === 'east' && <polyline points="12,3 15,6 12,9" fill="none" />}
          {glyph.facing === 'west' && <polyline points="8,3 5,6 8,9" fill="none" />}
        </g>
      )}
    </svg>
  );
}

function SlabGlyph({ glyph }: { glyph: BlockstateGlyph }) {
  const isTop = glyph.half === 'top';
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" className="glyph-svg glyph--slab">
      <rect
        x="2.5"
        y="2.5"
        width="15"
        height="15"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeDasharray="2,2"
        opacity="0.5"
      />
      <rect
        x="2.5"
        y={isTop ? '2.5' : '10'}
        width="15"
        height="7.5"
        rx="1"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function PillarGlyph({ glyph }: { glyph: BlockstateGlyph }) {
  if (glyph.axis === 'x') {
    return (
      <svg viewBox="0 0 20 20" width="16" height="16" className="glyph-svg glyph--pillar-x">
        <rect x="2" y="5" width="16" height="10" rx="1.5" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.2" />
        <line x1="4" y1="10" x2="16" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <polyline points="7,7 4,10 7,13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <polyline points="13,7 16,10 13,13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (glyph.axis === 'z') {
    return (
      <svg viewBox="0 0 20 20" width="16" height="16" className="glyph-svg glyph--pillar-z">
        <rect x="5" y="2" width="10" height="16" rx="1.5" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.2" />
        <line x1="10" y1="4" x2="10" y2="16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <polyline points="7,7 10,4 13,7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <polyline points="7,13 10,16 13,13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  // Default 'y' vertical concentric rings
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" className="glyph-svg glyph--pillar-y">
      <circle cx="10" cy="10" r="7.5" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="10" cy="10" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="10" cy="10" r="1.5" fill="currentColor" />
    </svg>
  );
}

function DoorGlyph({ glyph }: { glyph: BlockstateGlyph }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" className="glyph-svg glyph--door">
      <rect x="4" y="2" width="12" height="16" rx="1" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.4" />
      <line x1="4" y1="10" x2="16" y2="10" stroke="currentColor" strokeWidth="1" strokeDasharray="2,2" opacity="0.6" />
      <circle cx="6.5" cy="11.5" r="1.2" fill="currentColor" />
      {/* Swing arc */}
      <path d="M 16,18 A 6,6 0 0 0 10,18" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2,2" />
    </svg>
  );
}

function TrapdoorGlyph({ glyph }: { glyph: BlockstateGlyph }) {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" className="glyph-svg glyph--trapdoor">
      <rect x="2.5" y="2.5" width="15" height="15" rx="1.5" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.3" />
      <line x1="2.5" y1="10" x2="17.5" y2="10" stroke="currentColor" strokeWidth="1" />
      <line x1="10" y1="2.5" x2="10" y2="17.5" stroke="currentColor" strokeWidth="1" />
      {/* Hinge at top */}
      <line x1="5" y1="2.5" x2="7" y2="2.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <line x1="13" y1="2.5" x2="15" y2="2.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function GenericGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" className="glyph-svg glyph--generic">
      {/* Isometric cube tile */}
      <polygon points="10,2.5 17,6.5 10,10.5 3,6.5" fill="currentColor" fillOpacity="0.6" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <polygon points="3,6.5 10,10.5 10,17.5 3,13.5" fill="currentColor" fillOpacity="0.35" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <polygon points="10,10.5 17,6.5 17,13.5 10,17.5" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}
