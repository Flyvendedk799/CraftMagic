package dev.craftmagic.agent.tools;

import dev.craftmagic.agent.command.CraftMagicCommand;

/**
 * Check who is allowed to pair a world, without needing a running Minecraft server.
 *
 * <p>This exists because the original rule — plain OP level 2 — made the headline feature
 * unreachable for most players, and nothing caught it. A singleplayer player without "Allow
 * Cheats" has permission level 0, so Brigadier dropped {@code pair} from the command tree and
 * typing it produced "Incorrect argument for command" pointing at the word itself. Every
 * automated test went through RCON, which is the server console at level 4, so the tests
 * exercised the one source that could never hit the bug.
 *
 * <p>The API calls that gather these four facts still need a real server. The *policy* does
 * not, and the policy is what was wrong.
 *
 *   gradlew verifyPermissions
 */
public final class PermissionPolicyCheck {
	private PermissionPolicyCheck() {
	}

	private static int failures;

	public static void main(String[] args) {
		// dedicated, hasPlayer, owner, operator, expected, description
		check(false, true, true, false, true, "singleplayer host WITHOUT cheats (the reported bug)");
		check(false, true, true, true, true, "singleplayer host with cheats");
		check(false, false, false, false, true, "integrated server console / command block");
		check(false, true, false, false, false, "LAN guest, not opped");
		check(false, true, false, true, true, "LAN guest the host has opped");
		check(true, true, false, false, false, "dedicated server, ordinary player");
		check(true, true, false, true, true, "dedicated server, operator");
		check(true, false, false, true, true, "dedicated server console (RCON)");
		check(true, false, false, false, false, "dedicated server, unprivileged non-player source");

		System.out.println();
		if (failures > 0) {
			System.out.println(failures + " permission case(s) wrong");
			System.exit(1);
		}
		System.out.println("permission policy verified");
	}

	private static void check(
			boolean dedicated,
			boolean hasPlayer,
			boolean owner,
			boolean operator,
			boolean expected,
			String description) {
		boolean actual = CraftMagicCommand.mayConfigure(dedicated, hasPlayer, owner, operator);
		boolean ok = actual == expected;
		if (!ok) failures++;
		System.out.printf(
				"  %s  %-46s  may pair = %s%n",
				ok ? "PASS" : "FAIL",
				description,
				actual ? "yes" : "no");
	}
}
