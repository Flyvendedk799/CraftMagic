import { describe, it, expect } from 'vitest';
import { WorkingCopies } from './retention.js';
describe('bounded working copies', () => {
  it('retains identity and evicts the least recently used entry', () => {
    const cache = new WorkingCopies<number>(2, 100);
    cache.set('a', 1, 20);
    cache.set('b', 2, 20);
    cache.get('a');
    cache.set('c', 3, 20);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
  });
  it('enforces byte and entry limits', () => {
    const cache = new WorkingCopies<number>(8, 50);
    cache.set('a', 1, 40);
    cache.set('b', 2, 40);
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBeUndefined();
  });
  it('does not keep oversized entries or corrupt its budget on replacements', () => {
    const cache = new WorkingCopies<number>(3, 50);
    cache.set('a', 1, 40);
    cache.set('a', 2, 30);
    cache.set('b', 3, 20);
    expect(cache.size).toBe(2);
    cache.set('c', 4, 51);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

it('does not resurrect a renamed or deleted document from a stale unmount', () => {
  const cache = new WorkingCopies<string>();
  const version = cache.version('a');
  cache.set('a', 'old', 3);
  cache.invalidate('a');
  cache.setIfCurrent('a', 'old', 3, version);
  expect(cache.get('a')).toBeUndefined();
  cache.setIfCurrent('a', 'new', 3, cache.version('a'));
  expect(cache.get('a')).toBe('new');
});
