import { describe, expect, it } from 'vitest';
import { FLAG_TRANSPARENT, meshChunk, meshCuts, type MeshSource } from './mesher.js';

/**
 * A tiny world builder. Palette slot 1 is stone, 2 is glass, and `fill` paints boxes the way
 * the plan compiler does so these tests can talk about walls rather than about indices.
 */
function world(x: number, y: number, z: number): MeshSource & {
  fill: (a: number[], b: number[], v: number) => void;
} {
  const voxels = new Uint16Array(x * y * z);
  const src = {
    size: { x, y, z },
    voxels,
    paletteColors: Uint8Array.of(0, 0, 0, 200, 180, 140, 180, 220, 240),
    paletteFlags: Uint8Array.of(0, 0, FLAG_TRANSPARENT),
    fill(a: number[], b: number[], v: number) {
      for (let yy = a[1]!; yy <= b[1]!; yy++)
        for (let zz = a[2]!; zz <= b[2]!; zz++)
          for (let xx = a[0]!; xx <= b[0]!; xx++) voxels[xx + zz * x + yy * (x * z)] = v;
    },
  };
  return src;
}

/** Every quad's centre, so a test can ask "is there a face here" without index arithmetic. */
function centres(buffers: { positions: Float32Array } | null): Set<string> {
  const out = new Set<string>();
  if (!buffers) return out;
  const p = buffers.positions;
  for (let q = 0; q < p.length; q += 12) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < 4; k++) {
      cx += p[q + k * 3]!;
      cy += p[q + k * 3 + 1]!;
      cz += p[q + k * 3 + 2]!;
    }
    out.add(`${cx / 4},${cy / 4},${cz / 4}`);
  }
  return out;
}

describe('meshCuts', () => {
  it('caps the shared wall a storey cutaway would otherwise look straight through', () => {
    // Two rooms sharing the wall column at x=3, with a ceiling over both at y=4 — the
    // geometry the layouter compiles for two rooms drawn edge to edge.
    const src = world(7, 6, 7);
    src.fill([0, 0, 0], [6, 0, 6], 1); // floor
    src.fill([0, 1, 0], [6, 3, 6], 1); // solid mass, carved below
    src.fill([1, 1, 1], [2, 3, 5], 0); // room A
    src.fill([4, 1, 1], [5, 3, 5], 0); // room B
    src.fill([0, 4, 0], [6, 4, 6], 1); // ceiling

    // Nothing meshes the top of the party wall: the ceiling sits on it.
    const chunk = meshChunk(src, 0, 0, 0);
    expect(centres(chunk.opaque)).not.toContain('3.5,4,3.5');

    // Cut the ceiling away and the cap supplies it, so the wall reads as a wall from above.
    const { opaque } = meshCuts(src, { maxY: 3 });
    expect(centres(opaque)).toContain('3.5,4,3.5');
  });

  it('caps only where the mesher culled — never doubling a face that is already drawn', () => {
    const src = world(4, 4, 4);
    src.fill([1, 0, 1], [2, 1, 2], 1); // a 2x2x2 lump, air above it

    const chunk = centres(meshChunk(src, 0, 0, 0).opaque);
    const cut = centres(meshCuts(src, { maxY: 1 }).opaque);

    // The lump's own top is already meshed against the air above, so the cut adds nothing.
    expect(chunk).toContain('1.5,2,1.5');
    expect(cut.size).toBe(0);
  });

  it('cuts on every axis, and leaves an uncut face alone', () => {
    const src = world(5, 5, 5);
    src.fill([0, 0, 0], [4, 4, 4], 1);

    expect(meshCuts(src, { maxX: 2 }).opaque?.positions.length).toBe(25 * 12);
    expect(meshCuts(src, { minZ: 2 }).opaque?.positions.length).toBe(25 * 12);
    // Two faces of the box, so two planes of 25.
    expect(meshCuts(src, { minY: 1, maxY: 3 }).opaque?.positions.length).toBe(50 * 12);
    expect(meshCuts(src, {}).opaque).toBeNull();
  });

  it('ignores a cut that exposes nothing', () => {
    const src = world(5, 5, 5);
    src.fill([0, 0, 0], [4, 4, 4], 1);

    // The outermost cell facing outwards already has its face; so does a cut past the grid.
    expect(meshCuts(src, { maxY: 4 }).opaque).toBeNull();
    expect(meshCuts(src, { minY: 0 }).opaque).toBeNull();
    expect(meshCuts(src, { maxY: 99 }).opaque).toBeNull();
    expect(meshCuts(src, { minY: -3 }).opaque).toBeNull();
  });

  it('sends a cut through glass to the transparent buffer', () => {
    const src = world(4, 4, 4);
    src.fill([0, 0, 0], [3, 3, 3], 2);

    // Panes of the same glass fuse, so the mesher culled the seam and the cut restores it —
    // into the transparent buffer, or a sliced window would come back as a slab of stone.
    const { opaque, transparent } = meshCuts(src, { maxY: 1 });
    expect(opaque).toBeNull();
    expect(transparent?.positions.length).toBe(16 * 12);
  });
});
