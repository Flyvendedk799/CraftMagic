import { useEffect, useRef, type ReactNode } from 'react';
import { StudioIcon } from './Icon.js';

const FOCUSABLE =
  'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]';

/** Capture Escape before editor shortcuts, trap Tab, restore the opener, and keep pointer dismissal intentional. */
export function useModalFocus(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null),
    close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const before =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const host = ref.current;

    const focus = () => {
      const target =
        host?.querySelector<HTMLElement>('[data-autofocus]') ??
        host?.querySelector<HTMLElement>(
          'input:not([disabled]):not([type="hidden"]),textarea:not([disabled])',
        ) ??
        host?.querySelector<HTMLElement>(
          'button:not([disabled]),[tabindex="0"]',
        );
      if (target) {
        target.focus();
      } else {
        host?.focus();
      }
    };
    const frame = requestAnimationFrame(focus);

    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        const dialogs = Array.from(
          document.querySelectorAll('[aria-modal="true"]'),
        );
        if (dialogs[dialogs.length - 1] !== host) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const isVisible = (el: HTMLElement) => {
        if (el.closest('[hidden]')) return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        if (typeof el.getClientRects === 'function') {
          const rects = el.getClientRects();
          if (rects.length > 0) return true;
        }
        return el.style.display !== 'none' && el.style.visibility !== 'hidden';
      };

      const items = Array.from(
        host?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      ).filter(isVisible);

      if (!items.length) {
        event.preventDefault();
        host?.focus();
        return;
      }
      const first = items[0]!,
        last = items[items.length - 1]!;
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !host?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !host?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', key, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', key, true);
      if (before?.isConnected) before.focus();
    };
  }, [open]);

  return ref;
}

export function WorkspaceModal({
  title,
  eyebrow,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useModalFocus(true, onClose);
  const titleId = `workspace-modal-title-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  return (
    <div
      className="workspace-modal"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <style>{`
        .workspace-modal {
          position: fixed;
          inset: 0;
          z-index: 500;
          display: flex;
          justify-content: center;
          align-items: center;
          padding: 24px;
          background: rgba(4, 8, 14, 0.78);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }
        .workspace-modal__panel {
          width: min(600px, calc(100vw - 32px));
          max-height: min(760px, calc(100dvh - 48px));
          display: flex;
          flex-direction: column;
          background: var(--panel, #191e25);
          border: 1px solid var(--border, #303943);
          border-radius: var(--radius-lg, 10px);
          overflow: hidden;
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
          color: var(--text, #e6edf3);
        }
        .workspace-modal__panel--wide {
          width: min(960px, calc(100vw - 32px));
        }
        .workspace-modal__panel > header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          background: rgba(0, 0, 0, 0.18);
          border-bottom: 1px solid var(--border, #303943);
          flex: none;
          gap: 12px;
        }
        .workspace-modal__title-group {
          display: flex;
          flex-direction: column;
          gap: 3px;
          min-width: 0;
        }
        .workspace-modal__eyebrow {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 1.5px;
          text-transform: uppercase;
          color: var(--accent, #8ee8b2);
          display: inline-block;
        }
        .workspace-modal__title {
          font-size: 18px;
          margin: 0;
          font-weight: 600;
          letter-spacing: -0.3px;
          color: var(--text, #e6edf3);
          line-height: 1.25;
        }
        .workspace-modal__close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          padding: 0;
          border: 1px solid transparent;
          border-radius: var(--radius-md, 6px);
          background: transparent;
          color: var(--muted, #9caab7);
          cursor: pointer;
          flex: none;
          transition: all 0.15s ease;
        }
        .workspace-modal__close:hover {
          background: rgba(255, 255, 255, 0.08);
          color: var(--text, #e6edf3);
          border-color: rgba(255, 255, 255, 0.08);
        }
        .workspace-modal__close:focus-visible {
          outline: 2px solid var(--accent, #8ee8b2);
          outline-offset: 1px;
        }
      `}</style>
      <div
        ref={ref}
        className={`workspace-modal__panel${wide ? ' workspace-modal__panel--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <div className="workspace-modal__title-group">
            {eyebrow && <small className="workspace-modal__eyebrow">{eyebrow}</small>}
            <h2 id={titleId} className="workspace-modal__title">{title}</h2>
          </div>
          <button
            type="button"
            className="workspace-modal__close"
            onClick={onClose}
            aria-label={`Close ${title}`}
            title="Close (Esc)"
          >
            <StudioIcon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
