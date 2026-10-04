import { afterEach, describe, it, expect, vi } from 'vitest';
import { createWorld } from '@craftmagic/core';
import { remoteStore, isAccountWorldId } from './api.js';
afterEach(() => vi.unstubAllGlobals());
describe('device-to-account world saves', () => {
  it('creates a local-ID world without first sending an invalid UUID to the update route', async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ id: '12345678-1234-4234-9234-123456789012' }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', request);
    const doc = createWorld({ size: { x: 32, z: 32 } });
    expect(isAccountWorldId(doc.id)).toBe(false);
    expect(await remoteStore.save(doc)).toBe(
      '12345678-1234-4234-9234-123456789012',
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('/api/worlds');
  });
  it('updates a known UUID and only recreates on an actual 404', async () => {
    const doc = createWorld({ size: { x: 32, z: 32 } });
    doc.id = '12345678-1234-4234-9234-123456789012';
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: doc.id }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', request);
    expect(await remoteStore.save(doc)).toBe(doc.id);
    expect(request.mock.calls[0]?.[0]).toBe(`/api/worlds/${doc.id}`);
  });
  it('does not silently turn network failures into a missing file', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ message: 'Offline fixture' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      remoteStore.load('12345678-1234-4234-9234-123456789012'),
    ).rejects.toThrow('Offline fixture');
  });
});
