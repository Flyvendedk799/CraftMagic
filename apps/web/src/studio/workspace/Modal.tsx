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
      target?.focus();
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
      const items = Array.from(
        host?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      ).filter(
        (el) => el.getClientRects().length > 0 && !el.closest('[hidden]'),
      );
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
  return (
    <div
      className="workspace-modal"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`workspace-modal__panel${wide ? ' workspace-modal__panel--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header>
          <div>
            {eyebrow && <small>{eyebrow}</small>}
            <h2>{title}</h2>
          </div>
          <button onClick={onClose} aria-label={`Close ${title}`}>
            <StudioIcon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
