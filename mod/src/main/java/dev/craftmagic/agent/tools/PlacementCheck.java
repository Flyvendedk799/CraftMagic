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
 * <p>Worlds raise the same question again and answer it differently. A region of a world goes
 * where the map says rather than where anyone points, and its offset from the map's corner has
 * to be turned by the turn the player gave region 0. Get that wrong and the world still builds
 * — every region correct in itself, laid out across the wrong squares.
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

		// The world tier. A region is placed from an anchor and an offset rather than from a
		// player, and the offset has to be turned by the anchor's rotation on the way.
		turned(1, 0, Rotation.NONE, 1, 0, "no turn leaves a displacement alone");
		turned(1, 0, Rotation.CLOCKWISE_90, 0, 1, "a quarter clockwise sends east to south");
		turned(1, 0, Rotation.CLOCKWISE_180, -1, 0, "a half turn sends east to west");
		turned(1, 0, Rotation.COUNTERCLOCKWISE_90, 0, -1, "the other quarter sends east to north");
		turned(0, 1, Rotation.CLOCKWISE_90, -1, 0, "and south to west");

		for (Rotation rotation : Rotation.values()) regionsFormOneMap(rotation);
		unturnedOffsetsScatterTheMap();

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

	/** Edge of one region, and how many of them across, for the tiling checks below. */
	private static final int REGION = 8;
	private static final int GRID = 3;

	/**
	 * The regression a delivered world would show first.
	 *
	 * <p>Lay a 3×3 grid of regions from one anchor, place every block of every one of them, and
	 * demand that the result is what the map would have been if it had been one enormous
	 * schematic: every block at the anchor plus its own turned position in the whole map, under
	 * a single transform shared by all nine regions.
	 *
	 * <p>Counting blocks would not catch this. Square regions tile whether their offsets were
	 * turned or not — turning a square in place does not change the square it fills — so the
	 * broken layout covers exactly the same ground as the correct one, with each region's
	 * contents in somebody else's square. That is why the check compares positions against the
	 * map rather than looking for overlaps or holes.
	 *
	 * <p>The block mapping below is {@link dev.craftmagic.agent.build.BuildTask}'s, copied
	 * because that class needs a live {@code ServerLevel} to construct and this check needs no
	 * game at all. The two must stay in step; if a turn is ever changed there, change it here.
	 */
	private static void regionsFormOneMap(Rotation rotation) {
		boolean ok = laysOutAsOneMap(rotation, true);
		if (!ok) failures++;
		System.out.printf(
				"  %s  %-46s%n", ok ? "PASS" : "FAIL", GRID + "×" + GRID + " regions form one map under " + rotation);
	}

	/**
	 * Prove the check above would have caught the bug it exists for.
	 *
	 * <p>Add the offsets to the anchor without turning them, under a quarter turn, and the map
	 * comes out mirrored about its diagonal: region (2,0) holds what belongs at (0,2). If this
	 * ever stops failing, the layout check has stopped depending on the turn and is testing
	 * nothing.
	 */
	private static void unturnedOffsetsScatterTheMap() {
		boolean scattered = !laysOutAsOneMap(Rotation.CLOCKWISE_90, false);
		if (!scattered) failures++;
		System.out.printf(
				"  %s  %-46s%n", scattered ? "PASS" : "FAIL", "an unturned offset scatters a turned world");
	}

	/** Whether every block of every region lands where one transform of the whole map puts it. */
	private static boolean laysOutAsOneMap(Rotation rotation, boolean turnOffsets) {
		BlockPos anchor = new BlockPos(100, 64, 100);
		// Region 0's block (0,0) is the map's block (0,0), so it fixes the transform everything
		// else is measured against — no need to know where the whole map's corner would be.
		BlockPos base = anchor.offset(mappedX(0, 0, rotation), 0, mappedZ(0, 0, rotation));

		for (int rx = 0; rx < GRID; rx++) {
			for (int rz = 0; rz < GRID; rz++) {
				BlockPos shift = turnOffsets
						? Footprint.turn(rx * REGION, 0, rz * REGION, rotation)
						: new BlockPos(rx * REGION, 0, rz * REGION);
				BlockPos origin = anchor.offset(shift.getX(), shift.getY(), shift.getZ());

				for (int x = 0; x < REGION; x++) {
					for (int z = 0; z < REGION; z++) {
						BlockPos at = origin.offset(mappedX(x, z, rotation), 0, mappedZ(x, z, rotation));
						BlockPos inMap =
								Footprint.turn(rx * REGION + x, 0, rz * REGION + z, rotation);
						if (!at.equals(base.offset(inMap.getX(), inMap.getY(), inMap.getZ()))) return false;
					}
				}
			}
		}
		return true;
	}

	/** {@code BuildTask}'s X mapping for a block inside a REGION×REGION schematic. */
	private static int mappedX(int x, int z, Rotation rotation) {
		return switch (rotation) {
			case CLOCKWISE_90 -> REGION - 1 - z;
			case CLOCKWISE_180 -> REGION - 1 - x;
			case COUNTERCLOCKWISE_90 -> z;
			default -> x;
		};
	}

	/** {@code BuildTask}'s Z mapping for the same block. */
	private static int mappedZ(int x, int z, Rotation rotation) {
		return switch (rotation) {
			case CLOCKWISE_90 -> x;
			case CLOCKWISE_180 -> REGION - 1 - z;
			case COUNTERCLOCKWISE_90 -> REGION - 1 - x;
			default -> z;
		};
	}

	private static void turned(
			int dx, int dz, Rotation rotation, int expectedX, int expectedZ, String description) {
		BlockPos actual = Footprint.turn(dx, 0, dz, rotation);
		boolean ok = actual.getX() == expectedX && actual.getZ() == expectedZ && actual.getY() == 0;
		if (!ok) failures++;
		System.out.printf(
				"  %s  %-46s  %d,%d%n", ok ? "PASS" : "FAIL", description, actual.getX(), actual.getZ());
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
