import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  chunkGuideVolumes,
  MAX_STEPS_PER_VOLUME,
  type BuildGuide,
  type BuildStep,
  type GuidePart,
  type GuideVolume,
  type MaterialCount,
} from '@craftmagic/core';
import type { LoadedBuild } from '../editor/builds.js';
import { CalloutTray } from './CalloutTray.js';
import { viewpointCaption } from './isoRender.js';
import { type LayerPlan } from './layerGrid.js';
import { LayerPlanCanvas } from './LayerPlanCanvas.js';
import {
  ArtFrame,
  ArtImage,
  Eyebrow,
  Lede,
  Sheet,
  SheetTitle,
  Stat,
  StatGrid,
  Swatch,
} from './primitives.js';
import { ViewpointBadge } from './ViewpointBadge.js';

export type BookletDensity = 1 | 2 | 4;

export interface BookletViewProps {
  build: LoadedBuild;
  guide: BuildGuide;
  plans: LayerPlan[];
  filmShots?: readonly string[];
  coverArt?: string | null;
  className?: string;
}

export function BookletView({
  build,
  guide,
  plans,
  filmShots = [],
  coverArt = null,
  className = '',
}: BookletViewProps) {
  const [params, setParams] = useSearchParams();

  // Density selector: 1-up, 2-up (default), 4-up steps per page
  const [density, setDensity] = useState<BookletDensity>(2);

  // Multi-volume chunking: at most MAX_STEPS_PER_VOLUME (200) steps per volume
  const volumes = useMemo(() => {
    return chunkGuideVolumes(guide.steps, MAX_STEPS_PER_VOLUME);
  }, [guide.steps]);

  // Sync selected volume with URL param ?volume=N
  const urlVolume = params.get('volume');
  const initialVolume = useMemo(() => {
    if (urlVolume) {
      const v = Number.parseInt(urlVolume, 10);
      if (Number.isFinite(v) && v >= 1 && v <= Math.max(1, volumes.length)) {
        return v;
      }
    }
    return 1;
  }, [urlVolume, volumes.length]);

  const [selectedVolumeIndex, setSelectedVolumeIndex] = useState(initialVolume);

  const activeVolumeIndex = Math.min(
    Math.max(1, selectedVolumeIndex),
    Math.max(1, volumes.length),
  );

  const currentVolume: GuideVolume = volumes[activeVolumeIndex - 1] ?? {
    volumeIndex: 1,
    totalVolumes: 1,
    title: 'Volume 1: Full Guide',
    startStep: 1,
    endStep: guide.steps.length,
    steps: guide.steps,
  };

  const handleSelectVolume = (volIndex: number) => {
    setSelectedVolumeIndex(volIndex);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('volume', String(volIndex));
        return next;
      },
      { replace: true },
    );
  };

  // Cumulative placed blocks
  const placedBy = useMemo(() => {
    let running = 0;
    return guide.steps.map((step) => (running += step.blocks.length));
  }, [guide.steps]);

  // Group volume steps into pages based on density
  const stepPages = useMemo(() => {
    const pages: BuildStep[][] = [];
    for (let i = 0; i < currentVolume.steps.length; i += density) {
      pages.push(currentVolume.steps.slice(i, i + density));
    }
    return pages;
  }, [currentVolume.steps, density]);

  // Front matter sheets for this volume
  const frontSheets = useMemo(() => {
    const sheets: Array<{ id: string; type: 'cover' | 'parts' | 'materials' }> = [
      { id: 'cover', type: 'cover' },
    ];
    if (currentVolume.volumeIndex === 1) {
      if (guide.parts.length > 0) {
        sheets.push({ id: 'parts', type: 'parts' });
      }
      sheets.push({ id: 'materials', type: 'materials' });
    }
    return sheets;
  }, [currentVolume.volumeIndex, guide.parts.length]);

  const totalPages = frontSheets.length + stepPages.length;

  return (
    <div
      className={`booklet booklet--${density}up ${className}`.trim()}
      data-density={density}
      data-volume={currentVolume.volumeIndex}
      data-total-volumes={volumes.length}
    >
      {/* Booklet Screen Controls & Toolbar (hidden during print) */}
      <nav className="booklet__toolbar no-print" aria-label="Booklet navigation and controls">
        {volumes.length > 1 && (
          <div className="booklet__volume-selector" role="region" aria-label="Volume selector">
            <span className="booklet__toolbar-label">VOLUME:</span>
            <div className="booklet__volume-tabs" role="tablist">
              {volumes.map((vol) => (
                <button
                  key={vol.volumeIndex}
                  type="button"
                  role="tab"
                  aria-selected={vol.volumeIndex === currentVolume.volumeIndex}
                  className={`booklet__tab ${
                    vol.volumeIndex === currentVolume.volumeIndex ? 'booklet__tab--active' : ''
                  }`}
                  onClick={() => handleSelectVolume(vol.volumeIndex)}
                >
                  Vol {vol.volumeIndex} ({vol.startStep}–{vol.endStep})
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="booklet__density-selector" role="group" aria-label="Steps per page density">
          <span className="booklet__toolbar-label">LAYOUT:</span>
          {([1, 2, 4] as const).map((d) => (
            <button
              key={d}
              type="button"
              className={`booklet__density-btn ${density === d ? 'booklet__density-btn--active' : ''}`}
              onClick={() => setDensity(d)}
            >
              {d}-up
            </button>
          ))}
        </div>

        <div className="booklet__toolbar-meta">
          <span className="booklet__page-count">
            {totalPages} {totalPages === 1 ? 'Page' : 'Pages'}
          </span>
          <button
            type="button"
            className="booklet__print-trigger"
            onClick={() => window.print()}
          >
            🖨️ Print Booklet
          </button>
        </div>
      </nav>

      {/* Pages Container */}
      <div className="booklet__pages">
        {/* Front matter: Cover Sheet */}
        <section className="booklet__page booklet__page--cover" aria-label="Manual Cover">
          <header className="booklet__running-header">
            <span className="booklet__running-title">
              CRAFTMAGIC MANUAL · {guide.name} · Volume {currentVolume.volumeIndex}
            </span>
          </header>

          <div className="booklet__page-body">
            <Sheet variant="cover">
              <Eyebrow>CraftMagic · Build Guide</Eyebrow>
              <h1 className="cover__title">{guide.name}</h1>
              {volumes.length > 1 && (
                <p className="cover__subtitle">
                  Volume {currentVolume.volumeIndex} of {volumes.length} · Steps {currentVolume.startStep}–{currentVolume.endStep}
                </p>
              )}
              {build.description && <p className="cover__lede">{build.description}</p>}

              <ArtFrame size="cover">
                <ArtImage
                  src={coverArt}
                  alt={`Finished ${guide.name}, seen from above at an angle`}
                />
              </ArtFrame>

              <StatGrid>
                <Stat
                  label="Dimensions"
                  value={`${guide.size.x} × ${guide.size.y} × ${guide.size.z}`}
                  note="W × H × L"
                />
                <Stat
                  label="Blocks"
                  value={guide.totalBlocks.toLocaleString()}
                  note={`${guide.materials.length} kinds`}
                />
                <Stat
                  label="Steps"
                  value={guide.steps.length.toLocaleString()}
                  note={`${new Set(guide.steps.map((step) => step.layer)).size} layers`}
                />
                <Stat
                  label="Difficulty"
                  value={guide.difficulty}
                  plain
                  note={guide.parts.length > 0 ? `${guide.parts.length} parts` : 'bottom-up'}
                />
              </StatGrid>
            </Sheet>
          </div>

          <footer className="booklet__running-footer">
            <span className="booklet__running-page">Page 1 of {totalPages}</span>
          </footer>
        </section>

        {/* Front matter: Parts List Sheet (Volume 1 only, when parts exist) */}
        {currentVolume.volumeIndex === 1 && guide.parts.length > 0 && (
          <section className="booklet__page booklet__page--parts" aria-label="Parts List">
            <header className="booklet__running-header">
              <span className="booklet__running-title">
                CRAFTMAGIC MANUAL · {guide.name} · Volume {currentVolume.volumeIndex}
              </span>
            </header>

            <div className="booklet__page-body">
              <Sheet variant="parts">
                <SheetTitle>What you are building</SheetTitle>
                <Lede>
                  The parts this build is made of, in the order they go up. Each assembly step
                  below is named after the part it advances.
                </Lede>

                <ol className="parts__list">
                  {guide.parts.map((part) => (
                    <li className="part" key={part.id}>
                      <span className="part__name">{part.label}</span>
                      <span className="part__count">{part.blocks.toLocaleString()}</span>
                      <span className="part__note">{partExtent(part)}</span>
                    </li>
                  ))}
                </ol>
              </Sheet>
            </div>

            <footer className="booklet__running-footer">
              <span className="booklet__running-page">Page 2 of {totalPages}</span>
            </footer>
          </section>
        )}

        {/* Front matter: Materials List Sheet (Volume 1 only) */}
        {currentVolume.volumeIndex === 1 && (
          <section className="booklet__page booklet__page--materials" aria-label="Bill of Materials">
            <header className="booklet__running-header">
              <span className="booklet__running-title">
                CRAFTMAGIC MANUAL · {guide.name} · Volume {currentVolume.volumeIndex}
              </span>
            </header>

            <div className="booklet__page-body">
              <Sheet variant="materials">
                <SheetTitle>Bill of materials</SheetTitle>
                <Lede>
                  Everything the build needs, most-used first. Stacks are the unit you actually
                  gather in, so they are spelled out; a door counts once, not twice.
                </Lede>

                <ol className="materials__list">
                  {guide.materials.map((material) => (
                    <li className="material" key={material.block}>
                      <Swatch block={material.block} />
                      <span className="material__name">{material.displayName}</span>
                      <span className="material__count">{material.count.toLocaleString()}</span>
                      <span className="material__stacks">{stackText(material)}</span>
                    </li>
                  ))}
                </ol>
              </Sheet>
            </div>

            <footer className="booklet__running-footer">
              <span className="booklet__running-page">
                Page {frontSheets.length} of {totalPages}
              </span>
            </footer>
          </section>
        )}

        {/* Step Pages */}
        {stepPages.map((pageSteps, pageIdx) => {
          const pageNumber = frontSheets.length + pageIdx + 1;
          return (
            <section
              key={pageNumber}
              className="booklet__page booklet__page--steps"
              aria-label={`Assembly steps, page ${pageNumber}`}
            >
              <header className="booklet__running-header">
                <span className="booklet__running-title">
                  CRAFTMAGIC MANUAL · {guide.name} · Volume {currentVolume.volumeIndex}
                </span>
                <span className="booklet__running-sub">
                  Steps {pageSteps[0]?.index}–{pageSteps[pageSteps.length - 1]?.index}
                </span>
              </header>

              <div className="booklet__page-body">
                <div className={`booklet__step-grid booklet__step-grid--${density}up`}>
                  {pageSteps.map((step) => {
                    const stepIdx = step.index - 1;
                    const plan = plans[stepIdx]!;
                    const shot = filmShots[stepIdx];
                    const placed = placedBy[stepIdx] ?? 0;
                    const also = step.parts.slice(1);

                    return (
                      <article key={step.index} className="step booklet__step-card">
                        <header className="step__head">
                          <div className="step__id">
                            <span className="step__index">
                              Step {step.index}
                              <span className="step__of"> of {guide.steps.length}</span>
                            </span>
                            <span className="step__layer">
                              {placed.toLocaleString()} of {guide.totalBlocks.toLocaleString()} · y = {step.layer}
                              {step.partOfLayer && (
                                <span className="step__part">
                                  {' '}
                                  ({step.partOfLayer.part} of {step.partOfLayer.total})
                                </span>
                              )}
                            </span>
                          </div>

                          <h3 className="step__title">{step.title}</h3>

                          {also.length > 0 && (
                            <p className="step__also">
                              with {also.map((p) => `${p.label} × ${p.blocks}`).join(', ')}
                            </p>
                          )}

                          {/* LEGO-style Parts Callout Tray */}
                          <CalloutTray step={step} className="step__callouts" />
                        </header>

                        <div className="step__panels-wrapper">
                          <div className="step__panels-toolbar">
                            <ViewpointBadge
                              orientation={step.orientation}
                              isFlipped={step.isFlipped}
                            />
                          </div>

                          <div className="step__panels">
                            <ArtFrame
                              size="panel"
                              caption={`Layer ${step.layer} from above — place the outlined squares`}
                            >
                              <LayerPlanCanvas plan={plan} step={step} />
                            </ArtFrame>
                            <ArtFrame
                              size="panel"
                              caption={viewpointCaption(step)}
                            >
                              <ArtImage
                                className="panel__shot"
                                src={shot}
                                alt={`The build after step ${step.index}`}
                              />
                            </ArtFrame>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>

              <footer className="booklet__running-footer">
                <span className="booklet__running-page">
                  Page {pageNumber} of {totalPages}
                </span>
              </footer>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function stackText(material: MaterialCount): string {
  if (material.stacks === 0) return `${material.remainder}`;
  const stacks = `${material.stacks} stack${material.stacks === 1 ? '' : 's'}`;
  return material.remainder === 0 ? stacks : `${stacks} + ${material.remainder}`;
}

function partExtent(part: GuidePart): string {
  if (!part.min || !part.max) return '';
  const [x0, y0, z0] = part.min;
  const [x1, y1, z1] = part.max;
  return `${x1 - x0 + 1} × ${y1 - y0 + 1} × ${z1 - z0 + 1}`;
}
