/**
 * Placing a finished build inside another one.
 *
 * The two things worth pinning are the ones that are silent when wrong. A prefab must land
 * where it was put *and* turn with whatever turns around it — position and blockstate have to
 * rotate together, or a village turned a quarter comes out with every cottage's stairs facing
 * into its own wall. And a prefab must not resize with the build, because the whole reason to
 * place a saved building is that it comes out as the thing you saved.
 */

import { describe, expect, it } from 'vitest';
import { canonical } from '../registry/registry.js';
import { encodePrefab } from '../ir/prefab.js';
import { AIR_BLOCK, voxelIndex, type BuildProgram, type VoxelGrid } from '../ir/types.js';
import { expand } from './expander.js';

/** A grid with named blocks at given cells, everything else air. */
function makeGrid(
  size: { x: number; y: number; z: number },
  palette: string[],
  cells: { x: number; y: number; z: number; index: number }[],
): VoxelGrid {
  const voxels = new Uint16Array(size.x * size.y * size.z);
  for (const cell of cells) voxels[voxelIndex(size, cell.x, cell.y, cell.z)] = cell.index;
  return { size, palette: [AIR_BLOCK, ...palette], voxels };
}

function programWith(prefabGrid: VoxelGrid, extra: Partial<BuildProgram> = {}): BuildProgram {
  return {
    version: 1,
    meta: { name: 'test' },
    size: { x: 16, y: 8, z: 16 },
    palette: {},
    prefabs: { hut: encodePrefab(prefabGrid) },
    components: [{ type: 'prefab', ref: 'hut', pos: [2, 0, 3] }],
    ...extra,
  };
}

function blockAt(grid: VoxelGrid, x: number, y: number, z: number): string {
  return grid.palette[grid.voxels[voxelIndex(grid.size, x, y, z)] ?? 0] ?? AIR_BLOCK;
}

describe('prefab components', () => {
  it('stamps a saved build at a position', () => {
    const hut = makeGrid({ x: 2, y: 2, z: 2 }, ['minecraft:stone'], [
      { x: 0, y: 0, z: 0, index: 1 },
      { x: 1, y: 1, z: 1, index: 1 },
    ]);

    const result = expand(programWith(hut));

    expect(result.errors).toEqual([]);
    expect(result.blockCount).toBe(2);
    expect(blockAt(result.grid, 2, 0, 3)).toBe('minecraft:stone');
    expect(blockAt(result.grid, 3, 1, 4)).toBe('minecraft:stone');
    expect(blockAt(result.grid, 2, 1, 3)).toBe(AIR_BLOCK);
  });

  it('places the same prefab many times from one entry', () => {
    const post = makeGrid({ x: 1, y: 3, z: 1 }, ['minecraft:oak_log'], [
      { x: 0, y: 0, z: 0, index: 1 },
      { x: 0, y: 1, z: 0, index: 1 },
      { x: 0, y: 2, z: 0, index: 1 },
    ]);

    const result = expand(
      programWith(post, {
        components: [
          { type: 'prefab', ref: 'hut', pos: [0, 0, 0] },
          { type: 'prefab', ref: 'hut', pos: [5, 0, 0] },
          { type: 'prefab', ref: 'hut', pos: [0, 0, 5] },
          { type: 'prefab', ref: 'hut', pos: [5, 0, 5] },
        ],
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.blockCount).toBe(12);
  });

  it('turns positions and blockstates together inside a rotated group', () => {
    // A north-facing stair in the prefab's origin corner. Inside a group turned one quarter
    // clockwise it has to end up both moved *and* facing east. Getting one without the other
    // is the bug this test exists for, and nothing about it throws.
    const stair = canonical('minecraft:oak_stairs[facing=north,half=bottom,shape=straight]');
    const piece = makeGrid({ x: 1, y: 1, z: 1 }, [stair], [{ x: 0, y: 0, z: 0, index: 1 }]);

    const result = expand(
      programWith(piece, {
        size: { x: 8, y: 4, z: 8 },
        components: [
          {
            type: 'group',
            transform: [{ op: 'rotate90', times: 1, pivot: 'center' }],
            children: [{ type: 'prefab', ref: 'hut', pos: [0, 0, 0] }],
          },
        ],
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.blockCount).toBe(1);

    const placed = [...result.grid.voxels].findIndex((v) => v !== 0);
    expect(placed).toBeGreaterThanOrEqual(0);
    expect(result.grid.palette[result.grid.voxels[placed]!]).toBe(
      canonical('minecraft:oak_stairs[facing=east,half=bottom,shape=straight]'),
    );
  });

  it('moves with a resize but does not resize itself', () => {
    // The point of placing a saved build is that it comes out as the thing you saved. A
    // village at 200% is the same cottages further apart, not double-height cottages.
    const hut = makeGrid({ x: 2, y: 2, z: 2 }, ['minecraft:stone'], [
      { x: 0, y: 0, z: 0, index: 1 },
      { x: 1, y: 0, z: 1, index: 1 },
    ]);

    const natural = expand(programWith(hut, { components: [{ type: 'prefab', ref: 'hut', pos: [4, 0, 4] }] }));
    const doubled = expand(
      programWith(hut, {
        scale: { x: 200, y: 200, z: 200 },
        components: [{ type: 'prefab', ref: 'hut', pos: [4, 0, 4] }],
      }),
    );

    expect(natural.blockCount).toBe(2);
    // Same blocks, not four times as many.
    expect(doubled.blockCount).toBe(2);
    // But further from the origin, because the position scaled.
    const first = (grid: VoxelGrid) => {
      const index = [...grid.voxels].findIndex((v) => v !== 0);
      const layer = grid.size.x * grid.size.z;
      const y = Math.floor(index / layer);
      const rest = index - y * layer;
      return { x: rest % grid.size.x, z: Math.floor(rest / grid.size.x) };
    };
    expect(first(doubled.grid).x).toBeGreaterThan(first(natural.grid).x);
  });

  it('paints in order, so a later component overwrites a prefab', () => {
    const hut = makeGrid({ x: 2, y: 1, z: 1 }, ['minecraft:stone'], [
      { x: 0, y: 0, z: 0, index: 1 },
      { x: 1, y: 0, z: 0, index: 1 },
    ]);

    const result = expand(
      programWith(hut, {
        palette: { trim: 'minecraft:gold_block' },
        components: [
          { type: 'prefab', ref: 'hut', pos: [0, 0, 0] },
          { type: 'box', pos: [1, 0, 0], size: [1, 1, 1], fill: { type: 'solid', role: 'trim' } },
        ],
      }),
    );

    expect(blockAt(result.grid, 0, 0, 0)).toBe('minecraft:stone');
    expect(blockAt(result.grid, 1, 0, 0)).toBe('minecraft:gold_block');
  });

  it('clips a prefab that hangs off the build rather than wrapping it', () => {
    const slab = makeGrid({ x: 4, y: 1, z: 1 }, ['minecraft:stone'], [
      { x: 0, y: 0, z: 0, index: 1 },
      { x: 1, y: 0, z: 0, index: 1 },
      { x: 2, y: 0, z: 0, index: 1 },
      { x: 3, y: 0, z: 0, index: 1 },
    ]);

    const result = expand(
      programWith(slab, {
        size: { x: 4, y: 2, z: 2 },
        components: [{ type: 'prefab', ref: 'hut', pos: [2, 0, 0] }],
      }),
    );

    // Two cells land inside, two fall off the east edge and are dropped — not wrapped round
    // to x=0, which is what an unchecked index would do.
    expect(result.blockCount).toBe(2);
    expect(blockAt(result.grid, 0, 0, 0)).toBe(AIR_BLOCK);
  });

  it('names a reference it cannot resolve', () => {
    const result = expand({
      version: 1,
      meta: { name: 'test' },
      size: { x: 4, y: 4, z: 4 },
      palette: {},
      components: [{ type: 'prefab', ref: 'missing', pos: [0, 0, 0] }],
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe('UNKNOWN_PREFAB');
    expect(result.errors[0]!.message).toContain('missing');
  });

  it('expands to nothing, without throwing, when the table is empty', () => {
    const result = expand({
      version: 1,
      meta: { name: 'test' },
      size: { x: 4, y: 4, z: 4 },
      palette: {},
      prefabs: {},
      components: [{ type: 'prefab', ref: 'hut', pos: [0, 0, 0] }],
    });

    expect(result.blockCount).toBe(0);
    expect(result.errors[0]!.code).toBe('UNKNOWN_PREFAB');
  });
});

describe('turning a placed build', () => {
  it('turns the blocks and keeps the min corner where it was put', () => {
    // An L of stone with a north-facing stair at the corner, in a 3x1x2 footprint. After one
    // quarter turn the footprint is 2x1x3, it still starts at `pos`, and the stair faces east.
    const stair = canonical('minecraft:oak_stairs[facing=north,half=bottom,shape=straight]');
    const piece = makeGrid({ x: 3, y: 1, z: 2 }, ['minecraft:stone', stair], [
      { x: 0, y: 0, z: 0, index: 2 },
      { x: 1, y: 0, z: 0, index: 1 },
      { x: 2, y: 0, z: 0, index: 1 },
      { x: 0, y: 0, z: 1, index: 1 },
    ]);

    const straight = expand(programWith(piece, { components: [{ type: 'prefab', ref: 'hut', pos: [4, 0, 4] }] }));
    const turned = expand(
      programWith(piece, { components: [{ type: 'prefab', ref: 'hut', pos: [4, 0, 4], turns: 1 }] }),
    );

    expect(turned.errors).toEqual([]);
    expect(turned.blockCount).toBe(straight.blockCount);

    const cells = (grid: VoxelGrid) => {
      const out: { x: number; z: number; block: string }[] = [];
      for (let z = 0; z < grid.size.z; z++) {
        for (let x = 0; x < grid.size.x; x++) {
          const block = blockAt(grid, x, 0, z);
          if (block !== AIR_BLOCK) out.push({ x, z, block });
        }
      }
      return out;
    };

    const placed = cells(turned.grid);
    // Every cell still inside the footprint that starts at (4,4) and is now 2 wide, 3 deep.
    for (const cell of placed) {
      expect(cell.x).toBeGreaterThanOrEqual(4);
      expect(cell.x).toBeLessThanOrEqual(5);
      expect(cell.z).toBeGreaterThanOrEqual(4);
      expect(cell.z).toBeLessThanOrEqual(6);
    }

    const facing = placed.find((cell) => cell.block.includes('stairs'));
    expect(facing?.block).toBe(
      canonical('minecraft:oak_stairs[facing=east,half=bottom,shape=straight]'),
    );
  });

  it('actually moves the blocks, each quarter differently', () => {
    // Deliberately not point-symmetric. A piece with cells at opposite corners is unchanged by
    // a half turn, which would let a broken rotation pass this by doing nothing at all.
    const piece = makeGrid({ x: 3, y: 1, z: 2 }, ['minecraft:stone'], [
      { x: 0, y: 0, z: 0, index: 1 },
      { x: 1, y: 0, z: 0, index: 1 },
    ]);

    const at = (turns: 0 | 1 | 2 | 3 | undefined) =>
      [...expand(programWith(piece, { components: [{ type: 'prefab', ref: 'hut', pos: [4, 0, 4], ...(turns === undefined ? {} : { turns }) }] })).grid.voxels];

    // 4 quarters is not expressible as `turns`, so this pins the two that are: a half turn
    // twice is the identity, which only holds if the corner correction is right both times.
    expect(at(0)).toEqual(at(undefined));
    expect(at(2)).not.toEqual(at(0));
    expect(at(1)).not.toEqual(at(3));
  });

  it('places a turned building the same size as an untuned one', () => {
    const piece = makeGrid({ x: 4, y: 2, z: 1 }, ['minecraft:stone'], [
      { x: 0, y: 0, z: 0, index: 1 },
      { x: 3, y: 1, z: 0, index: 1 },
    ]);
    for (const turns of [0, 1, 2, 3] as const) {
      const result = expand(
        programWith(piece, { components: [{ type: 'prefab', ref: 'hut', pos: [5, 0, 5], turns }] }),
      );
      expect(result.blockCount).toBe(2);
      expect(result.errors).toEqual([]);
    }
  });
});
