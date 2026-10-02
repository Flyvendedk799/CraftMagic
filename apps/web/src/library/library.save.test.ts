import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveToLibrary } from './library.js';

const grid = {
  size: { x: 1, y: 1, z: 1 },
  palette: ['minecraft:air', 'minecraft:stone'],
  voxels: Uint16Array.of(0),
};

afterEach(() => vi.unstubAllGlobals());

describe('saving an existing library build', () => {
  it('sends an explicit null to clear edits while preserving the linked plan and kind', async () => {
    let sent: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ id: 'row-1', blockCount: 0 });
    }));

    await saveToLibrary({
      id: 'row-1', name: 'House', grid, program: null, detached: false,
      edits: null, keepPlan: true, keepKind: true,
    });

    expect(sent).toMatchObject({ id: 'row-1', edits: null });
    expect(sent).not.toHaveProperty('plan');
    expect(sent).not.toHaveProperty('kind');
  });
});
