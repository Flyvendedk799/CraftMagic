import type { ViewOrientation } from '@craftmagic/core';
import { orientationLabel } from './isoRender.js';

export interface ViewpointBadgeProps {
  orientation: ViewOrientation;
  isFlipped?: boolean;
  className?: string;
}

export function ViewpointBadge({
  orientation,
  isFlipped = false,
  className = '',
}: ViewpointBadgeProps) {
  const label = orientationLabel(orientation);
  return (
    <span
      className={`viewpoint-badge ${isFlipped ? 'viewpoint-badge--flipped' : ''} ${className}`.trim()}
      title={isFlipped ? `Flipped to ${label} for visibility` : `Seen from ${label}`}
      role="status"
    >
      {isFlipped ? `↺ ${label}` : label}
    </span>
  );
}
