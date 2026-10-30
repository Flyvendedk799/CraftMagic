package dev.craftmagic.agent.tools;

import dev.craftmagic.agent.hud.ActionBar;
import dev.craftmagic.agent.wand.WandHandler;

/**
 * Check the wand's arithmetic and the action-bar throttle, without a running game.
 *
 * <p>Three things here shipped wrong once and looked fine in a quick play test:
 *
 * <ul>
 *   <li>The height gesture was inverted. Minecraft's pitch is positive looking <em>down</em>,
 *       so "look up to raise" lowered the build.
 *   <li>The wireframe's particle step was the edge length divided by 12 rounded <em>down</em>,
 *       which is 1 for every edge under 24 blocks — an ordinary house sent nearly 300 particles
 *       a second against a stated cap of 180.
 *   <li>Two features wrote the action bar every tick, so it flickered and flooded the socket.
 * </ul>
 *
 *   gradlew verifyWand
 */
public final class WandCheck {
	private WandCheck() {
	}

	private static int failures;

	public static void main(String[] args) {
		pitch();
		particleCap();
		edgesEndOnTheCorner();
		actionBarThrottle();

		System.out.println();
		if (failures > 0) {
			System.out.println(failures + " wand case(s) wrong");
			System.exit(1);
		}
		System.out.println("wand arithmetic verified");
	}

	private static void pitch() {
		check("looking straight up raises (+1)", WandHandler.heightStep(-90f) == 1);
		check("looking up past the threshold raises", WandHandler.heightStep(-40f) == 1);
		check("looking straight down lowers (-1)", WandHandler.heightStep(90f) == -1);
		check("looking down past the threshold lowers", WandHandler.heightStep(40f) == -1);
		check("level turns instead (0)", WandHandler.heightStep(0f) == 0);
		check("within the threshold turns", WandHandler.heightStep(35f) == 0 && WandHandler.heightStep(-35f) == 0);
		check("offset clamps at +64", WandHandler.clampOffset(65) == 64);
		check("offset clamps at -64", WandHandler.clampOffset(-200) == -64);
	}

	private static void particleCap() {
		int worst = 0;
		String worstAt = "";
		// Every edge length a schematic can plausibly have, in every combination that matters:
		// the count depends on each axis separately, so the worst per axis is the worst overall.
		for (int w = 1; w <= 1024; w++) {
			int count = WandHandler.outlineParticleCount(w, w, w);
			if (count > worst) {
				worst = count;
				worstAt = w + "³";
			}
		}
		check("outline stays under " + WandHandler.MAX_OUTLINE_PARTICLES + " (worst " + worst + " at " + worstAt + ")",
				worst < WandHandler.MAX_OUTLINE_PARTICLES);
		check("the old bug case (23 blocks) is now 13 points per edge", WandHandler.edgeOffsets(23).length == 13);
		check("a tiny build still gets both corners", WandHandler.edgeOffsets(1).length == 2);
	}

	private static void edgesEndOnTheCorner() {
		boolean ok = true;
		for (int n = 1; n <= 1024; n++) {
			int[] offsets = WandHandler.edgeOffsets(n);
			if (offsets[0] != 0 || offsets[offsets.length - 1] != n) ok = false;
			for (int i = 1; i < offsets.length; i++) {
				if (offsets[i] <= offsets[i - 1]) ok = false;
			}
		}
		check("every edge starts at 0, ends on its corner, and only moves forward", ok);
	}

	private static void actionBarThrottle() {
		check("first line is always sent", ActionBar.due(null, 0, "a", 0));
		check("the same line is not resent within the refresh window", !ActionBar.due("a", 100, "a", 139));
		check("the same line is resent before it fades", ActionBar.due("a", 100, "a", 140));
		check("a changed line waits out the minimum interval", !ActionBar.due("a", 100, "b", 105));
		check("a changed line goes after the minimum interval", ActionBar.due("a", 100, "b", 110));
		check("a new server's lower tick count resets", ActionBar.due("a", 5000, "a", 3));

		// Twenty ticks of a counter changing every tick: at most two sends, not twenty.
		int sends = 0;
		String last = null;
		long lastTick = 0;
		for (long t = 0; t < 20; t++) {
			String text = "placed " + t;
			if (ActionBar.due(last, lastTick, text, t)) {
				sends++;
				last = text;
				lastTick = t;
			}
		}
		check("a per-tick counter is sent at most twice a second (" + sends + ")", sends <= 2);
	}

	private static void check(String description, boolean ok) {
		if (!ok) failures++;
		System.out.printf("  %s  %s%n", ok ? "PASS" : "FAIL", description);
	}
}
