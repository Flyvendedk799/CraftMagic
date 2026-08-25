/**
 * The oak cottage the landing hero assembles.
 *
 * Written out block by block rather than expanded from a real build program. The expander in
 * `packages/core` is the product and this is a poster for it: the hero has to draw the same
 * silhouette on every load, at a block count tuned so the assembly animation lands in a few
 * seconds, and it has to do that before any of the app's own code has been asked for. Running
 * the real pipeline here would tie the front page's first paint to the generator, the block
 * registry and the mesher — none of which the page otherwise touches.
 *
 * Keep it in step with what the product actually produces: a cottage with a stone chimney is
 * the first prompt in the hero's typed list, and the two should not diverge.
 */

/** Every colour is read straight off the block it stands for, not from the brand palette. */
const COLOURS = {
  grass: 0x4f8f36,
  grassAlt: 0x59a03f,
  plank: 0xb07a41,
  log: 0x7a5230,
  roof: 0xa63c2b,
  roofAlt: 0xb8492f,
  /** Windows glow mint — the one place the brand colour appears in the build itself. */
  glass: 0x6ee7b7,
  chimney: 0x6f747b,
  door: 0x5b3d22,
} as const;

export interface CottageBlock {
  x: number;
  y: number;
  z: number;
  /** Hex colour for the block's material. */
  colour: number;
  /** Windows are emissive and slightly transparent; everything else is opaque. */
  glow: boolean;
}

/**
 * The cottage, ordered the way it should be built.
 *
 * The sort at the end is the whole animation: bottom-up, then centre-out within each layer, so
 * the hero reads as a structure going up course by course rather than blocks appearing at
 * random. The renderer just walks this array in order.
 */
export function buildCottage(): CottageBlock[] {
  const blocks: CottageBlock[] = [];
  const add = (x: number, y: number, z: number, colour: number, glow = false) =>
    blocks.push({ x, y, z, colour, glow });

  // Ground: a 7×7 checker so the base does not read as one flat slab.
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      add(x, 0, z, (x + z) & 1 ? COLOURS.grass : COLOURS.grassAlt);
    }
  }

  // Walls: three courses of a 5×5 shell, hollow, with corner posts in log.
  for (let y = 1; y <= 3; y++) {
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        const onEdge = x === -2 || x === 2 || z === -2 || z === 2;
        if (!onEdge) continue;

        // A two-high doorway in the middle of the front wall.
        if (z === 2 && x === 0 && (y === 1 || y === 2)) {
          add(x, y, z, COLOURS.door);
          continue;
        }

        // Windows only on the middle course, and never in a corner post.
        const isWindow =
          y === 2 &&
          ((Math.abs(x) === 2 && z === 0) ||
            (z === -2 && Math.abs(x) === 1) ||
            (z === 2 && Math.abs(x) === 1));
        const isCorner = Math.abs(x) === 2 && Math.abs(z) === 2;
        add(x, y, z, isWindow ? COLOURS.glass : isCorner ? COLOURS.log : COLOURS.plank, isWindow);
      }
    }
  }

  // Roof: four shrinking rings, alternating shade per course, topping out in a single block.
  for (const { y, radius } of [
    { y: 4, radius: 3 },
    { y: 5, radius: 2 },
    { y: 6, radius: 1 },
    { y: 7, radius: 0 },
  ]) {
    for (let x = -radius; x <= radius; x++) {
      for (let z = -radius; z <= radius; z++) {
        const onRing = radius === 0 || Math.abs(x) === radius || Math.abs(z) === radius;
        if (onRing) add(x, y, z, y % 2 ? COLOURS.roof : COLOURS.roofAlt);
      }
    }
  }

  // Chimney: one column up the back-right corner, through the roof line.
  for (let y = 1; y <= 5; y++) add(2, y, -2, COLOURS.chimney);

  blocks.sort((a, b) => a.y - b.y || Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  return blocks;
}
