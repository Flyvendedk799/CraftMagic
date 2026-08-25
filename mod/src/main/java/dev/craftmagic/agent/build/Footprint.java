package dev.craftmagic.agent.build;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;

/**
 * Where a schematic lands when you say "put it <em>here</em>".
 *
 * <p>Split out as pure arithmetic because it is shared by three callers that must agree —
 * {@code /craftmagic build}, the wand's punch, and the wand's preview outline — and because
 * getting it wrong is invisible: the build still appears, just not under the marker.
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
}
