package dev.imaginecraft.agent.command;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import dev.imaginecraft.agent.ImagineCraftMod;
import dev.imaginecraft.agent.config.ModConfig;
import dev.imaginecraft.agent.net.AgentSocket;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.arguments.coordinates.BlockPosArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.Rotation;
import dev.imaginecraft.agent.job.JobManager;

/**
 * {@code /imaginecraft} — the player's side of pairing a world to the website.
 *
 * <p>Pairing is deliberately player-initiated and code-based: the site never reaches into a
 * world, the world dials out. Requiring OP level 2 on a dedicated server matters because a
 * paired agent can place blocks anywhere in it — this is the permission gate for that.
 * Singleplayer is exempt, where the player is already the operator.
 */
public final class ImagineCraftCommand {
	/** 0-3 quarter turns, so the player can type a number rather than a compass direction. */
	private static final Rotation[] ROTATIONS = {
			Rotation.NONE, Rotation.CLOCKWISE_90, Rotation.CLOCKWISE_180, Rotation.COUNTERCLOCKWISE_90
	};

	private ImagineCraftCommand() {
	}

	public static void register() {
		CommandRegistrationCallback.EVENT.register((dispatcher, registry, environment) -> {
			dispatcher.register(
					Commands.literal("imaginecraft")
							.then(Commands.literal("status").executes(ImagineCraftCommand::status))
							.then(
									Commands.literal("pair")
											.requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
											.then(
													Commands.argument("code", StringArgumentType.word())
															.executes(ImagineCraftCommand::pair)))
							.then(
									Commands.literal("unpair")
											.requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
											.executes(ImagineCraftCommand::unpair))
							.then(
									Commands.literal("server")
											.requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
											.then(
													Commands.argument("url", StringArgumentType.greedyString())
															.executes(ImagineCraftCommand::setServer)))
							// `build` needs no elevated permission: a job only exists because
							// someone paired this world and sent it, and it lands where the
							// player is standing. Rotation is optional — most people want it
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
							.then(Commands.literal("cancel").executes(ImagineCraftCommand::cancel))
							.then(
									Commands.literal("speed")
											.requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
											.then(
													Commands.argument("blocksPerSecond", IntegerArgumentType.integer(0, 4000))
															.executes(ImagineCraftCommand::setSpeed)))
							.executes(ImagineCraftCommand::status));
		});
	}

	private static int status(com.mojang.brigadier.context.CommandContext<CommandSourceStack> context) {
		ModConfig config = ModConfig.get();
		AgentSocket socket = ImagineCraftMod.socket();

		String state;
		if (!config.isPaired()) {
			state = "not paired — run /imaginecraft pair <code> with a code from the website";
		} else if (socket != null && socket.isConnected()) {
			state = "connected";
		} else {
			state = "paired, but not connected — retrying in the background";
		}

		context.getSource().sendSuccess(() -> Component.literal("ImagineCraft: " + state), false);
		context.getSource().sendSuccess(() -> Component.literal("server: " + config.serverUrl), false);
		return 1;
	}

	private static int pair(com.mojang.brigadier.context.CommandContext<CommandSourceStack> context) {
		String code = StringArgumentType.getString(context, "code").trim().toUpperCase();
		CommandSourceStack source = context.getSource();

		source.sendSuccess(() -> Component.literal("Pairing with code " + code + "…"), false);

		// The claim is a network call, so it must not run on the server thread; the result is
		// reported back once it lands.
		ImagineCraftMod.pairAsync(
				code,
				message -> source.sendSuccess(() -> Component.literal(message), false),
				error -> source.sendFailure(Component.literal("Pairing failed: " + error)));
		return 1;
	}

	private static int unpair(com.mojang.brigadier.context.CommandContext<CommandSourceStack> context) {
		ModConfig config = ModConfig.get();
		config.agentToken = null;
		config.save();
		ImagineCraftMod.disconnect();
		context.getSource().sendSuccess(() -> Component.literal("ImagineCraft: unpaired this world."), true);
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
		JobManager jobs = ImagineCraftMod.jobs();
		if (jobs == null) {
			context.getSource().sendFailure(Component.literal("ImagineCraft is not running."));
			return 0;
		}

		ServerPlayer player = context.getSource().getPlayer();
		if (player == null) {
			context.getSource().sendFailure(Component.literal("Run this as a player — the build goes where you stand."));
			return 0;
		}

		String problem = jobs.startBuild(player, rotation);
		if (problem != null) {
			context.getSource().sendFailure(Component.literal("ImagineCraft: " + problem));
			return 0;
		}
		return 1;
	}

	private static int place(
			com.mojang.brigadier.context.CommandContext<CommandSourceStack> context, Rotation rotation)
			throws com.mojang.brigadier.exceptions.CommandSyntaxException {
		JobManager jobs = ImagineCraftMod.jobs();
		if (jobs == null) {
			context.getSource().sendFailure(Component.literal("ImagineCraft is not running."));
			return 0;
		}

		BlockPos origin = BlockPosArgument.getLoadedBlockPos(context, "pos");
		String problem = jobs.startBuildAt(context.getSource().getLevel(), origin, rotation);
		if (problem != null) {
			context.getSource().sendFailure(Component.literal("ImagineCraft: " + problem));
			return 0;
		}
		return 1;
	}

	private static int cancel(com.mojang.brigadier.context.CommandContext<CommandSourceStack> context) {
		JobManager jobs = ImagineCraftMod.jobs();
		if (jobs != null && jobs.cancelActive()) {
			context.getSource().sendSuccess(() -> Component.literal("ImagineCraft: build cancelled."), true);
			return 1;
		}
		context.getSource().sendFailure(Component.literal("ImagineCraft: nothing is being built."));
		return 0;
	}

	private static int setSpeed(com.mojang.brigadier.context.CommandContext<CommandSourceStack> context) {
		int speed = IntegerArgumentType.getInteger(context, "blocksPerSecond");
		ModConfig config = ModConfig.get();
		config.buildSpeed = speed;
		config.save();
		context.getSource().sendSuccess(
				() -> Component.literal("ImagineCraft build speed: "
						+ (speed == 0 ? "as fast as possible" : speed + " blocks/second")),
				true);
		return 1;
	}

	private static int setServer(com.mojang.brigadier.context.CommandContext<CommandSourceStack> context) {
		String url = StringArgumentType.getString(context, "url").trim();
		ModConfig config = ModConfig.get();
		config.serverUrl = url;
		config.save();
		context.getSource().sendSuccess(() -> Component.literal("ImagineCraft server set to " + url), true);
		return 1;
	}
}
