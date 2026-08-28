/**
 * Picture to structure.
 *
 * Two things a picture can become, and they are genuinely different jobs:
 *
 *  - **Full picture** rebuilds the image itself as a wall or a floor, one block per pixel.
 *    That is arithmetic — match each colour to the block that looks most like it — so it runs
 *    here in the browser, costs nothing, and gives back exactly the picture that went in. A
 *    model asked to do the same would produce something that merely resembled it, slowly, for
 *    money.
 *  - **Focus** takes the thing you drew around and asks the model to *build* it: a statue, a
 *    tower, a ship — a structure that reads as the subject rather than a flat copy of it. That
 *    needs judgement about shape and material, which is exactly what the model is for.
 *
 * Which one is wanted is not something the app can infer from the picture, so it is a choice
 * with the difference spelled out on screen, including which of the two spends a generation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildMural,
  MURAL_ORIENTATIONS,
  MURAL_PALETTES,
  muralSize,
  paletteColors,
  type MuralOrientation,
  type MuralPalette,
  type VoxelGrid,
} from '@craftmagic/core';
import { registerMuralBuild } from '../editor/builds.js';
import { FocusOutline } from './FocusOutline.js';
import {
  cropToImage,
  loadImageFile,
  samplePixels,
  ImageError,
  type LoadedImage,
  type Point,
} from './source.js';

export interface FocusRequest {
  /** What to ask for, in words. The picture carries the rest. */
  prompt: string;
  image: { data: string; mediaType: string };
}

export interface ImagePanelProps {
  /** A picture was rebuilt as blocks; the id selects it in the editor. */
  onBuilt: (id: string, name: string) => void;
  /** Build the subject of the picture with the model. */
  onFocus: (request: FocusRequest) => void;
  /** A generation is already running. */
  busy: boolean;
  /** Whether a generation can be started at all — signed in, in budget. */
  canGenerate: boolean;
}

type Mode = 'full' | 'focus';

/** Widest the preview and the outline canvas are drawn, in CSS pixels. */
const CANVAS_WIDTH = 300;

const MIN_WIDE = 16;
const MAX_WIDE = 256;

export function ImagePanel({ onBuilt, onFocus, busy, canGenerate }: ImagePanelProps) {
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('full');

  const [blocksWide, setBlocksWide] = useState(64);
  const [orientation, setOrientation] = useState<MuralOrientation>('wall');
  const [palette, setPalette] = useState<MuralPalette>('full');
  const [dither, setDither] = useState(false);

  const [outline, setOutline] = useState<Point[]>([]);
  const [hint, setHint] = useState('');
  const [dragging, setDragging] = useState(false);

  const fileRef = useRef<HTMLInputElement | null>(null);

  // The object URL behind the picture is a real resource; dropping the reference without
  // revoking it holds the whole file in memory for the life of the tab.
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);

  const take = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const loaded = await loadImageFile(file);
      setImage((previous) => {
        if (previous) URL.revokeObjectURL(previous.url);
        return loaded;
      });
      setOutline([]);
    } catch (err) {
      setError(err instanceof ImageError ? err.message : 'That picture could not be read.');
    }
  }, []);

  /**
   * The mural, recomputed whenever anything about it changes.
   *
   * Deliberately at the real block size rather than at some preview resolution: the count and
   * the material list have to be the ones the build will actually have, and matching 40,000
   * pixels against 170 blocks is a few milliseconds' work.
   */
  const mural = useMemo(() => {
    if (!image || mode !== 'full') return null;
    try {
      return buildMural(samplePixels(image, blocksWide, orientation), { palette, orientation, dither });
    } catch {
      return null;
    }
  }, [image, mode, blocksWide, orientation, palette, dither]);

  const size = image ? muralSize(image.width, image.height, blocksWide, orientation) : null;

  const build = () => {
    if (!mural || !image) return;
    const id = registerMuralBuild(image.name, mural.grid);
    onBuilt(id, image.name);
  };

  const generate = () => {
    if (!image) return;
    const crop = cropToImage(image, outline);
    const drawn = outline.length >= 3;
    onFocus({
      prompt:
        (hint.trim() ||
          (drawn
            ? 'Build the subject outlined in this picture as a Minecraft structure.'
            : 'Build what this picture shows as a Minecraft structure.')) +
        (drawn ? '' : ' The whole picture is the subject.'),
      image: { data: crop.data, mediaType: crop.mediaType },
    });
  };

  return (
    <div className="picture">
      {!image ? (
        <div
          className={`picture__drop ${dragging ? 'picture__drop--over' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void take(event.dataTransfer.files[0]);
          }}
        >
          <p className="picture__drop-title">Drop a picture here</p>
          <button type="button" className="picture__link" onClick={() => fileRef.current?.click()}>
            or choose a file
          </button>
        </div>
      ) : (
        <>
          <div className="picture__head">
            <span className="picture__name" title={image.name}>
              {image.name}
            </span>
            <span className="picture__dims">
              {image.width}×{image.height}
            </span>
            <button type="button" className="picture__link" onClick={() => fileRef.current?.click()}>
              Change
            </button>
          </div>

          <div className="picture__modes" role="radiogroup" aria-label="What to make from the picture">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'full'}
              className={`picture__mode ${mode === 'full' ? 'picture__mode--on' : ''}`}
              onClick={() => setMode('full')}
            >
              Full picture
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'focus'}
              className={`picture__mode ${mode === 'focus' ? 'picture__mode--on' : ''}`}
              onClick={() => setMode('focus')}
            >
              Focus
            </button>
          </div>

          {mode === 'full' ? (
            <>
              <p className="picture__note">
                The picture itself, rebuilt block by block. No model call — it is free and
                exact.
              </p>

              <MuralPreview grid={mural?.grid ?? null} width={CANVAS_WIDTH} />

              <label className="param">
                <span className="param__label">Width</span>
                <input
                  className="param__slider"
                  type="range"
                  min={MIN_WIDE}
                  max={MAX_WIDE}
                  step={8}
                  value={blocksWide}
                  onChange={(event) => setBlocksWide(Number(event.target.value))}
                />
                <span className="param__value">{size ? `${size.width}×${size.height}` : '—'}</span>
              </label>

              <Choice
                label="Facing"
                options={MURAL_ORIENTATIONS}
                value={orientation}
                onChange={setOrientation}
              />
              <Choice label="Blocks" options={MURAL_PALETTES} value={palette} onChange={setPalette} />

              <label className="picture__check">
                <input
                  type="checkbox"
                  checked={dither}
                  onChange={(event) => setDither(event.target.checked)}
                />
                <span>
                  Dither
                  <span className="picture__muted">
                    {' '}
                    · mixes blocks for shades it has no block for
                  </span>
                </span>
              </label>

              <button type="button" className="picture__primary" onClick={build} disabled={!mural}>
                Build the picture
              </button>

              {mural && (
                <p className="picture__stats">
                  {mural.blockCount.toLocaleString()} blocks · {mural.materials.length} kinds
                  {mural.materials[0] && (
                    <span className="picture__muted">
                      {' '}
                      · mostly {label(mural.materials[0].block)}
                    </span>
                  )}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="picture__note">
                Drag around a person or an object. The model builds <em>that</em> as a
                structure — not a flat copy of the picture.
              </p>

              <FocusOutline
                image={image}
                outline={outline}
                onChange={setOutline}
                maxWidth={CANVAS_WIDTH}
                disabled={busy}
              />

              <p className="picture__stats">
                {outline.length >= 3 ? (
                  <>
                    Outlined — everything dark is left out.
                    <button type="button" className="picture__link" onClick={() => setOutline([])}>
                      Clear
                    </button>
                  </>
                ) : (
                  <span className="picture__muted">
                    Nothing outlined yet — the whole picture would be sent.
                  </span>
                )}
              </p>

              <textarea
                className="prompt__input picture__hint"
                value={hint}
                onChange={(event) => setHint(event.target.value)}
                placeholder="anything to add? e.g. build it as a stone statue"
                rows={2}
                maxLength={400}
                disabled={busy}
                aria-label="Extra instructions for building the subject"
              />

              <button
                type="button"
                className="picture__primary"
                onClick={generate}
                disabled={busy || !canGenerate}
                title={canGenerate ? 'Uses one of today generations' : 'Sign in to generate'}
              >
                Build the subject
              </button>
              <p className="picture__stats picture__muted">
                Uses one generation, like a written prompt.
              </p>
            </>
          )}
        </>
      )}

      {error && (
        <p className="picture__error" role="alert">
          {error}
        </p>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="picture__file"
        onChange={(event) => {
          void take(event.target.files?.[0]);
          // Cleared so choosing the same file twice still fires a change.
          event.target.value = '';
        }}
      />
    </div>
  );
}

/** A row of mutually exclusive chips, the same shape as the size chooser on the prompt. */
function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { id: T; label: string; hint: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="picture__choice">
      <p className="picture__choice-label">{label}</p>
      <div className="picture__chips" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            title={option.hint}
            className={`picture__chip ${value === option.id ? 'picture__chip--on' : ''}`}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The mural as it will be built, at one pixel per block.
 *
 * Painted from the finished grid rather than from the source picture, so what is on screen is
 * the blocks and not a smaller copy of the photograph — the whole question the preview answers
 * is whether the block version still reads.
 */
function MuralPreview({ grid, width }: { grid: VoxelGrid | null; width: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !grid) return;

    // A wall is drawn in x/y and a floor in x/z, and either way the top row of the preview is
    // the far side of the build.
    const flat = grid.size.y === 1;
    const across = grid.size.x;
    const down = flat ? grid.size.z : grid.size.y;

    const colors = paletteColors(grid.palette);
    const pixels = ctx.createImageData(across, down);
    for (let row = 0; row < down; row++) {
      for (let col = 0; col < across; col++) {
        const [x, y, z] = flat ? [col, 0, row] : [col, down - 1 - row, 0];
        const slot = grid.voxels[x + z * grid.size.x + y * grid.size.x * grid.size.z]!;
        const at = (row * across + col) * 4;
        pixels.data[at] = colors[slot * 3]!;
        pixels.data[at + 1] = colors[slot * 3 + 1]!;
        pixels.data[at + 2] = colors[slot * 3 + 2]!;
        pixels.data[at + 3] = slot === 0 ? 0 : 255;
      }
    }

    canvas.width = across;
    canvas.height = down;
    ctx.putImageData(pixels, 0, 0);
  }, [grid]);

  if (!grid) return <div className="picture__preview picture__preview--empty" />;

  const flat = grid.size.y === 1;
  const across = grid.size.x;
  const down = flat ? grid.size.z : grid.size.y;
  const scale = Math.min(width / across, 260 / down);

  return (
    <canvas
      ref={canvasRef}
      className="picture__preview"
      style={{ width: Math.round(across * scale), height: Math.round(down * scale) }}
      aria-label="The picture as blocks"
    />
  );
}

function label(block: string): string {
  return block
    .replace('minecraft:', '')
    .split('_')
    .join(' ');
}
