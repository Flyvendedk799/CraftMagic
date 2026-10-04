import type { LayoutPlan } from '../../architecture/plan.js';
/** A lightweight drawing of the actual ground-floor rooms, not a generic document icon. */
export function PlanThumbnail({ plan }: { plan: LayoutPlan }) {
  const rooms =
    plan.floors[0]?.items.filter((item) => item.kind === 'room') ?? [];
  return (
    <svg
      className="workspace-plan-thumbnail"
      viewBox={`0 0 ${plan.site.x} ${plan.site.z}`}
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      <rect width={plan.site.x} height={plan.site.z} fill="#172c3c" />
      {rooms.map(
        (room) =>
          room.kind === 'room' && (
            <g key={room.id}>
              <rect
                x={room.rect.x}
                y={room.rect.z}
                width={room.rect.w}
                height={room.rect.d}
                fill="#476b7e"
                stroke="#bad9df"
                strokeWidth={0.6}
              />
              {room.rect.w > 5 && room.rect.d > 5 && (
                <path
                  d={`M${room.rect.x + 1} ${room.rect.z + 1}h${room.rect.w - 2}v${room.rect.d - 2}h${2 - room.rect.w}z`}
                  fill="none"
                  stroke="#648899"
                  strokeWidth={0.3}
                />
              )}
            </g>
          ),
      )}
    </svg>
  );
}
