package dev.craftmagic.agent.tools;

import dev.craftmagic.agent.build.Footprint;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;

/**
 * Check that a build lands under the spot the player marked.
 *
 * <p>The wand's whole promise is "it goes where I point". The one way that quietly breaks is
 * rotation: {@code BuildTask} maps a quarter-turned schematic into a box whose width and
 * length have swapped, so centring on the <em>unrotated</em> size slides the build sideways by
 * half the difference. Nothing errors — the build appears, just not where the outline was.
 *
 * <p>This is pure arithmetic, so it needs no world, no client and no bootstrap. That is the
 * point: the same class of bug as the permission policy, caught the same way.
 *
 *   gradlew verifyPlacement
 */
public final class PlacementCheck {
	private PlacementCheck() {
	}

	private static int failures;

	public static void main(String[] args) {
		// A 5-wide, 11-long cottage. Turned a quarter, it must occupy 11 by 5.
		footprint(5, 11, Rotation.NONE, 5, 11, "unrotated keeps its own extents");
		footprint(5, 11, Rotation.CLOCKWISE_90, 11, 5, "a quarter turn swaps them");
		footprint(5, 11, Rotation.CLOCKWISE_180, 5, 11, "a half turn does not");
		footprint(5, 11, Rotation.COUNTERCLOCKWISE_90, 11, 5, "the other quarter turn swaps them too");

		// Centring, at a marker of 100/64/100.
		origin(5, 11, Rotation.NONE, 98, 95, "odd sides centre exactly");
		origin(5, 11, Rotation.CLOCKWISE_90, 95, 98, "a quarter turn centres on the SWAPPED size");
		origin(4, 4, Rotation.NONE, 98, 98, "even sides bias north-west, keeping the marker inside");
		origin(1, 1, Rotation.NONE, 100, 100, "a single block sits on the marker");

		markerInsideFootprint();

		System.out.println();
		if (failures > 0) {
			System.out.println(failures + " placement case(s) wrong");
			System.exit(1);
		}
		System.out.println("placement verified");
	}

	/**
	 * The regression the wand would show first.
	 *
	 * <p>Whatever the size or rotation, the block the player right-clicked must be somewhere
	 * inside the rectangle that gets built. If it is not, the particle outline the player aimed
	 * with is drawn around a spot the build does not occupy.
	 */
	private static void markerInsideFootprint() {
		BlockPos marker = new BlockPos(0, 64, 0);
		for (Rotation rotation : Rotation.values()) {
			for (int width = 1; width <= 24; width++) {
				for (int length = 1; length <= 24; length++) {
					BlockPos origin = Footprint.origin(width, length, rotation, marker);
					int fw = Footprint.width(width, length, rotation);
					int fl = Footprint.length(width, length, rotation);

					boolean inside = marker.getX() >= origin.getX()
							&& marker.getX() < origin.getX() + fw
							&& marker.getZ() >= origin.getZ()
							&& marker.getZ() < origin.getZ() + fl;
					if (!inside) {
						failures++;
						System.out.printf(
								"  FAIL  marker outside the footprint: %d×%d %s%n", width, length, rotation);
						return;
					}
				}
			}
		}
		System.out.printf("  PASS  %-46s%n", "the marker is always inside the footprint");
	}

	private static void footprint(
			int width, int length, Rotation rotation, int expectedWidth, int expectedLength, String description) {
		int actualWidth = Footprint.width(width, length, rotation);
		int actualLength = Footprint.length(width, length, rotation);
		boolean ok = actualWidth == expectedWidth && actualLength == expectedLength;
		if (!ok) failures++;
		System.out.printf(
				"  %s  %-46s  %d×%d%n", ok ? "PASS" : "FAIL", description, actualWidth, actualLength);
	}

	private static void origin(
			int width, int length, Rotation rotation, int expectedX, int expectedZ, String description) {
		BlockPos actual = Footprint.origin(width, length, rotation, new BlockPos(100, 64, 100));
		boolean ok = actual.getX() == expectedX && actual.getZ() == expectedZ && actual.getY() == 64;
		if (!ok) failures++;
		System.out.printf(
				"  %s  %-46s  origin %d,%d,%d%n",
				ok ? "PASS" : "FAIL", description, actual.getX(), actual.getY(), actual.getZ());
	}
}
