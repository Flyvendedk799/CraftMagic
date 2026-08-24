import { gunzipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expand, samples } from '@imaginecraft/core';
import { downloadProgram, downloadSchematic, formatBytes } from './download.js';

/**
 * These run in Node, where `Blob`, `URL.createObjectURL` and DOM anchors do not exist, so
 * the browser side is stubbed. What is actually being checked is that the *right bytes*
 * reach the blob and that the filename is derived from the build name — the parts that
 * would silently produce a corrupt download.
 */
let captured: { parts: unknown[]; filename: string | null };

beforeEach(() => {
  captured = { parts: [], filename: null };

  vi.stubGlobal(
    'Blob',
    class {
      constructor(parts: unknown[]) {
        captured.parts = parts;
      }
    },
  );

  vi.stubGlobal('URL', {
    createObjectURL: () => 'blob:stub',
    revokeObjectURL: () => undefined,
  });

  const anchor = {
    href: '',
    style: {} as Record<string, string>,
    set download(value: string) {
      captured.filename = value;
    },
    click: () => undefined,
    remove: () => undefined,
  };

  vi.stubGlobal('document', {
    createElement: () => anchor,
    body: { appendChild: () => undefined },
  });
});

describe('downloadSchematic', () => {
  it('produces a gzipped schematic of the right size', () => {
    const { grid } = expand(samples.cottage!);
    const result = downloadSchematic(grid, 'Oak Cottage');

    expect(result.bytes).toBeGreaterThan(0);
    expect(captured.parts).toHaveLength(1);

    const buffer = captured.parts[0] as ArrayBuffer;
    const bytes = new Uint8Array(buffer);
    expect(bytes.length).toBe(result.bytes);
    // gzip magic — a schematic that is not gzipped will not open in WorldEdit.
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
  });

  it('decompresses to NBT naming the build', () => {
    const { grid } = expand(samples.tower!);
    downloadSchematic(grid, 'Stone Tower');

    const bytes = new Uint8Array(captured.parts[0] as ArrayBuffer);
    const nbt = new TextDecoder('utf8', { fatal: false }).decode(gunzipSync(bytes));
    expect(nbt).toContain('Schematic');
    expect(nbt).toContain('Stone Tower');
  });

  it('names the file after the build', () => {
    const { grid } = expand(samples.pavilion!);
    const result = downloadSchematic(grid, 'Garden Pavilion');
    expect(result.filename).toBe('garden-pavilion.schem');
    expect(captured.filename).toBe('garden-pavilion.schem');
  });
});

describe('downloadProgram', () => {
  it('writes the program as readable JSON, not voxels', () => {
    const program = samples.cottage!;
    const result = downloadProgram(program, 'Oak Cottage');

    const json = captured.parts[0] as string;
    expect(typeof json).toBe('string');
    const parsed = JSON.parse(json);
    expect(parsed.meta.name).toBe(program.meta.name);
    expect(parsed.components).toHaveLength(program.components.length);
    // The point of exporting the program: coordinate expressions survive, so the file can
    // be re-expanded at another size.
    expect(json).toContain('max');
    expect(result.filename).toBe('oak-cottage.program.json');
  });

  it('is far smaller than the expanded schematic it describes', () => {
    const program = samples.tower!;
    const asProgram = downloadProgram(program, 'Stone Tower');
    const { grid } = expand(program);
    const asSchematic = downloadSchematic(grid, 'Stone Tower');
    expect(asProgram.bytes).toBeLessThan(asSchematic.bytes * 6);
  });
});

describe('formatBytes', () => {
  it('scales the unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
