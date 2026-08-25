package dev.craftmagic.agent.wand;

import dev.craftmagic.agent.CraftMagicMod;
import dev.craftmagic.agent.build.Footprint;
import dev.craftmagic.agent.build.Schematic;
import dev.craftmagic.agent.job.JobManager;
import dev.craftmagic.agent.net.WandPunchPayload;
import net.fabricmc.fabric.api.event.player.AttackBlockCallback;
import net.fabricmc.fabric.api.event.player.AttackEntityCallback;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.fabricmc.fabric.api.event.player.UseItemCallback;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Rotation;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The wand's two gestures, on the server.
 *
 * <p>Right-click marks a spot; punching builds there. The split exists because placing a
 * structure is two decisions — <em>where</em> and <em>go</em> — and welding them into one
 * click means every mis-aim is a build you have to tear down. Marking is free and repeatable;
 * only the punch is irreversible.
 *
 * <p><b>The anchor lives here, not on the client.</b> The client never sends a position, only
 * "I punched" ({@link WandPunchPayload}), so a modified client cannot ask for a build at
 * coordinates it never marked and never previewed. That is the same rule the rest of the mod
 * follows: the client draws, the server decides.
 *
 * <p>Registration is global and once, at mod init, because Fabric's interaction events are —
 * so the state is static and cleared in {@link #clear()} when a world closes. Anything else
 * would keep a finished world's players alive across a singleplayer session.
 */
public final class WandHandler {
	/** Ignore repeats within this many ticks, so a held mouse button is one build, not forty. */
	private static final long PUNCH_COOLDOWN_TICKS = 10;

	/** At most this many particles per footprint edge, whatever the build's size. */
	private static final int OUTLINE_STEPS = 48;

	private static final Map<UUID, Anchor> ANCHORS = new ConcurrentHashMap<>();
	private static final Map<UUID, Long> LAST_PUNCH = new ConcurrentHashMap<>();

	/** A marked spot. The dimension is part of it — a nether portal must not aim an overworld build. */
	private record Anchor(ResourceKey<Level> dimension, BlockPos pos, Rotation rotation) {}

	private WandHandler() {
	}

	// --- wiring ----------------------------------------------------------

	public static void register() {
		// Common, not client-only: both sides must know the payload's shape, and the client
		// runs the main entrypoint too.
		PayloadTypeRegistry.serverboundPlay().register(WandPunchPayload.TYPE, WandPunchPayload.CODEC);

		ServerPlayNetworking.registerGlobalReceiver(
				WandPunchPayload.TYPE,
				// Hop to the server thread explicitly. Building touches the world, and a
				// network callback is the last place to assume which thread you are on.
				(payload, context) -> context.server().execute(() -> punch(context.player())));

		UseBlockCallback.EVENT.register((player, level, hand, hit) -> {
			if (!holdingWand(player, hand)) return InteractionResult.PASS;
			// SUCCESS on the client too, or the client runs the vanilla interaction locally and
			// opens the chest you were aiming at while the server quietly marks the spot.
			if (level.isClientSide()) return InteractionResult.SUCCESS;
			// The face you clicked, not the block itself: a build should sit on the ground, not
			// inside it.
			mark((ServerPlayer) player, hit.getBlockPos().relative(hit.getDirection()));
			return InteractionResult.SUCCESS;
		});

		UseItemCallback.EVENT.register((player, level, hand) -> {
			if (!holdingWand(player, hand)) return InteractionResult.PASS;
			if (level.isClientSide()) return InteractionResult.SUCCESS;
			// Right-clicking nothing — aimed at the sky, or out of reach. Fall back to the
			// player's own feet, which is what /craftmagic build has always meant.
			mark((ServerPlayer) player, player.blockPosition());
			return InteractionResult.SUCCESS;
		});

		// Punching a block or a mob. FAIL, always: the wand must never break anything or hurt
		// anyone, including in creative where a left-click destroys a block instantly.
		AttackBlockCallback.EVENT.register((player, level, hand, pos, direction) -> {
			if (!holdingWand(player, hand)) return InteractionResult.PASS;
			if (level.isClientSide()) return InteractionResult.FAIL;
			punch((ServerPlayer) player);
			return InteractionResult.FAIL;
		});

		AttackEntityCallback.EVENT.register((player, level, hand, entity, hit) -> {
			if (!holdingWand(player, hand)) return InteractionResult.PASS;
			if (level.isClientSide()) return InteractionResult.FAIL;
			punch((ServerPlayer) player);
			return InteractionResult.FAIL;
		});
	}

	/** Drop every marked spot. Called when the server stops; see the class note on static state. */
	public static void clear() {
		ANCHORS.clear();
		LAST_PUNCH.clear();
	}

	private static boolean holdingWand(Player player, InteractionHand hand) {
		return WandItem.isWand(player.getItemInHand(hand));
	}

	// --- right-click: mark, or turn ---------------------------------------

	private static void mark(ServerPlayer player, BlockPos pos) {
		Anchor previous = ANCHORS.get(player.getUUID());

		// Sneaking rotates instead of moving, so the whole gesture set stays on the mouse and
		// nobody has to go back to chat to type a rotation number.
		if (player.isShiftKeyDown() && previous != null && previous.dimension().equals(player.level().dimension())) {
			Anchor turned = new Anchor(previous.dimension(), previous.pos(), quarterTurn(previous.rotation()));
			ANCHORS.put(player.getUUID(), turned);
			player.level().playSound(
					null, turned.pos(), SoundEvents.AMETHYST_BLOCK_CHIME, SoundSource.PLAYERS, 0.6f, 1.4f);
			describe(player, turned, "Turned");
			return;
		}

		Anchor anchor = new Anchor(
				player.level().dimension(), pos, previous == null ? Rotation.NONE : previous.rotation());
		ANCHORS.put(player.getUUID(), anchor);
		player.level().playSound(
				null, anchor.pos(), SoundEvents.AMETHYST_BLOCK_CHIME, SoundSource.PLAYERS, 0.6f, 1.0f);
		describe(player, anchor, "Marked");
	}

	private static Rotation quarterTurn(Rotation rotation) {
		return switch (rotation) {
			case NONE -> Rotation.CLOCKWISE_90;
			case CLOCKWISE_90 -> Rotation.CLOCKWISE_180;
			case CLOCKWISE_180 -> Rotation.COUNTERCLOCKWISE_90;
			case COUNTERCLOCKWISE_90 -> Rotation.NONE;
		};
	}

	/** Say what was marked, and — if a build is waiting — draw where it would land. */
	private static void describe(ServerPlayer player, Anchor anchor, String verb) {
		JobManager jobs = CraftMagicMod.jobs();
		Schematic pending = jobs == null ? null : jobs.pendingSchematic();

		BlockPos pos = anchor.pos();
		String at = pos.getX() + ", " + pos.getY() + ", " + pos.getZ();

		if (pending == null) {
			player.sendSystemMessage(
					Component.literal(verb + " " + at + ". ")
							.withStyle(ChatFormatting.LIGHT_PURPLE)
							.append(Component.literal("Nothing to build yet — send one from the website.")
									.withStyle(ChatFormatting.GRAY)));
			return;
		}

		outline(player, anchor, pending);

		player.sendSystemMessage(
				Component.literal(verb + " " + at + " — ")
						.withStyle(ChatFormatting.LIGHT_PURPLE)
						.append(Component.literal("\"" + jobs.pendingName() + "\" "
										+ Footprint.width(pending.width(), pending.length(), anchor.rotation()) + "×"
										+ pending.height() + "×"
										+ Footprint.length(pending.width(), pending.length(), anchor.rotation())
										+ ", facing " + facing(anchor.rotation()) + ". ")
								.withStyle(ChatFormatting.GRAY))
						.append(Component.literal("Punch the air to build it.").withStyle(ChatFormatting.YELLOW)));
	}

	private static String facing(Rotation rotation) {
		return rotation.rotate(Direction.NORTH).getName();
	}

	/**
	 * Trace the footprint in particles.
	 *
	 * <p>Coordinates in chat are precise and unreadable; a rectangle on the ground is neither
	 * but answers the only question being asked — will it eat my house? Stepped rather than
	 * per-block, because a 200-block-wide build would otherwise flood every nearby client with
	 * particle packets.
	 */
	private static void outline(ServerPlayer player, Anchor anchor, Schematic schematic) {
		ServerLevel level = player.level();
		Rotation rotation = anchor.rotation();
		BlockPos origin = Footprint.origin(schematic.width(), schematic.length(), rotation, anchor.pos());

		int width = Footprint.width(schematic.width(), schematic.length(), rotation);
		int length = Footprint.length(schematic.width(), schematic.length(), rotation);

		int stepX = Math.max(1, width / OUTLINE_STEPS);
		int stepZ = Math.max(1, length / OUTLINE_STEPS);

		for (int x = 0; x <= width; x += stepX) {
			spark(level, origin.getX() + x, origin.getY(), origin.getZ());
			spark(level, origin.getX() + x, origin.getY(), origin.getZ() + length);
		}
		for (int z = 0; z <= length; z += stepZ) {
			spark(level, origin.getX(), origin.getY(), origin.getZ() + z);
			spark(level, origin.getX() + width, origin.getY(), origin.getZ() + z);
		}
	}

	private static void spark(ServerLevel level, double x, double y, double z) {
		level.sendParticles(ParticleTypes.END_ROD, x, y + 0.15, z, 1, 0.0, 0.0, 0.0, 0.0);
	}

	// --- punch: build it --------------------------------------------------

	/**
	 * Build at the marked spot.
	 *
	 * <p>Reached three ways — a punch at air (relayed by the modded client), at a block, or at
	 * a mob — so it must be idempotent-ish under repeats; hence the cooldown. Every refusal
	 * says what to do next, because the player is holding a stick and has no other feedback
	 * channel.
	 */
	public static void punch(ServerPlayer player) {
		if (player == null) return;

		long now = player.level().getGameTime();
		Long last = LAST_PUNCH.get(player.getUUID());
		if (last != null && now - last < PUNCH_COOLDOWN_TICKS) return;
		LAST_PUNCH.put(player.getUUID(), now);

		JobManager jobs = CraftMagicMod.jobs();
		if (jobs == null) {
			refuse(player, "CraftMagic is not running.");
			return;
		}

		Anchor anchor = ANCHORS.get(player.getUUID());
		if (anchor == null) {
			refuse(player, "Nothing marked yet — right-click where you want it first.");
			return;
		}
		if (!anchor.dimension().equals(player.level().dimension())) {
			ANCHORS.remove(player.getUUID());
			refuse(player, "Your marked spot is in another dimension — right-click a new one.");
			return;
		}
		if (jobs.isBuilding()) {
			refuse(player, "Already building — /craftmagic cancel to stop it.");
			return;
		}

		Schematic schematic = jobs.pendingSchematic();
		if (schematic == null) {
			refuse(player, "No build is waiting — send one from the website first.");
			return;
		}

		BlockPos origin =
				Footprint.origin(schematic.width(), schematic.length(), anchor.rotation(), anchor.pos());
		String problem = jobs.startBuildAt(player.level(), origin, anchor.rotation());
		if (problem != null) {
			refuse(player, problem);
			return;
		}

		// The mark is spent. Leaving it would make a second punch drop a second copy into the
		// same hole, which is never what the first punch meant.
		ANCHORS.remove(player.getUUID());
		// Block sounds, both of them, and deliberately: the SoundEvents constants for ambient,
		// music and note-block entries are Holder-typed and take a different playSound overload.
		player.level().playSound(
				null, anchor.pos(), SoundEvents.BEACON_ACTIVATE, SoundSource.PLAYERS, 0.7f, 1.4f);
	}

	private static void refuse(ServerPlayer player, String reason) {
		player.sendSystemMessage(Component.literal("CraftMagic: " + reason).withStyle(ChatFormatting.RED));
	}
}
