// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { EditorBoundary } from './EditorBoundary.js';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('keeps recovery actions available and retries without deleting files', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let broken = true;
  const open = vi.fn();
  function Child() {
    if (broken) throw Error('Fixture rendering failure');
    return <p>Recovered document</p>;
  }
  render(
    <EditorBoundary documentKey="a" onOpenFiles={open}>
      <Child />
    </EditorBoundary>,
  );
  expect(screen.getByRole('alert').textContent).toContain(
    'saved files have not been deleted',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open your work' }));
  expect(open).toHaveBeenCalledTimes(1);
  broken = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry editor' }));
  expect(screen.getByText('Recovered document')).toBeTruthy();
});
