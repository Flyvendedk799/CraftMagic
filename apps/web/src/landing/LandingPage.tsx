/**
 * The front door.
 *
 * Everything else in this app assumes you already know what CraftMagic is: the editor opens
 * straight into a build, the library into a list. This page is the one surface whose job is to
 * explain the product to somebody who arrived from a link, and then get them an account.
 *
 * It is deliberately the heaviest page here — an assembling 3D build, scroll reveals, a rail
 * that threads the whole scroll — because the product's pitch is visual and a screenshot does
 * not carry it. The weight is confined to this route: the three.js scenes stop rendering when
 * they leave the viewport, the fonts are the app's own, and none of the editor's code is
 * pulled in.
 *
 * Structure follows the promise: what it does (hero) → how it works (three steps) → what the
 * editor feels like → the three ways a build leaves here → sign up. Every call to action goes
 * to the same place, because there is only one thing to do next.
 */

import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Logo, Mark } from '../brand/Logo.js';
import { CountUp } from './CountUp.js';
import { TypedPrompt } from './TypedPrompt.js';
import { VoxelScene } from './VoxelScene.js';
import { useRevealOnScroll, useScrollProgress } from './useLandingMotion.js';
import './landing.css';

/**
 * Where every call to action goes.
 *
 * `?signup=1` opens the library's account panel on the "Create account" tab rather than on
 * "Sign in". A button that says "Sign up free" and lands you on a sign-in form is a small lie
 * that costs a conversion.
 */
const SIGN_UP = '/library?signup=1';

export function LandingPage() {
  const root = useRef<HTMLDivElement>(null);
  const hero = useRef<HTMLElement>(null);

  useRevealOnScroll(root);
  useScrollProgress(root);

  // Smooth scrolling and the darker Void background belong to this page, not to the app. Set
  // on the root element because it is the scrolling element — `scroll-behavior` on a div that
  // does not scroll does nothing, and a background on the page rather than the root leaves the
  // shell's colour showing on an overscroll bounce.
  useEffect(() => {
    document.documentElement.classList.add('is-landing');
    return () => document.documentElement.classList.remove('is-landing');
  }, []);

  return (
    <div className="landing" ref={root}>
      <div className="landing__progress" aria-hidden="true" />

      {/* The rail: one continuous mint line down the left edge of every section, filling as
          you scroll, with a block riding the fill. It is the page's spine — the thing that
          says the sections are one argument rather than five stacked panels. */}
      <div className="landing__rail" aria-hidden="true">
        <div className="landing__rail-track" />
        <div className="landing__rail-fill" />
        <div className="landing__rail-node">
          <Mark size={22} spark={false} />
        </div>
      </div>

      <nav className="landing__nav">
        <a className="landing__nav-brand" href="#top">
          <Logo size={30} />
        </a>
        <div className="landing__nav-links">
          <a className="landing__nav-link" href="#how">
            How it works
          </a>
          <a className="landing__nav-link" href="#exports">
            Exports
          </a>
          <a className="landing__nav-link" href="#editor">
            Editor
          </a>
          <Link className="landing__cta landing__cta--small" to={SIGN_UP}>
            Sign up free
          </Link>
        </div>
      </nav>

      <header className="landing__hero" id="top" ref={hero}>
        <VoxelScene mode="assemble" parallaxRef={hero} className="landing__hero-canvas" />
        {/* Three stacked washes, all decorative: a mint glow behind the build, a left-to-right
            veil so the headline keeps its contrast over whatever the animation is doing, and a
            fade into the next section. */}
        <div className="landing__hero-glow" aria-hidden="true" />
        <div className="landing__hero-veil" aria-hidden="true" />
        <div className="landing__hero-fade" aria-hidden="true" />

        <div className="landing__hero-inner">
          <div className="landing__hero-copy">
            <p className="landing__badge">
              <span className="landing__badge-dot" aria-hidden="true" />
              AI Minecraft build generator
            </p>
            <h1 className="landing__title">
              Type it.
              <br />
              <span className="landing__title-accent">Watch it build.</span>
            </h1>

            <TypedPrompt />

            <p className="landing__lede">
              Describe any structure and get it back as an <strong>editable 3D model</strong> —
              then export a schematic, a printable guide, or a bot that builds it in your world.
            </p>

            <div className="landing__actions">
              <Link className="landing__cta" to={SIGN_UP}>
                Sign up free
                <ArrowIcon />
              </Link>
              <a className="landing__ghost" href="#how">
                See how it works
              </a>
            </div>

            <dl className="landing__stats">
              <div className="landing__stat">
                <dt className="landing__stat-value">
                  <CountUp value={499} />
                </dt>
                <dd className="landing__stat-label">curated blocks</dd>
              </div>
              <div className="landing__stat-rule" aria-hidden="true" />
              <div className="landing__stat">
                <dt className="landing__stat-value">
                  ~<CountUp value={190} />
                  ms
                </dt>
                <dd className="landing__stat-label">to expand 265k blocks</dd>
              </div>
              <div className="landing__stat-rule" aria-hidden="true" />
              <div className="landing__stat">
                <dt className="landing__stat-value">
                  <CountUp value={3} /> ways
                </dt>
                <dd className="landing__stat-label">to export a build</dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="landing__scroll-hint" aria-hidden="true">
          scroll
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M6 13l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </header>

      <section className="landing__section" id="how">
        <div data-reveal="hidden">
          <p className="landing__eyebrow">How it works</p>
          <h2 className="landing__h2 landing__h2--narrow">
            Three steps from a sentence to a standing structure
          </h2>
        </div>

        <ol className="landing__steps">
          <li className="landing__step" data-reveal="hidden">
            <p className="landing__step-num">01</p>
            <div className="landing__step-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 6h16M4 12h10M4 18h13" strokeLinecap="round" />
              </svg>
            </div>
            <h3 className="landing__step-title">Describe it</h3>
            <p className="landing__step-body">
              Type a build in plain words. The AI writes a parametric{' '}
              <em>build program</em> — not raw voxels — so it&rsquo;s tiny, exact, and resizable.
            </p>
          </li>

          <li className="landing__step" data-reveal="hidden" data-reveal-delay="1">
            <p className="landing__step-num">02</p>
            <div className="landing__step-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path
                  d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <h3 className="landing__step-title">Edit &amp; resize</h3>
            <p className="landing__step-body">
              Open it in a real 3D editor. Place, erase, flood-fill and swap blocks — then drag
              one slider to resize the whole build. Walls stay walls.
            </p>
          </li>

          <li className="landing__step" data-reveal="hidden" data-reveal-delay="2">
            <p className="landing__step-num">03</p>
            <div className="landing__step-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path
                  d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <h3 className="landing__step-title">Export it</h3>
            <p className="landing__step-body">
              Take it three ways: a WorldEdit <code>.schem</code>, a printable instruction
              booklet, or a bot that builds it in your world.
            </p>
          </li>
        </ol>
      </section>

      <section className="landing__showcase" id="editor">
        <div className="landing__showcase-head" data-reveal="hidden">
          <p className="landing__eyebrow">The editor</p>
          <h2 className="landing__h2">A real 3D workspace, right in the browser</h2>
          <p className="landing__showcase-lede">
            Orbit, slice by layer, and re-expand live. Worker-meshed and fast — a 265k-block
            build lands in about 190ms.
          </p>
        </div>

        {/* A staged still of the editor, not the editor. Mounting the real one here would pull
            the whole build pipeline into the landing bundle to render a screenshot nobody can
            click; the HUD numbers are the sample cottage's own. */}
        <div className="landing__window" data-reveal="hidden">
          <div className="landing__window-bar">
            <span className="landing__window-dot landing__window-dot--close" />
            <span className="landing__window-dot landing__window-dot--min" />
            <span className="landing__window-dot landing__window-dot--max" />
            <span className="landing__window-url">craftmagic.online/editor?build=cottage</span>
          </div>

          <div className="landing__window-body">
            <VoxelScene mode="idle" className="landing__window-canvas" />
            <div className="landing__window-vignette" aria-hidden="true" />

            <div className="landing__hud landing__hud--build" aria-hidden="true">
              <p className="landing__hud-title">Oak Cottage</p>
              <p className="landing__hud-sub">sample · detached edits off</p>
              <dl className="landing__hud-stats">
                <dt>blocks</dt>
                <dd>1,204</dd>
                <dt>size</dt>
                <dd>7×8×7</dd>
                <dt>palette</dt>
                <dd>8</dd>
              </dl>
              <div className="landing__hud-slider">
                <p className="landing__hud-legend">Size · scale</p>
                <div className="landing__track">
                  <span className="landing__track-fill" style={{ width: '64%' }} />
                  <span className="landing__track-knob" style={{ left: '64%' }} />
                </div>
              </div>
            </div>

            <div className="landing__hud landing__hud--generate" aria-hidden="true">
              <p className="landing__hud-title landing__hud-title--small">Generate</p>
              <p className="landing__hud-prompt">a cozy oak cottage with a stone chimney</p>
              <div className="landing__hud-buttons">
                <span className="landing__hud-button">Generate</span>
                <span className="landing__hud-button landing__hud-button--ghost">Est.</span>
              </div>
            </div>

            <div className="landing__hud landing__hud--layers" aria-hidden="true">
              <span className="landing__hud-layer-label">Layer</span>
              <div className="landing__track landing__track--layers">
                <span className="landing__track-fill" style={{ width: '100%' }} />
              </div>
              <span className="landing__hud-count">all · 8/8</span>
            </div>

            <div className="landing__scanline" aria-hidden="true" />
          </div>
        </div>
      </section>

      <section className="landing__section landing__section--exports" id="exports">
        <div className="landing__exports-head" data-reveal="hidden">
          <p className="landing__eyebrow">One build, three destinations</p>
          <h2 className="landing__h2">However you play, the build comes with you</h2>
        </div>

        <div className="landing__paths">
          <article className="landing__path landing__path--schem" data-reveal="hidden">
            <div className="landing__path-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path
                  d="M4 7l8-4 8 4v10l-8 4-8-4Z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M4 7l8 4 8-4M12 11v10" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h3 className="landing__path-title">WorldEdit schematic</h3>
            <p className="landing__path-body">
              A ready-to-paste <code>.schem</code>, written entirely in your browser. Every
              blockstate resolved — Minecraft&rsquo;s own parser reads it back clean.
            </p>
            <p className="landing__path-meta">//paste · oak-cottage.schem</p>
          </article>

          <article
            className="landing__path landing__path--guide"
            data-reveal="hidden"
            data-reveal-delay="1"
          >
            <div className="landing__path-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path
                  d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4Z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M8 12h8M8 16h6" strokeLinecap="round" />
              </svg>
            </div>
            <h3 className="landing__path-title">Printable guide</h3>
            <p className="landing__path-body">
              A LEGO-style booklet — each step shows a top-down layer plan beside the build so
              far. Print it with Ctrl+P and build it by hand.
            </p>
            <p className="landing__path-meta">33 steps · 19 pages</p>
          </article>

          <article
            className="landing__path landing__path--bot"
            data-reveal="hidden"
            data-reveal-delay="2"
          >
            <div className="landing__path-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="5" y="8" width="14" height="11" rx="2" />
                <path d="M12 8V4M9 4h6" strokeLinecap="round" />
                <circle cx="9.5" cy="13" r="1.3" />
                <circle cx="14.5" cy="13" r="1.3" />
              </svg>
            </div>
            <h3 className="landing__path-title">Builder bot</h3>
            <p className="landing__path-body">
              Pair your world and a bot walks in and builds it for you. The mod always dials out
              — no port forwarding, works behind any home router.
            </p>
            <p className="landing__path-meta">/craftmagic build · Fabric 26.2</p>
          </article>
        </div>
      </section>

      <section className="landing__final" id="signup">
        <div className="landing__final-card" data-reveal="hidden">
          <div className="landing__final-glow" aria-hidden="true" />
          <div className="landing__final-inner">
            <h2 className="landing__final-title">Start building free</h2>
            <p className="landing__final-lede">
              Create an account to save builds, generate from a prompt, and send a bot into your
              world. Samples, the editor, and downloads are free to try — no account needed.
            </p>
            <div className="landing__actions landing__actions--centred">
              <Link className="landing__cta" to={SIGN_UP}>
                Create your account
                <ArrowIcon />
              </Link>
              <Link className="landing__ghost" to="/editor">
                Try a sample first
              </Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="landing__footer">
        <div className="landing__footer-brand">
          <Mark size={26} spark={false} />
          <div>
            <p className="landing__footer-name">CraftMagic</p>
            <p className="landing__footer-tagline">Type it. Watch it build.</p>
          </div>
        </div>
        <nav className="landing__footer-links">
          <a href="#how">How it works</a>
          <a href="#exports">Exports</a>
          <a href="#editor">Editor</a>
          <Link to={SIGN_UP}>Sign up</Link>
        </nav>
        <p className="landing__footer-domain">craftmagic.online</p>
      </footer>
    </div>
  );
}

function ArrowIcon() {
  return (
    <svg
      className="landing__cta-arrow"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      aria-hidden="true"
    >
      <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
