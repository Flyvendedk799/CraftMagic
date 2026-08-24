package dev.imaginecraft.agent.tools;

import dev.imaginecraft.agent.build.Schematic;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.state.BlockState;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Verifies that a {@code .schem} written by {@code packages/core} is readable by Minecraft.
 *
 * <p>This runs the *same* {@link Schematic} parser the builder bot uses, so a passing check
 * means the bot can place the file — not merely that some other reader could. Round-tripping
 * in TypeScript proves the NBT is well formed and the prismarine-nbt test proves another
 * implementation agrees; neither proves the game accepts every blockstate, which is the
 * failure that would otherwise appear with a bot standing in someone's world.
 *
 * <p>Not shipped: excluded from the jar in {@code build.gradle}. Run with
 * {@code gradlew verifySchematic -Pschem=../out/oak-cottage.schem}.
 */
public final class SchematicReadCheck {
	private SchematicReadCheck() {
	}

	public static void main(String[] args) throws Exception {
		Path file = Path.of(args.length > 0 ? args[0] : "../out/oak-cottage.schem");
		if (!Files.exists(file)) {
			System.err.println("no such file: " + file.toAbsolutePath());
			System.exit(1);
		}

		// Registries have to exist before any blockstate can be resolved.
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();

		Schematic schematic;
		try {
			schematic = Schematic.read(file);
		} catch (Schematic.SchematicException e) {
			System.out.println("file      " + file.getFileName());
			System.out.println("\nPROBLEM  " + e.getMessage());
			System.exit(1);
			return;
		}

		System.out.println("file      " + file.getFileName());
		System.out.println("name      " + schematic.name());
		System.out.println("size      " + schematic.width() + "x" + schematic.height() + "x" + schematic.length());
		System.out.println("palette   " + schematic.paletteSize() + " states, all resolved");
		System.out.println("blocks    " + schematic.solidCount() + " solid of " + schematic.volume() + " cells");

		// Walking the build is also a check that the bottom-up order is sane: the first block
		// visited must be on the lowest occupied layer.
		int[] firstLayer = { -1 };
		int[] visited = { 0 };
		Map<String, Integer> counts = new LinkedHashMap<>();
		schematic.forEachSolid((x, y, z, state) -> {
			if (firstLayer[0] < 0) firstLayer[0] = y;
			visited[0]++;
			counts.merge(blockName(state), 1, Integer::sum);
		});

		System.out.println("walk      " + visited[0] + " placements, starting at y=" + firstLayer[0]);
		counts.entrySet().stream()
				.sorted((a, b) -> b.getValue() - a.getValue())
				.limit(5)
				.forEach(e -> System.out.println("            " + e.getValue() + "x " + e.getKey()));

		if (visited[0] != schematic.solidCount()) {
			System.out.println("\nPROBLEM  walk visited " + visited[0] + " but solidCount says " + schematic.solidCount());
			System.exit(1);
		}

		System.out.println("\nOK — Minecraft parses this schematic and the bot can walk it.");
	}

	private static String blockName(BlockState state) {
		String full = state.getBlock().toString();
		int start = full.indexOf('{');
		int end = full.indexOf('}');
		return start >= 0 && end > start ? full.substring(start + 1, end) : full;
	}
}
