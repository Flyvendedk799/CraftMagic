/**
 * Draw around the thing you want built.
 *
 * A freehand outline rather than a rectangle, because the ask is "this person, not the fence
 * behind them" and a box around a person contains a great deal of fence. The outline is used
 * two ways: its bounding box crops the picture, and the shape itself masks everything outside
 * it to white, so what reaches the model is the subject and nothing else.
 *
 * Everything outside the outline is dimmed on screen as it is drawn, which is the same
 * information the model will get — what you see dark is what it will not see at all.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { LoadedImage, Point } from './source.js';

export interface FocusOutlineProps {
  image: LoadedImage;
  outline: Point[];
  onChange: (outline: Point[]) => void;
  /** Widest the canvas may be drawn, in CSS pixels. */
  maxWidth: number;
  disabled?: boolean;
}

/** Tallest the canvas may get, so a portrait photograph cannot push the buttons off screen. */
const MAX_HEIGHT = 260;

/** Points closer together than this add nothing but work. */
const MIN_STEP = 3;

export function FocusOutline({ image, outline, onChange, maxWidth, disabled }: FocusOutlineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);

  const scale = Math.min(maxWidth / image.width, MAX_HEIGHT / image.height, 1);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  // Repainted from scratch on every change rather than drawn incrementally: the picture
  // underneath has to be redrawn anyway to un-dim what the last stroke dimmed.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image.element, 0, 0, width, height);
    if (outline.length < 2) return;

    const trace = () => {
      ctx.beginPath();
      outline.forEach((point, index) => {
        const x = point.x * scale;
        const y = point.y * scale;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    };

    // Dim everything the outline does not enclose: one path made of the whole canvas and the
    // outline, filled even-odd, which leaves the subject at full brightness.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    outline.forEach((point, index) => {
      const x = point.x * scale;
      const y = point.y * scale;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(8, 11, 15, 0.66)';
    ctx.fill('evenodd');
    ctx.restore();

    trace();
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#5ee7a0';
    ctx.stroke();
  }, [image, outline, scale, width, height]);

  const pointAt = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): Point => {
      const rect = event.currentTarget.getBoundingClientRect();
      // Through the displayed size rather than the backing size: the canvas is laid out by CSS
      // and the two are only equal until someone opens the page on a zoomed display.
      return {
        x: ((event.clientX - rect.left) / rect.width) * image.width,
        y: ((event.clientY - rect.top) / rect.height) * image.height,
      };
    },
    [image.width, image.height],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    onChange([pointAt(event)]);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const point = pointAt(event);
    const last = outline[outline.length - 1];
    if (last && Math.abs(last.x - point.x) < MIN_STEP && Math.abs(last.y - point.y) < MIN_STEP) return;
    onChange([...outline, point]);
  };

  const finish = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    // Two points enclose nothing, so a stray click clears the outline rather than leaving a
    // line that the crop would then treat as a subject.
    if (outline.length < 3) onChange([]);
  };

  return (
    <canvas
      ref={canvasRef}
      className="picture__canvas"
      width={width}
      height={height}
      style={{ width, height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      aria-label="Draw around the subject to build"
    />
  );
}
