package dev.craftmagic.agent.command;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import dev.craftmagic.agent.CraftMagicMod;
import dev.craftmagic.agent.config.ModConfig;
import dev.craftmagic.agent.net.AgentSocket;
import dev.craftmagic.agent.wand.WandItem;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.arguments.coordinates.BlockPosArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Rotation;
import dev.craftmagic.agent.job.JobManager;

/**
 * {@code /craftmagic} — the player's side of pairing a world to the website.
 *
 * <p>Pairing is deliberately player-initiated and code-based: the site never reaches into a
 * world, the world dials out. A paired agent can place blocks anywhere in the world, so on a
 * dedicated server that is gated behind OP level 2.
 *
 * <p>See {@link #mayConfigure} for why "singleplayer is exempt" cannot be spelled as a
 * permission level.
 */
public final class CraftMagicCommand {
	/** 0-3 quarter turns, so the player can type a number rather than a compass direction. */
	private static final Rotation[] ROTATIONS = {
			Rotation.NONE, Rotation.CLOCKWISE_90, Rotation.CLOCKWISE_180, Rotation.COUNTERCLOCKWISE_90
	};

	private CraftMagicCommand() {
	}

	/**
	 * Who may pair this world and change its settings.
	 *
	 * <p>This used to be {@code hasPermission(LEVEL_GAMEMASTERS)} alone, on the assumption that
	 * a singleplayer player is already an operator. They are not: <b>without "Allow Cheats" a
	 * singleplayer player has permission level 0</b>, so Brigadier removed {@code pair} from the
	 * tree entirely and typing it produced "Incorrect argument for command" pointing at the word
	 * itself — a message that gives no hint the cause is permissions. That is the ordinary way
	 * to play singleplayer, so the headline feature was unreachable for most people.
	 *
	 * <p>Ownership, not permission level, is the real question. The host of an integrated server
	 * owns the world whether or not cheats are on. A LAN guest does not, and still needs OP —
	 * they can be granted it with {@code /op}. On a dedicated server nobody is the owner, so it
	 * always falls through to the OP check.
	 */
	public static boolean mayConfigure(CommandSourceStack source) {
		boolean operator = Commands.hasPermission(Commands.LEVEL_GAMEMASTERS).test(source);

		// NOT source.getServer(). Minecraft builds the command-tree packet it sends to a
		// joining client by evaluating every `requires` against a synthetic source whose
		// server is null (Commands$1.isRestricted, via PlayerList.placeNewPlayer). Touching
		// it there threw, and because it threw *while placing the player*, the client was
		// kicked with "Invalid player data" — an error naming neither the mod nor the cause,
		// and one that looks exactly like a corrupted save.
		//
		// The mod's own reference is captured at SERVER_STARTED and is null only outside a
		// world, where nothing can be configured anyway.
		MinecraftServer server = CraftMagicMod.server();
		if (server == null) return operator;

		ServerPlayer player = source.getPlayer();
		return mayConfigure(
				server.isDedicatedServer(),
				player != null,
				player != null && server.isSingleplayerOwner(player.nameAndId()),
				operator);
	}

	/**
	 * The policy itself, as a pure function of four facts.
	 *
	 * <p>Split out from the {@code CommandSourceStack} lookup above so it can be checked without
	 * a running Minecraft server — see {@code gradlew verifyPermissions}. What was wrong here was
	 * the *policy*, not the API calls, and a policy that only a human can evaluate is one that
	 * gets a case wrong quietly.
	 *
	 * @param dedicatedServer   a real multiplayer server, where nobody owns the world
	 * @param hasPlayer         false for the console or a command block
	 * @param singleplayerOwner this player opened this world; false for a LAN guest
	 * @param operator          passes the vanilla OP level 2 check
	 */
	public static boolean mayConfigure(
			boolean dedicatedServer, boolean hasPlayer, boolean singleplayerOwner, boolean operator) {
		if (!dedicatedServer) {
			// The host, cheats or not. On a LAN-published world this is still only the host:
			// guests are not the singleplayer owner and fall through to the OP check below.
			if (hasPlayer && singleplayerOwner) return true;

			// No player means the integrated server's own console or a command block, which
			// only exist on the host's machine.
			if (!hasPlayer) return true;
		}

		return operator;
	}

	public static void register() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registry, environment) -> {
			dispatcher.register(
					Commands.literal("craftmagic")
							.then(Commands.literal("status").executes(CraftMagicCommand::status))
							.then(
									Commands.literal("pair")
											.requires(CraftMagicCommand::mayConfigure)
											.then(
													Commands.argument("code", StringArgumentType.word())
															.executes(CraftMagicCommand::pair)))
							.then(
									Commands.literal("unpair")
											.requires(CraftMagicCommand::mayConfigure)
											.executes(CraftMagicCommand::unpair))
							.then(
									Commands.literal("server")
											.requires(CraftMagicCommand::mayConfigure)
											.then(
													Commands.argument("url", StringArgumentType.greedyString())
															.executes(CraftMagicCommand::setServer)))
							// The wand is the ordinary way to place a build now; `build` and
							// `place` remain for the console, command blocks, and anyone who
							// would rather type.
							.then(Commands.literal("wand").executes(CraftMagicCommand::wand))
							// Neither `wand` nor `build` needs elevated permission: a job only
							// exists because someone paired this world and sent it, and it lands
							// where the player chose. Rotation is optional — most people want it
							// facing the way they are.
							.then(
									Commands.literal("build")
											.executes(context -> build(context, Rotation.NONE))
											.then(
													Commands.argument("rotation", IntegerArgumentType.integer(0, 3))
															.executes(context ->
																	build(context, ROTATIONS[IntegerArgumentType.getInteger(context, "rotation")]))))
							// Explicit coordinates: works from the console, a command block, or a
							// vanilla client that cannot show the interactive preview.
							.then(
									Commands.literal("place")
											.then(
													Commands.argument("pos", BlockPosArgument.blockPos())
															.executes(context -> place(context, Rotation.NONE))
															.then(
																	Commands.argument("rotation", IntegerArgumentType.integer(0, 3))
																			.executes(context ->
																					place(context, ROTATIONS[IntegerArgumentType.getInteger(context, "rotation")])))))
							.then(Commands.literal("cancel").executes(CraftMagicCommand::cancel))
							.then(
									Commands.literal("speed")
											.requires(CraftMagicCommand::mayConfigure)
											.then(
													Commands.argument("blocksPerSecond", IntegerArgumentType.integer(0, 4000))
															.executes(CraftMagicCommand::setSpeed)))
							.executes(CraftMagicCommand::status));

			// A bare `/wand`, because reaching for the wand is the one thing a player does
			// before they have a build to place, and `/craftmagic wand` is six extra words at
			// exactly the wrong moment. WorldEdit's wand is `//wand`, so this does not collide
			// with the mod most likely to be installed alongside this one.
			dispatcher.register(Commands.literal("wand").executes(CraftMagicCommand::wand));
		});
	}

	/**
	 * Put a wand in the player's hand.
	 *
	 * <p>Requires a player for the obvious reason, and drops the wand at their feet rather than
	 * failing when the inventory is full — losing the command to a full hotbar would be a
	 * baffling way for this to not work.
	 */
	private static int wand(com.mojang.brigadier.context.CommandContext<CommandSourceStack> context) {
		ServerPlayer player = context.getSource().getPlayer();
		if (player == null) {
			context.getSource().sendFailure(Component.literal("Run this as a player — the wand goes in your hand."));
			return 0;
		}

		ItemStack wand = WandItem.create();
		if (!player.getInventory().add(wand)) {
			player.drop(wand, false);
		}

		context.getSource().sendSuccess(
				() -> Component.literal(
						"CraftMagic wand. Right-click to mark a spot, sneak + right-click to turn it, "
								+ "punch the air to build."),
				false);
		return 1;
	}

	private static int status(com.mojang.brigadier.context.CommandContext<CommandSourceStack> context) {
		ModConfig config = ModConfig.get();
		AgentSocket socket = CraftMagicMod.socket();

		String state;
		if (!config.isPaired()) {
			state = "not paired — run /craftmagic pair <code> with a code from the website";
		} else if (socket != null && socket.isConnected()) {
			state = "connected";
		} else {
			state = "paired, but not connected — retrying in the background";
		}

		context.getSource().sendSuccess(() -> Component.literal("CraftMagic: " + state), false);
		context.getSource().sendSuccess(() -> Component.literal("server: " + config.serverUrl), false);
		return 1;
	}

	private static int pair(com.mojang.brigadier.context.CommandContext<CommandSourceStack> context) {
		String code = StringArgumentType.getString(context, "code").trim().toUpperCase();
		CommandSourceStack source = context.getSource();

		source.sendSuccess(() -> Component.literal("Pairing with code " + code + "…"), false);

		// The claim is a network call, so it must not run on the server thread; the result is
		// reported back once it lands.
		CraftMagicMod.pairAsync(
				code,
				message -> source.sendSuccess(() -> Component.literal(message), false),
				error -> source.sendFailure(Component.literal("Pairing failed: " + error)));
		return 1;
	}

	private static int unpair(com.mojang.brigadier.context.CommandContext<CommandSourceStack> context) {
		ModConfig config = ModConfig.get();
		config.agentToken = null;
		config.save();
		CraftMagicMod.disconnect();
		context.getSource().sendSuccess(() -> Component.literal("CraftMagic: unpaired this world."), true);
		return 1;
	}

	/**
	 * Place the waiting build at the player's feet.
	 *
	 * Requires a player rather than any command source: the whole point is "here, where I am
	 * standing", which a command block or the console cannot express.
	 */
	private static int build(
			com.mojang.brigadier.context.CommandContext<CommandSourceStack> context, Rotation rotation) {
		JobManager jobs = CraftMagicMod.jobs();
		if (jobs == null) {
			context.getSource().sendFailure(Component.literal("CraftMagic is not running."));
			return 0;
		}

		ServerPlayer player = context.getSource().getPlayer();
		if (player == null) {
			context.getSource().sendFailure(Component.literal("Run this as a player — the build goes where you stand."));
			return 0;
		}

		String problem = jobs.startBuild(player, rotation);
		if (problem != null) {
			context.getSource().sendFailure(Component.literal("CraftMagic: " + problem));
			return 0;
		}
		return 1;
	}

	private static int place(
			com.mojang.brigadier.context.CommandContext<CommandSourceStack> context, Rotation rotation)
			throws com.mojang.brigadier.exceptions.CommandSyntaxException {
		JobManager jobs = CraftMagicMod.jobs();
		if (jobs == null) {
			context.getSource().sendFailure(Component.literal("CraftMagic is not running."));
			return 0;
		}

		BlockPos origin = BlockPosArgument.getLoadedBlockPos(context, "pos");
		String problem = jobs.startBuildAt(context.getSource().getLevel(), origin, rotation);
		if (problem != null) {
			context.getSource().sendFailure(Component.literal("CraftMagic: " + problem));
			return 0;
		}
		return 1;
	}

	private static int cancel(com.mojang.brigadier.context.CommandContext<CommandSourceStack> context) {
		JobManager jobs = CraftMagicMod.jobs();
		if (jobs != null && jobs.cancelActive()) {
			context.getSource().sendSuccess(() -> Component.literal("CraftMagic: build cancelled."), true);
			return 1;
		}
		context.getSource().sendFailure(Component.literal("CraftMagic: nothing is being built."));
		return 0;
	}

	private static int setSpeed(com.mojang.brigadier.context.CommandContext<CommandSourceStack> context) {
		int speed = IntegerArgumentType.getInteger(context, "blocksPerSecond");
		ModConfig config = ModConfig.get();
		config.buildSpeed = speed;
		config.save();
		context.getSource().sendSuccess(
				() -> Component.literal("CraftMagic build speed: "
						+ (speed == 0 ? "as fast as possible" : speed + " blocks/second")),
				true);
		return 1;
	}

	private static int setServer(com.mojang.brigadier.context.CommandContext<CommandSourceStack> context) {
		String url = StringArgumentType.getString(context, "url").trim();
		ModConfig config = ModConfig.get();
		config.serverUrl = url;
		config.save();
		context.getSource().sendSuccess(() -> Component.literal("CraftMagic server set to " + url), true);
		return 1;
	}
}
