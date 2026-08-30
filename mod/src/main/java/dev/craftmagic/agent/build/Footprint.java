package dev.craftmagic.agent.build;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;

/**
 * Where a schematic lands when you say "put it <em>here</em>".
 *
 * <p>Split out as pure arithmetic because it is shared by callers that must agree —
 * {@code /craftmagic build}, the wand's punch, the wand's preview outline, and the placement of
 * every region of a world after the first — and because getting it wrong is invisible: the
 * build still appears, just not under the marker.
 *
 * <p>The subtle part is rotation. {@link BuildTask#plan()} maps a quarter-turned schematic
 * back into a box that still starts at the origin, but with its width and length swapped: a
 * 5×11 cottage turned 90° occupies 11×5. Centring on the <em>unrotated</em> size — which is
 * what the original {@code startBuild} did — slides the build sideways by half the difference,
 * so rotating a long building walked it out from under the player who was aiming it.
 *
 * <p>Verified without a running game by {@code gradlew verifyPlacement}.
 */
public final class Footprint {
	private Footprint() {
	}

	/** True for the two quarter turns, which exchange the X and Z extents. */
	private static boolean swapsAxes(Rotation rotation) {
		return rotation == Rotation.CLOCKWISE_90 || rotation == Rotation.COUNTERCLOCKWISE_90;
	}

	/** How far the placed build reaches along X, after rotation. */
	public static int width(int width, int length, Rotation rotation) {
		return swapsAxes(rotation) ? length : width;
	}

	/** How far the placed build reaches along Z, after rotation. */
	public static int length(int width, int length, Rotation rotation) {
		return swapsAxes(rotation) ? width : length;
	}

	/**
	 * The corner to hand {@link BuildTask}, given the block a player marked.
	 *
	 * <p>Centred horizontally on the marker and rising from it: "here" means the middle of the
	 * floor to someone pointing at the ground, not the north-west corner. Integer division
	 * biases an even-sided build one block north-west, which is the only choice that keeps the
	 * marker inside the footprint.
	 */
	public static BlockPos origin(int width, int length, Rotation rotation, BlockPos marker) {
		return marker.offset(-width(width, length, rotation) / 2, 0, -length(width, length, rotation) / 2);
	}

	/**
	 * Turn a displacement, not a box.
	 *
	 * <p>A world arrives one region at a time, each region an ordinary build, each carrying the
	 * offset in blocks from the world's north-west corner to its own. Region 0 is placed by a
	 * player, who may turn it — and turning region 0 turns the <em>map</em>, not just that one
	 * tile. So the offset has to be turned by the same amount before it is added to the anchor.
	 * Added raw, a quarter-turned world comes out with every region rotated correctly and then
	 * laid out along the wrong axes: scattered, and mirrored about the diagonal.
	 *
	 * <p>This is the linear half of what {@link BuildTask#plan()} does to a block inside a
	 * schematic — (x,z) → (−z,x) for a quarter turn clockwise — without the shift that pulls the
	 * turned box back to a north-west corner at the origin. That shift belongs to a box of a
	 * known size and a displacement has no size, so applying it here would move every region by
	 * half of some other region's width.
	 *
	 * <p>One assumption is worth naming: adding the turned offset to the anchor is exact while
	 * every region shares a footprint, which is what a world whose extent divides evenly by its
	 * region size gives you. A truncated edge region under a quarter turn sits off by the
	 * difference between its own extent and a full region's, because the corner {@code BuildTask}
	 * builds from is the low corner of the turned box rather than the turned position of the
	 * region's first block. Unrotated worlds — nearly all of them — are unaffected either way.
	 */
	public static BlockPos turn(int dx, int dy, int dz, Rotation rotation) {
		return switch (rotation) {
			case CLOCKWISE_90 -> new BlockPos(-dz, dy, dx);
			case CLOCKWISE_180 -> new BlockPos(-dx, dy, -dz);
			case COUNTERCLOCKWISE_90 -> new BlockPos(dz, dy, -dx);
			default -> new BlockPos(dx, dy, dz);
		};
	}

	/**
	 * Quarter turns clockwise, which is how the wire protocol says rotation.
	 *
	 * <p>Written out rather than taken from {@code Rotation.ordinal()}: the two agree today, and
	 * a reordering of a vanilla enum would silently turn every world a mod places by ninety
	 * degrees rather than failing to compile.
	 */
	public static int quarterTurns(Rotation rotation) {
		return switch (rotation) {
			case CLOCKWISE_90 -> 1;
			case CLOCKWISE_180 -> 2;
			case COUNTERCLOCKWISE_90 -> 3;
			default -> 0;
		};
	}

	/** The inverse of {@link #quarterTurns}, wrapping rather than throwing on a value off the wire. */
	public static Rotation rotation(int quarterTurns) {
		return switch (Math.floorMod(quarterTurns, 4)) {
			case 1 -> Rotation.CLOCKWISE_90;
			case 2 -> Rotation.CLOCKWISE_180;
			case 3 -> Rotation.COUNTERCLOCKWISE_90;
			default -> Rotation.NONE;
		};
	}
}
