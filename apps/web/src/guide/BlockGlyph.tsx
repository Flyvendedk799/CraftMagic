import type { GlyphType } from '@craftmagic/core';

export interface BlockGlyphProps {
  glyphType?: GlyphType;
  states?: Record<string, string>;
  className?: string;
}

export function formatStatePills(glyphType?: GlyphType, states?: Record<string, string>): string[] {
  if (!states || Object.keys(states).length === 0) return [];
  const pills: string[] = [];

  const facing = states.facing ? capitalize(states.facing) : null;
  const half = states.half;
  const type = states.type;
  const axis = states.axis ? states.axis.toUpperCase() : null;
  const open = states.open;
  const hinge = states.hinge ? capitalize(states.hinge) : null;

  switch (glyphType) {
    case 'stairs': {
      if (facing) pills.push(facing);
      pills.push(half === 'top' ? 'Inverted' : 'Upright');
      if (states.shape && states.shape !== 'straight') {
        pills.push(formatShape(states.shape));
      }
      break;
    }
    case 'slab': {
      if (type === 'top') pills.push('Top slab');
      else if (type === 'double') pills.push('Double slab');
      else pills.push('Bottom slab');
      break;
    }
    case 'pillar': {
      if (axis) pills.push(`Axis: ${axis}`);
      break;
    }
    case 'trapdoor': {
      if (facing) pills.push(facing);
      pills.push(half === 'top' ? 'Top' : 'Bottom');
      pills.push(open === 'true' ? 'Open' : 'Closed');
      break;
    }
    case 'door': {
      if (facing) pills.push(facing);
      if (hinge) pills.push(`${hinge} hinge`);
      pills.push(open === 'true' ? 'Open' : 'Closed');
      break;
    }
    default: {
      if (facing) pills.push(facing);
      if (axis) pills.push(`Axis: ${axis}`);
      break;
    }
  }

  return pills;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function formatShape(shape: string): string {
  switch (shape) {
    case 'inner_left':
      return 'Inner L';
    case 'inner_right':
      return 'Inner R';
    case 'outer_left':
      return 'Outer L';
    case 'outer_right':
      return 'Outer R';
    default:
      return capitalize(shape.replace('_', ' '));
  }
}

export function BlockGlyph({ glyphType = 'general', states = {}, className = '' }: BlockGlyphProps) {
  const pills = formatStatePills(glyphType, states);
  const ariaLabel = `${capitalize(glyphType)}${pills.length > 0 ? ` (${pills.join(', ')})` : ''}`;

  return (
    <svg
      className={`glyph ${className}`.trim()}
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={ariaLabel}
    >
      {renderGlyphContent(glyphType, states)}
    </svg>
  );
}

function renderGlyphContent(glyphType: GlyphType, states: Record<string, string>) {
  switch (glyphType) {
    case 'stairs':
      return renderStairs(states);
    case 'slab':
      return renderSlab(states);
    case 'pillar':
      return renderPillar(states);
    case 'trapdoor':
      return renderTrapdoor(states);
    case 'door':
      return renderDoor(states);
    case 'general':
    default:
      return renderGeneral();
  }
}

function renderStairs(states: Record<string, string>) {
  const isInverted = states.half === 'top';
  const facing = states.facing ?? 'north';

  // Stair cross-section path
  // Upright: L-shaped with step on left/right or bottom-to-top
  // Inverted: flipped upside-down
  const stairPath = isInverted
    ? 'M 4,5 H 20 V 19 H 13 V 11 H 4 Z'
    : 'M 4,19 H 20 V 5 H 13 V 13 H 4 Z';

  // Directional ascent arrow
  let arrowPath = 'M 12,16 V 8 M 9,11 L 12,8 L 15,11'; // north (up)
  if (facing === 'south') {
    arrowPath = 'M 12,8 V 16 M 9,13 L 12,16 L 15,13'; // south (down)
  } else if (facing === 'east') {
    arrowPath = 'M 8,12 H 16 M 13,9 L 16,12 L 13,15'; // east (right)
  } else if (facing === 'west') {
    arrowPath = 'M 16,12 H 8 M 11,9 L 8,12 L 11,15'; // west (left)
  }

  return (
    <g>
      <path
        d={stairPath}
        fill="currentColor"
        fillOpacity={0.16}
        stroke="currentColor"
        strokeWidth={1.5}
      />
      <path d={arrowPath} stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </g>
  );
}

function renderSlab(states: Record<string, string>) {
  const type = states.type ?? 'bottom';

  if (type === 'double') {
    return (
      <g>
        <rect x="3" y="4" width="18" height="7" rx="1.5" fill="currentColor" fillOpacity={0.2} stroke="currentColor" strokeWidth={1.5} />
        <rect x="3" y="13" width="18" height="7" rx="1.5" fill="currentColor" fillOpacity={0.2} stroke="currentColor" strokeWidth={1.5} />
        <line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" strokeWidth={1} strokeDasharray="2 2" />
      </g>
    );
  }

  if (type === 'top') {
    return (
      <g>
        <rect x="3" y="4" width="18" height="7.5" rx="1.5" fill="currentColor" fillOpacity={0.24} stroke="currentColor" strokeWidth={1.5} />
        {/* Outline of lower half */}
        <rect x="3" y="13" width="18" height="7" rx="1.5" stroke="currentColor" strokeWidth={1} strokeDasharray="2 2" opacity={0.35} />
        {/* Up indicator */}
        <path d="M 12,18 V 15 M 10,16.5 L 12,14.5 L 14,16.5" stroke="currentColor" strokeWidth={1.5} />
      </g>
    );
  }

  // Bottom slab
  return (
    <g>
      <rect x="3" y="12.5" width="18" height="7.5" rx="1.5" fill="currentColor" fillOpacity={0.24} stroke="currentColor" strokeWidth={1.5} />
      {/* Outline of upper half */}
      <rect x="3" y="4" width="18" height="7" rx="1.5" stroke="currentColor" strokeWidth={1} strokeDasharray="2 2" opacity={0.35} />
      {/* Down indicator */}
      <path d="M 12,6 V 9 M 10,7.5 L 12,9.5 L 14,7.5" stroke="currentColor" strokeWidth={1.5} />
    </g>
  );
}

function renderPillar(states: Record<string, string>) {
  const axis = states.axis ?? 'y';

  if (axis === 'x') {
    // Horizontal along X axis (left-right)
    return (
      <g>
        <rect x="3" y="6" width="18" height="12" rx="2" fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeWidth={1.5} />
        <line x1="4" y1="10" x2="20" y2="10" stroke="currentColor" strokeWidth={1} opacity={0.4} />
        <line x1="4" y1="14" x2="20" y2="14" stroke="currentColor" strokeWidth={1} opacity={0.4} />
        <path d="M 1,12 H 3 M 21,12 H 23" stroke="currentColor" strokeWidth={2} />
      </g>
    );
  }

  if (axis === 'z') {
    // Horizontal along Z axis (depth / diagonal)
    return (
      <g>
        <rect x="4" y="5" width="16" height="14" rx="2" fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeWidth={1.5} />
        <line x1="8" y1="5" x2="8" y2="19" stroke="currentColor" strokeWidth={1} opacity={0.4} />
        <line x1="16" y1="5" x2="16" y2="19" stroke="currentColor" strokeWidth={1} opacity={0.4} />
        <path d="M 12,2 V 4 M 12,20 V 22" stroke="currentColor" strokeWidth={2} />
      </g>
    );
  }

  // Vertical (axis = y) — end-grain tree rings
  return (
    <g>
      <circle cx="12" cy="12" r="8.5" fill="currentColor" fillOpacity={0.12} stroke="currentColor" strokeWidth={1.5} />
      <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth={1} opacity={0.5} />
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
    </g>
  );
}

function renderTrapdoor(states: Record<string, string>) {
  const isOpen = states.open === 'true';
  const isTop = states.half === 'top';

  if (isOpen) {
    // Flapped open vertically
    return (
      <g>
        <rect x="4" y="3" width="5" height="18" rx="1" fill="currentColor" fillOpacity={0.2} stroke="currentColor" strokeWidth={1.5} />
        <circle cx="6.5" cy="5.5" r="1" fill="currentColor" />
        <line x1="4" y1="12" x2="9" y2="12" stroke="currentColor" strokeWidth={1} />
        <path d="M 12,12 H 18 M 16,9 L 19,12 L 16,15" stroke="currentColor" strokeWidth={1.5} />
      </g>
    );
  }

  // Closed
  const y = isTop ? 4 : 15;
  return (
    <g>
      <rect x="3" y={y} width="18" height="5" rx="1" fill="currentColor" fillOpacity={0.2} stroke="currentColor" strokeWidth={1.5} />
      <line x1="9" y1={y} x2="9" y2={y + 5} stroke="currentColor" strokeWidth={1} />
      <line x1="15" y1={y} x2="15" y2={y + 5} stroke="currentColor" strokeWidth={1} />
      {/* Ghost bounding */}
      <rect x="3" y="4" width="18" height="16" rx="1.5" stroke="currentColor" strokeWidth={1} strokeDasharray="2 2" opacity={0.25} />
    </g>
  );
}

function renderDoor(states: Record<string, string>) {
  const isRightHinge = states.hinge === 'right';
  const isOpen = states.open === 'true';

  return (
    <g>
      <rect x="5" y="3" width="14" height="18" rx="1.5" fill="currentColor" fillOpacity={0.15} stroke="currentColor" strokeWidth={1.5} />
      {/* Door panels */}
      <rect x="7" y="5" width="10" height="6" rx="0.5" stroke="currentColor" strokeWidth={1} opacity={0.5} />
      <rect x="7" y="13" width="10" height="6" rx="0.5" stroke="currentColor" strokeWidth={1} opacity={0.5} />
      {/* Knob */}
      <circle cx={isRightHinge ? 8 : 16} cy="12" r="1.2" fill="currentColor" />
      {isOpen && (
        <path d="M 2,12 L 5,12 M 3,10 L 1,12 L 3,14" stroke="currentColor" strokeWidth={1.5} />
      )}
    </g>
  );
}

function renderGeneral() {
  // Clean isometric cube
  return (
    <g fill="currentColor" stroke="currentColor" strokeWidth={1.2}>
      {/* Top face */}
      <polygon points="12,3 20,7.5 12,12 4,7.5" fillOpacity={0.3} />
      {/* Left face */}
      <polygon points="4,7.5 12,12 12,21 4,16.5" fillOpacity={0.15} />
      {/* Right face */}
      <polygon points="12,12 20,7.5 20,16.5 12,21" fillOpacity={0.22} />
    </g>
  );
}
