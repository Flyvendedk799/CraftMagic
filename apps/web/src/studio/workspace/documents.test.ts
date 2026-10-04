import { describe, it, expect } from 'vitest';
import {
  canonicalDocument,
  readSession,
  visitDocument,
  closeDocument,
  pinDocument,
  moveDocument,
  adjacentDocument,
  EMPTY_SESSION,
  MAX_TABS,
  MAX_RECENT,
} from './documents.js';
describe('workspace document identity', () => {
  it.each([
    '/evil',
    'https://example.com/studio',
    '//example.com/studio',
    '/studio/other',
    'javascript:alert(1)',
    '/studio' + 'x'.repeat(5000),
  ])('rejects external or invalid route %s', (href) =>
    expect(canonicalDocument(href)).toBeNull(),
  );
  it('keeps parameters owned by the editor and preserves old mode aliases', () => {
    expect(
      canonicalDocument('/studio?mode=plan&plan=lib%3Aa&build=b&bogus=1'),
    ).toEqual({
      key: 'arch:lib:a',
      mode: 'arch',
      href: '/studio?mode=arch&plan=lib%3Aa',
    });
  });
  it('view changes update one document instead of creating tabs', () => {
    const first = visitDocument(
        EMPTY_SESSION,
        '/studio?build=cottage',
        'Cottage',
        1,
      ),
      next = visitDocument(
        first,
        '/studio?build=cottage&layer=3&p.floors=2',
        'Cottage',
        2,
      );
    expect(next.tabs).toHaveLength(1);
    expect(next.tabs[0]!.href).toContain('layer=3');
    expect(next.recent).toHaveLength(1);
  });
  it('different document types never collide even with the same ID', () => {
    let s = visitDocument(EMPTY_SESSION, '/studio?build=lib:a', 'A');
    s = visitDocument(s, '/studio?mode=arch&plan=lib:a', 'A');
    expect(s.tabs).toHaveLength(2);
  });
  it('preserves pin state on visits and never evicts a pinned tab', () => {
    let s = visitDocument(EMPTY_SESSION, '/studio?build=first', 'First', 0);
    s = pinDocument(s, 'build:first');
    for (let i = 0; i < 30; i++)
      s = visitDocument(s, `/studio?build=${i}`, String(i), i + 1);
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.tabs.some((t) => t.key === 'build:first' && t.pinned)).toBe(true);
  });
  it('bounds recents independently of open tabs', () => {
    let s = EMPTY_SESSION;
    for (let i = 0; i < 100; i++)
      s = visitDocument(s, `/studio?build=${i}`, String(i), i);
    expect(s.recent).toHaveLength(MAX_RECENT);
    expect(s.tabs).toHaveLength(MAX_TABS);
  });
  it('closes a tab without deleting recent navigation metadata', () => {
    const s = visitDocument(EMPTY_SESSION, '/studio?build=a', 'A');
    expect(closeDocument(s, 'build:a').tabs).toHaveLength(0);
    expect(closeDocument(s, 'build:a').recent).toHaveLength(1);
  });
  it('moves only in range and picks an adjacent tab', () => {
    const s = visitDocument(
      visitDocument(EMPTY_SESSION, '/studio?build=a', 'A'),
      '/studio?build=b',
      'B',
    );
    expect(moveDocument(s, 'build:a', -1)).toBe(s);
    expect(moveDocument(s, 'build:a', 1).tabs[1]!.key).toBe('build:a');
    expect(adjacentDocument(s.tabs, 'build:a')?.key).toBe('build:b');
  });
  it('normalizes untrusted persisted metadata and deduplicates keys', () => {
    const raw = JSON.stringify({
      version: 1,
      tabs: [
        { href: '/studio?build=a', title: 'A', pinned: true },
        { href: '/studio?build=a', title: 'Duplicate' },
        { href: 'https://evil/studio', title: 'Bad' },
      ],
      recent: [],
    });
    expect(readSession(raw).tabs).toHaveLength(1);
    expect(readSession(raw).tabs[0]!.lastOpened).toBe(0);
  });
  it.each([
    null,
    '{',
    'null',
    '[]',
    '{"version":9}',
    '{"version":1,"tabs":null}',
  ])('recovers malformed storage %s', (raw) =>
    expect(readSession(raw).tabs).toEqual([]),
  );
});

it('keeps the active document visible when every normal slot is pinned', () => {
  let session = EMPTY_SESSION;
  for (let i = 0; i < MAX_TABS; i++) {
    session = visitDocument(session, `/studio?build=p${i}`, `P${i}`, i);
    session = pinDocument(session, `build:p${i}`);
  }
  session = visitDocument(session, '/studio?build=active', 'Active', 99);
  expect(session.tabs).toHaveLength(MAX_TABS + 1);
  expect(session.tabs.at(-1)?.key).toBe('build:active');
  expect(pinDocument(session, 'build:active')).toBe(session);
  expect(readSession(JSON.stringify(session)).tabs).toHaveLength(MAX_TABS + 1);
  expect(adjacentDocument(session.tabs, 'not-a-tab')).toBeNull();
});
