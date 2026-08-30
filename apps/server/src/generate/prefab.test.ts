/**
 * What a refine tells the model about placed buildings, and what it must not.
 *
 * A prefab is a whole saved building encoded as base64. Sending one to a model costs real
 * money on every refine, teaches it nothing it can act on — it cannot rewrite a prefab's
 * blocks, only move the component that places it — and would crowd out the part of the
 * program the instruction is actually about.
 *
 * Withholding it creates the opposite hazard, which is why both halves are pinned here: the
 * model answers with a program that has no prefab table, and if that reached the expander
 * every placement would report `UNKNOWN_PREFAB` and buy a *paid* repair round to fix a
 * problem we invented. The prompt drops the table; the pipeline puts it back.
 */

import { describe, expect, it } from 'vitest';
import { encodePrefab, type BuildProgram, type VoxelGrid } from '@craftmagic/core';
import { refinePrompt } from './prompt.js';

function savedBuild(): VoxelGrid {
  // Big enough that its encoding is unmistakable in a prompt if it leaks.
  const size = { x: 12, y: 8, z: 12 };
  const voxels = new Uint16Array(size.x * size.y * size.z);
  for (let i = 0; i < voxels.length; i += 3) voxels[i] = 1;
  return { size, palette: ['minecraft:air', 'minecraft:stone'], voxels };
}

function programWithPrefab(): BuildProgram {
  return {
    version: 1,
    meta: { name: 'Hamlet' },
    size: { x: 64, y: 24, z: 64 },
    palette: { path: 'minecraft:gravel' },
    prefabs: { cottage: encodePrefab(savedBuild()) },
    components: [
      { type: 'box', id: 'ground', pos: [0, 0, 0], size: [64, 1, 64], fill: { type: 'solid', role: 'path' } },
      { type: 'prefab', id: 'c1', ref: 'cottage', pos: [4, 1, 4] },
      { type: 'prefab', id: 'c2', ref: 'cottage', pos: [30, 1, 4] },
    ],
  };
}

describe('refinePrompt with placed buildings', () => {
  it('does not send the encoded blocks', () => {
    const program = programWithPrefab();
    const encoded = program.prefabs!.cottage!.data;
    const prompt = refinePrompt(program, 'move the second cottage south');

    expect(encoded.length).toBeGreaterThan(200);
    expect(prompt).not.toContain(encoded);
    // Not even a fragment: a truncated blob is still money spent on noise.
    expect(prompt).not.toContain(encoded.slice(0, 64));
  });

  it('keeps the placements themselves, which are what the model can act on', () => {
    const prompt = refinePrompt(programWithPrefab(), 'move the second cottage south');
    expect(prompt).toContain('"prefab"');
    expect(prompt).toContain('cottage');
    expect(prompt).toContain('c2');
  });

  it('says the blocks are not the model’s to write', () => {
    const prompt = refinePrompt(programWithPrefab(), 'add a well');
    expect(prompt).toMatch(/saved building/i);
    expect(prompt).toMatch(/not yours to write/i);
  });

  it('counts the buildings, so "1 saved building" is not plural', () => {
    const program = programWithPrefab();
    const prompt = refinePrompt(program, 'x');
    expect(prompt).toContain('places 1 saved building ');
  });

  it('stays quiet about prefabs when a build has none', () => {
    const plain: BuildProgram = {
      version: 1,
      meta: { name: 'Cottage' },
      size: { x: 8, y: 8, z: 8 },
      palette: { wall: 'minecraft:stone' },
      components: [{ type: 'box', pos: [0, 0, 0], size: [4, 4, 4], fill: { type: 'solid', role: 'wall' } }],
    };
    expect(refinePrompt(plain, 'make it taller')).not.toMatch(/saved building/i);
  });

  it('is dramatically smaller than sending the table', () => {
    const program = programWithPrefab();
    const withTable = JSON.stringify(program, null, 1).length;
    const prompt = refinePrompt(program, 'move the second cottage south');
    expect(prompt.length).toBeLessThan(withTable);
  });

  it('still withholds the scale, which the user owns', () => {
    const program = { ...programWithPrefab(), scale: { x: 150, y: 150, z: 150 } };
    expect(refinePrompt(program, 'x')).not.toContain('150');
  });
});
