import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { BuildGuide, BuildStep, ViewOrientation } from '@craftmagic/core';
import type { LoadedBuild } from '../editor/builds.js';
import { CalloutTray } from './CalloutTray.js';
import {
  StepViewer,
  ORIENTATION_AZIMUTH,
  orientationLabel,
  viewpointCaption,
} from './isoRender.js';
import { type LayerPlan } from './layerGrid.js';
import { LayerPlanCanvas } from './LayerPlanCanvas.js';
import { ArtFrame, ArtImage } from './primitives.js';
import { ViewpointBadge } from './ViewpointBadge.js';

export interface GuideProgress {
  currentStepIndex: number;
  completedSteps: number[];
}

export const PROGRESS_STORAGE_KEY_PREFIX = 'craftmagic:guide:progress:';

export function getProgressStorageKey(buildId: string): string {
  return `${PROGRESS_STORAGE_KEY_PREFIX}${buildId}`;
}

export function loadGuideProgress(buildId: string): GuideProgress | null {
  try {
    const raw = localStorage.getItem(getProgressStorageKey(buildId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.currentStepIndex === 'number' && Array.isArray(parsed?.completedSteps)) {
      return parsed as GuideProgress;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveGuideProgress(buildId: string, progress: GuideProgress): void {
  try {
    localStorage.setItem(getProgressStorageKey(buildId), JSON.stringify(progress));
  } catch {
    // ignore quota errors
  }
}

export function clearGuideProgress(buildId: string): void {
  try {
    localStorage.removeItem(getProgressStorageKey(buildId));
  } catch {
    // ignore
  }
}

const VIEW_ORIENTATIONS: readonly ViewOrientation[] = ['SE', 'SW', 'NW', 'NE'];

export interface BuilderViewProps {
  buildId: string;
  build: LoadedBuild;
  guide: BuildGuide;
  plans: LayerPlan[];
  filmShots?: readonly string[];
}

export function BuilderView({
  buildId,
  build,
  guide,
  plans,
  filmShots = [],
}: BuilderViewProps) {
  const [params, setParams] = useSearchParams();
  const totalSteps = guide.steps.length;

  // Initial step resolution: 1. URL param ?step=N, 2. localStorage, 3. 0
  const initialIndex = useMemo(() => {
    const urlStep = params.get('step');
    if (urlStep) {
      const parsed = Number.parseInt(urlStep, 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= totalSteps) {
        return parsed - 1;
      }
    }
    const saved = loadGuideProgress(buildId);
    if (saved && saved.currentStepIndex >= 0 && saved.currentStepIndex < totalSteps) {
      return saved.currentStepIndex;
    }
    return 0;
  }, [buildId, params, totalSteps]);

  const [currentStepIndex, setCurrentStepIndex] = useState(initialIndex);
  const [completedSteps, setCompletedSteps] = useState<number[]>(() => {
    const saved = loadGuideProgress(buildId);
    return saved?.completedSteps ?? [];
  });

  const currentStep: BuildStep = guide.steps[currentStepIndex] ?? guide.steps[0]!;
  const currentPlan: LayerPlan | undefined = plans[currentStepIndex] ?? plans[0];

  const urlOri = params.get('ori')?.toUpperCase();
  const validUrlOri: ViewOrientation | undefined =
    urlOri === 'SE' || urlOri === 'SW' || urlOri === 'NW' || urlOri === 'NE'
      ? (urlOri as ViewOrientation)
      : undefined;

  // Orientation state: defaults to URL param, or currentStep.orientation unless user rotates it
  const [activeOrientation, setActiveOrientation] = useState<ViewOrientation>(
    validUrlOri ?? currentStep.orientation ?? 'SE',
  );
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Sync orientation whenever current step changes, matching engine recommendation
  useEffect(() => {
    if (validUrlOri) {
      setActiveOrientation(validUrlOri);
    } else if (currentStep.orientation) {
      setActiveOrientation(currentStep.orientation);
    }
  }, [currentStepIndex, currentStep.orientation, validUrlOri]);

  // Persist progress to localStorage and sync with URL query
  useEffect(() => {
    saveGuideProgress(buildId, {
      currentStepIndex,
      completedSteps,
    });
  }, [buildId, currentStepIndex, completedSteps]);

  const updateStep = useCallback(
    (newIndex: number) => {
      const clamped = Math.max(0, Math.min(newIndex, totalSteps - 1));
      setCurrentStepIndex(clamped);
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('step', String(clamped + 1));
        return next;
      }, { replace: true });
    },
    [totalSteps, setParams],
  );

  const toggleComplete = useCallback(() => {
    const stepNum = currentStepIndex + 1;
    setCompletedSteps((prev) => {
      if (prev.includes(stepNum)) {
        return prev.filter((s) => s !== stepNum);
      }
      return [...prev, stepNum].sort((a, b) => a - b);
    });
  }, [currentStepIndex]);

  const rotateOrientation = useCallback(() => {
    setActiveOrientation((curr) => {
      const idx = VIEW_ORIENTATIONS.indexOf(curr);
      const nextIdx = (idx + 1) % VIEW_ORIENTATIONS.length;
      return VIEW_ORIENTATIONS[nextIdx]!;
    });
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        updateStep(currentStepIndex - 1);
      } else if (
        e.key === 'ArrowRight' ||
        e.key === 'k' ||
        e.key === 'K' ||
        e.key === ' '
      ) {
        e.preventDefault();
        updateStep(currentStepIndex + 1);
      } else if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        toggleComplete();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        rotateOrientation();
      } else if (e.key === '?') {
        e.preventDefault();
        setShowShortcuts((prev) => !prev);
      } else if (e.key === 'Escape') {
        setShowShortcuts(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentStepIndex, updateStep, toggleComplete, rotateOrientation]);

  // Unique layers for jump-to-layer dropdown
  const layers = useMemo(() => {
    const map = new Map<number, number>(); // layer -> first step index
    guide.steps.forEach((s, idx) => {
      if (!map.has(s.layer)) {
        map.set(s.layer, idx);
      }
    });
    return Array.from(map.entries()).sort(([a], [b]) => a - b);
  }, [guide.steps]);

  // Running blocks placed calculation
  const blocksPlaced = useMemo(() => {
    let count = 0;
    for (let i = 0; i <= currentStepIndex; i++) {
      count += guide.steps[i]?.blocks.length ?? 0;
    }
    return count;
  }, [guide.steps, currentStepIndex]);

  const progressPercent = Math.round((blocksPlaced / Math.max(1, guide.totalBlocks)) * 100);
  const isCurrentStepCompleted = completedSteps.includes(currentStepIndex + 1);

  // Persistent single-mesh WebGL viewer: meshed once per build, reused across steps and orientations
  const viewerRef = useRef<StepViewer | null>(null);
  const [customShot, setCustomShot] = useState<string | null>(null);

  useEffect(() => {
    try {
      viewerRef.current = new StepViewer(
        build.grid.size,
        build.paletteColors,
        build.paletteFlags,
        build.grid.voxels,
        activeOrientation,
      );
    } catch {
      viewerRef.current = null;
    }

    return () => {
      viewerRef.current?.dispose();
      viewerRef.current = null;
    };
  }, [build]);

  useEffect(() => {
    if (activeOrientation === currentStep.orientation && filmShots[currentStepIndex]) {
      setCustomShot(filmShots[currentStepIndex]);
      return;
    }

    if (viewerRef.current) {
      try {
        const shot = viewerRef.current.renderStep(currentStep, activeOrientation, 640, 520);
        setCustomShot(shot);
        return;
      } catch {
        // Fall back to pre-rendered shot if renderStep throws
      }
    }
    setCustomShot(filmShots[currentStepIndex] ?? null);
  }, [currentStep, activeOrientation, currentStepIndex, filmShots]);

  const handleReset = () => {
    if (window.confirm('Reset assembly progress for this build guide?')) {
      clearGuideProgress(buildId);
      setCompletedSteps([]);
      updateStep(0);
    }
  };

  const captionText =
    activeOrientation === currentStep.orientation
      ? viewpointCaption(currentStep)
      : `Seen from ${orientationLabel(activeOrientation)}`;

  return (
    <div className="builder" data-builder-step={currentStepIndex + 1}>
      {/* Top Header Cockpit */}
      <header className="builder__header">
        <div className="builder__step-meta">
          <span className="builder__step-number">
            STEP {currentStepIndex + 1} OF {totalSteps}
          </span>
          <h2 className="builder__step-title">{currentStep.title}</h2>
          {currentStep.parts.length > 1 && (
            <span className="builder__step-also">
              + {currentStep.parts.slice(1).map((p) => `${p.label} (${p.blocks})`).join(', ')}
            </span>
          )}
        </div>

        <div className="builder__header-stats">
          <span className="builder__layer-tag">y = {currentStep.layer}</span>
          <button
            type="button"
            className="builder__shortcuts-btn"
            onClick={() => setShowShortcuts(true)}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            Shortcuts (?)
          </button>
        </div>
      </header>

      {/* Main Dual-Pane Workspace */}
      <div className="builder__panes">
        {/* Left Pane: Parts Callout Tray & 2D Layer Plan */}
        <section className="builder__pane builder__pane--plan" aria-label="Step parts and plan">
          <CalloutTray step={currentStep} className="builder__callouts" />
          <div className="builder__plan-card">
            <h4 className="builder__pane-title">2D LAYER PLAN</h4>
            <LayerPlanCanvas plan={currentPlan} step={currentStep} />
          </div>
        </section>

        {/* Right Pane: 3D Isometric View & Viewpoint Toolbar */}
        <section className="builder__pane builder__pane--iso" aria-label="3D Isometric View">
          <div className="builder__iso-card">
            <div className="builder__iso-toolbar">
              <div className="builder__viewpoints">
                {VIEW_ORIENTATIONS.map((ori) => (
                  <button
                    key={ori}
                    type="button"
                    data-ori={ori}
                    className={`builder__view-btn ${
                      activeOrientation === ori ? 'builder__view-btn--active' : ''
                    }`}
                    onClick={() => setActiveOrientation(ori)}
                    title={`View from ${orientationLabel(ori)}`}
                  >
                    {ori}
                  </button>
                ))}
                <button
                  type="button"
                  className="builder__view-btn builder__view-btn--rotate"
                  onClick={rotateOrientation}
                  title="Rotate view 90° (R)"
                >
                  Rotate 90°
                </button>
              </div>

              <ViewpointBadge
                orientation={activeOrientation}
                isFlipped={
                  activeOrientation === currentStep.orientation
                    ? currentStep.isFlipped
                    : false
                }
              />
            </div>

            <ArtFrame size="panel" caption={captionText}>
              <ArtImage
                className="panel__shot"
                src={customShot}
                alt={`Step ${currentStep.index} view from ${orientationLabel(activeOrientation)}`}
              />
            </ArtFrame>
          </div>
        </section>
      </div>

      {/* Floating Action Dock */}
      <footer className="builder__dock no-print" role="region" aria-label="Builder controls">
        <div className="builder__dock-inner">
          {/* Prev / Next & Complete controls */}
          <div className="builder__dock-nav">
            <button
              type="button"
              className="builder__nav-btn builder__nav-btn--prev"
              onClick={() => updateStep(currentStepIndex - 1)}
              disabled={currentStepIndex === 0}
              title="Previous step (J / Left Arrow)"
            >
              ← Prev (J)
            </button>

            <button
              type="button"
              className={`builder__complete-btn ${
                isCurrentStepCompleted ? 'builder__complete-btn--completed' : ''
              }`}
              onClick={toggleComplete}
              title="Toggle step completion (C)"
            >
              {isCurrentStepCompleted ? 'Completed' : 'Mark Complete (C)'}
            </button>

            <button
              type="button"
              className="builder__nav-btn builder__nav-btn--next"
              onClick={() => updateStep(currentStepIndex + 1)}
              disabled={currentStepIndex === totalSteps - 1}
              title="Next step (K / Space / Right Arrow)"
            >
              Next → (K)
            </button>
          </div>

          {/* Progress Summary & Scrubber */}
          <div className="builder__dock-progress">
            <div className="builder__progress-labels">
              <span className="builder__blocks-stat">
                {blocksPlaced.toLocaleString()} / {guide.totalBlocks.toLocaleString()} blocks placed ({progressPercent}%)
              </span>
              <span className="builder__completed-stat">
                {completedSteps.length} of {totalSteps} steps completed
              </span>
            </div>

            <input
              type="range"
              className="builder__scrubber"
              min={1}
              max={totalSteps}
              value={currentStepIndex + 1}
              onChange={(e) => updateStep(Number(e.target.value) - 1)}
              aria-label="Guide step scrubber"
            />
          </div>

          {/* Jump to layer dropdown & reset */}
          <div className="builder__dock-actions">
            <select
              className="builder__layer-select"
              value={currentStep.layer}
              onChange={(e) => {
                const targetLayer = Number(e.target.value);
                const firstStepOfLayer = guide.steps.findIndex((s) => s.layer === targetLayer);
                if (firstStepOfLayer !== -1) updateStep(firstStepOfLayer);
              }}
              aria-label="Jump to layer"
            >
              {layers.map(([layer, stepIdx]) => (
                <option key={layer} value={layer}>
                  Layer y = {layer} (Step {stepIdx + 1})
                </option>
              ))}
            </select>

            <button
              type="button"
              className="builder__reset-btn"
              onClick={handleReset}
              title="Reset progress"
            >
              Reset
            </button>
          </div>
        </div>
      </footer>

      {/* Keyboard Shortcuts Modal */}
      {showShortcuts && (
        <div
          className="builder__modal-backdrop"
          onClick={() => setShowShortcuts(false)}
          role="presentation"
        >
          <div
            className="builder__modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcuts-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="builder__modal-header">
              <h3 id="shortcuts-title">Keyboard Shortcuts</h3>
              <button
                type="button"
                className="builder__modal-close"
                onClick={() => setShowShortcuts(false)}
                aria-label="Close shortcuts modal"
              >
                ✕
              </button>
            </div>
            <dl className="builder__shortcuts-list">
              <div className="shortcut-row">
                <dt><kbd>←</kbd> or <kbd>J</kbd></dt>
                <dd>Previous step</dd>
              </div>
              <div className="shortcut-row">
                <dt><kbd>→</kbd> or <kbd>K</kbd> or <kbd>Space</kbd></dt>
                <dd>Next step</dd>
              </div>
              <div className="shortcut-row">
                <dt><kbd>C</kbd></dt>
                <dd>Toggle step completion</dd>
              </div>
              <div className="shortcut-row">
                <dt><kbd>R</kbd></dt>
                <dd>Rotate viewpoint 90° (SE → SW → NW → NE)</dd>
              </div>
              <div className="shortcut-row">
                <dt><kbd>?</kbd></dt>
                <dd>Toggle this shortcuts sheet</dd>
              </div>
              <div className="shortcut-row">
                <dt><kbd>Esc</kbd></dt>
                <dd>Close dialog</dd>
              </div>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
