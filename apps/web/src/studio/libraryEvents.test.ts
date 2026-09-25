/**
 * The library-row signal that keeps World’s catalogue in step with Build edits.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { notifyLibraryRow, onLibraryRow, resetLibraryRowListeners } from './libraryEvents.js';

describe('libraryEvents', () => {
  afterEach(() => {
    resetLibraryRowListeners();
  });

  it('notifies listeners with the row id', () => {
    const seen: string[] = [];
    const stop = onLibraryRow((id) => seen.push(id));
    notifyLibraryRow('abc');
    expect(seen).toEqual(['abc']);
    stop();
    notifyLibraryRow('def');
    expect(seen).toEqual(['abc']);
  });

  it('ignores an empty id', () => {
    const seen: string[] = [];
    onLibraryRow((id) => seen.push(id));
    notifyLibraryRow('');
    expect(seen).toEqual([]);
  });
});
