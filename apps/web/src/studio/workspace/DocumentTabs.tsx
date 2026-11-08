import { useEffect, useRef } from 'react';
import { MAX_TABS, type WorkspaceDocument } from './documents.js';
import { StudioIcon } from './Icon.js';
export function DocumentTabs({
  tabs,
  active,
  dirty,
  onOpen,
  onClose,
  onPin,
  onMove,
  onNew,
}: {
  tabs: WorkspaceDocument[];
  active: string;
  dirty: boolean;
  onOpen: (href: string) => void;
  onClose: (key: string) => void;
  onPin: (key: string) => void;
  onMove: (key: string, by: -1 | 1) => void;
  onNew: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const activeEl = listRef.current?.querySelector<HTMLElement>(
      '.workspace-tab[data-active="true"]',
    );
    if (activeEl && typeof activeEl.scrollIntoView === 'function') {
      activeEl.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [active, tabs.length]);

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY !== 0 && event.deltaX === 0 && listRef.current) {
      listRef.current.scrollLeft += event.deltaY;
    }
  };

  return (
    <div className="workspace-tabs" ref={host}>
      <div
        className="workspace-tabs__list"
        role="toolbar"
        aria-label="Open documents"
        ref={listRef}
        onWheel={handleWheel}
      >
        {tabs.map((tab, index) => (
          <div
            className="workspace-tab"
            key={tab.key}
            data-active={tab.key === active}
            data-pinned={tab.pinned ? 'true' : undefined}
          >
            <button
              data-document-tab="true"
              aria-pressed={tab.key === active}
              aria-controls="workspace-stage"
              tabIndex={tab.key === active ? 0 : -1}
              title={`${tab.title} · ${tab.mode === 'arch' ? 'Floorplan' : tab.mode === 'world' ? 'World' : 'Build'}${tab.pinned ? ' · pinned' : ''}${tab.key === active && dirty ? ' · unsaved' : ''}`}
              onClick={() => onOpen(tab.href)}
              onKeyDown={(event) => {
                if (
                  event.altKey &&
                  (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
                ) {
                  event.preventDefault();
                  onMove(tab.key, event.key === 'ArrowLeft' ? -1 : 1);
                  return;
                }
                let next: number | null = null;
                if (event.key === 'ArrowRight')
                  next = (index + 1) % tabs.length;
                if (event.key === 'ArrowLeft')
                  next = (index - 1 + tabs.length) % tabs.length;
                if (event.key === 'Home') next = 0;
                if (event.key === 'End') next = tabs.length - 1;
                if (next !== null) {
                  event.preventDefault();
                  const item = tabs[next]!;
                  onOpen(item.href);
                  requestAnimationFrame(() =>
                    host.current
                      ?.querySelectorAll<HTMLElement>('[data-document-tab]')
                      [next!]?.focus(),
                  );
                }
                if (event.key === 'Delete' && !tab.pinned) {
                  event.preventDefault();
                  onClose(tab.key);
                }
              }}
            >
              <StudioIcon
                name={
                  tab.mode === 'build'
                    ? 'cube'
                    : tab.mode === 'arch'
                      ? 'plan'
                      : 'world'
                }
              />
              <span className="workspace-tab__title">{tab.title}</span>
              {tab.key === active && dirty && (
                <i aria-label="Unsaved changes" className="workspace-tab__dirty" />
              )}
            </button>
            <button
              className="workspace-tab__pin"
              disabled={
                !tab.pinned &&
                tabs.filter((item) => item.pinned).length >= MAX_TABS
              }
              title={
                tab.pinned
                  ? 'Unpin document'
                  : `Pin document · up to ${MAX_TABS} pinned tabs`
              }
              onClick={() => onPin(tab.key)}
              aria-label={`${tab.pinned ? 'Unpin' : 'Pin'} ${tab.title}`}
              aria-pressed={tab.pinned}
            >
              <StudioIcon name="pin" />
            </button>
            {!tab.pinned && (
              <button
                className="workspace-tab__close"
                onClick={() => onClose(tab.key)}
                title={`Close ${tab.title}`}
                aria-label={`Close ${tab.title}`}
              >
                <StudioIcon name="close" />
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        className="workspace-tabs__new"
        onClick={onNew}
        title="New document"
        aria-label="New document"
      >
        <StudioIcon name="plus" />
      </button>
    </div>
  );
}
