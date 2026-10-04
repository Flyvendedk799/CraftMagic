import { useRef, type PointerEvent } from 'react';
import { clampWidth, type DockSide } from './layout.js';
export function ResizeHandle({
  side,
  width,
  onChange,
}: {
  side: DockSide;
  width: number;
  onChange: (width: number) => void;
}) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === event.pointerId) {
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  return (
    <div
      className={`workspace-resizer workspace-resizer--${side}`}
      role="separator"
      aria-label={`Resize ${side} panel`}
      aria-orientation="vertical"
      aria-valuemin={224}
      aria-valuemax={480}
      aria-valuenow={width}
      tabIndex={0}
      onDoubleClick={() => onChange(side === 'left' ? 272 : 300)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = { id: event.pointerId, x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.id === event.pointerId)
          onChange(
            clampWidth(
              start.width +
                (event.clientX - start.x) * (side === 'left' ? 1 : -1),
            ),
          );
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 8;
        let next = width;
        if (event.key === 'ArrowLeft') next += side === 'left' ? -step : step;
        else if (event.key === 'ArrowRight')
          next += side === 'left' ? step : -step;
        else if (event.key === 'Home') next = 224;
        else if (event.key === 'End') next = 480;
        else return;
        event.preventDefault();
        onChange(clampWidth(next));
      }}
    />
  );
}
