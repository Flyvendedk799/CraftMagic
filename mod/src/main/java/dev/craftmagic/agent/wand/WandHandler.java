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
import net.minecraft.server.MinecraftServer;
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

	private static final Map<UUID, Anchor> ANCHORS = new ConcurrentHashMap<>();
	private static final Map<UUID, Long> LAST_PUNCH = new ConcurrentHashMap<>();

	/** A marked spot. The dimension is part of it — a nether portal must not aim an overworld build. */
	private record Anchor(ResourceKey<Level> dimension, BlockPos pos, Rotation rotation, int yOffset) {}

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

	// --- right-click: mark, turn, or y-offset -----------------------------

	private static void mark(ServerPlayer player, BlockPos pos) {
		Anchor previous = ANCHORS.get(player.getUUID());

		// Sneaking controls rotation or vertical Y-offset based on camera pitch
		if (player.isShiftKeyDown() && previous != null && previous.dimension().equals(player.level().dimension())) {
			float pitch = player.getXRot();
			if (pitch > 35.0f) {
				int newOffset = Math.min(64, previous.yOffset() + 1);
				Anchor updated = new Anchor(previous.dimension(), previous.pos(), previous.rotation(), newOffset);
				ANCHORS.put(player.getUUID(), updated);
				player.level().playSound(
						null, updated.pos().above(updated.yOffset()), SoundEvents.AMETHYST_BLOCK_CHIME, SoundSource.PLAYERS, 0.6f, 1.4f);
				describe(player, updated, "Height +1 (offset " + (newOffset >= 0 ? "+" : "") + newOffset + ")");
				return;
			} else if (pitch < -35.0f) {
				int newOffset = Math.max(-64, previous.yOffset() - 1);
				Anchor updated = new Anchor(previous.dimension(), previous.pos(), previous.rotation(), newOffset);
				ANCHORS.put(player.getUUID(), updated);
				player.level().playSound(
						null, updated.pos().above(updated.yOffset()), SoundEvents.AMETHYST_BLOCK_CHIME, SoundSource.PLAYERS, 0.6f, 1.4f);
				describe(player, updated, "Height -1 (offset " + (newOffset >= 0 ? "+" : "") + newOffset + ")");
				return;
			} else {
				Anchor turned = new Anchor(previous.dimension(), previous.pos(), quarterTurn(previous.rotation()), previous.yOffset());
				ANCHORS.put(player.getUUID(), turned);
				player.level().playSound(
						null, turned.pos().above(turned.yOffset()), SoundEvents.AMETHYST_BLOCK_CHIME, SoundSource.PLAYERS, 0.6f, 1.4f);
				describe(player, turned, "Turned");
				return;
			}
		}

		int initialOffset = previous != null ? previous.yOffset() : 0;
		Anchor anchor = new Anchor(
				player.level().dimension(), pos, previous == null ? Rotation.NONE : previous.rotation(), initialOffset);
		ANCHORS.put(player.getUUID(), anchor);
		player.level().playSound(
				null, anchor.pos().above(anchor.yOffset()), SoundEvents.AMETHYST_BLOCK_CHIME, SoundSource.PLAYERS, 0.6f, 1.0f);
		describe(player, anchor, "Marked");
	}

	public static boolean setOffset(ServerPlayer player, int dy) {
		int clamped = Math.max(-64, Math.min(64, dy));
		Anchor previous = ANCHORS.get(player.getUUID());
		Anchor updated;
		if (previous == null || !previous.dimension().equals(player.level().dimension())) {
			updated = new Anchor(player.level().dimension(), player.blockPosition(), Rotation.NONE, clamped);
		} else {
			updated = new Anchor(previous.dimension(), previous.pos(), previous.rotation(), clamped);
		}
		ANCHORS.put(player.getUUID(), updated);
		player.level().playSound(
				null, updated.pos().above(updated.yOffset()), SoundEvents.AMETHYST_BLOCK_CHIME, SoundSource.PLAYERS, 0.6f, 1.4f);
		describe(player, updated, "Height offset " + (clamped >= 0 ? "+" : "") + clamped);
		return true;
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

		BlockPos pos = anchor.pos().above(anchor.yOffset());
		String at = pos.getX() + ", " + pos.getY() + ", " + pos.getZ()
				+ (anchor.yOffset() != 0 ? " (Y offset " + (anchor.yOffset() > 0 ? "+" : "") + anchor.yOffset() + ")" : "");

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
	 * Full 3D cuboid particle wireframe in 12 edges:
	 * 4 ground edges, 4 top rim edges, and 4 vertical corner pillars (NW/NE/SW/SE).
	 * Dynamic step calculation ensures total particles stay strictly under 180.
	 */
	private static void outline(ServerPlayer player, Anchor anchor, Schematic schematic) {
		ServerLevel level = player.level();
		Rotation rotation = anchor.rotation();
		BlockPos origin = Footprint.origin(schematic.width(), schematic.length(), rotation, anchor.pos().above(anchor.yOffset()));

		int width = Footprint.width(schematic.width(), schematic.length(), rotation);
		int length = Footprint.length(schematic.width(), schematic.length(), rotation);
		int height = schematic.height();

		int stepX = Math.max(1, width / 12);
		int stepZ = Math.max(1, length / 12);
		int stepY = Math.max(1, height / 12);

		int x0 = origin.getX();
		int y0 = origin.getY();
		int z0 = origin.getZ();
		int x1 = x0 + width;
		int y1 = y0 + height;
		int z1 = z0 + length;

		// 4 ground edges (y0) & 4 top rim edges (y1) along X
		for (int x = 0; x <= width; x += stepX) {
			spark(level, x0 + x, y0, z0);
			spark(level, x0 + x, y0, z1);
			spark(level, x0 + x, y1, z0);
			spark(level, x0 + x, y1, z1);
		}
		if (width % stepX != 0) {
			spark(level, x1, y0, z0);
			spark(level, x1, y0, z1);
			spark(level, x1, y1, z0);
			spark(level, x1, y1, z1);
		}

		// 4 ground edges (y0) & 4 top rim edges (y1) along Z
		for (int z = 0; z <= length; z += stepZ) {
			spark(level, x0, y0, z0 + z);
			spark(level, x1, y0, z0 + z);
			spark(level, x0, y1, z0 + z);
			spark(level, x1, y1, z0 + z);
		}
		if (length % stepZ != 0) {
			spark(level, x0, y0, z1);
			spark(level, x1, y0, z1);
			spark(level, x0, y1, z1);
			spark(level, x1, y1, z1);
		}

		// 4 vertical corner pillars: NW (x0, z0), NE (x1, z0), SW (x0, z1), SE (x1, z1)
		for (int y = 0; y <= height; y += stepY) {
			spark(level, x0, y0 + y, z0);
			spark(level, x1, y0 + y, z0);
			spark(level, x0, y0 + y, z1);
			spark(level, x1, y0 + y, z1);
		}
		if (height % stepY != 0) {
			spark(level, x0, y1, z0);
			spark(level, x1, y1, z0);
			spark(level, x0, y1, z1);
			spark(level, x1, y1, z1);
		}
	}

	private static void spark(ServerLevel level, double x, double y, double z) {
		level.sendParticles(ParticleTypes.END_ROD, x, y + 0.15, z, 1, 0.0, 0.0, 0.0, 0.0);
	}

	/**
	 * Per-tick handler for players holding a wand:
	 * sends real-time Action Bar HUD and refreshes the 3D particle wireframe every 20 ticks.
	 */
	public static void tick(MinecraftServer server) {
		long tickCount = server.getTickCount();
		JobManager jobs = CraftMagicMod.jobs();
		Schematic pending = jobs == null ? null : jobs.pendingSchematic();

		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			boolean holding = holdingWand(player, InteractionHand.MAIN_HAND) || holdingWand(player, InteractionHand.OFF_HAND);
			if (!holding) continue;

			Anchor anchor = ANCHORS.get(player.getUUID());

			// Real-time Action Bar HUD
			if (pending == null) {
				player.sendSystemMessage(
						Component.literal("CraftMagic Wand: No build waiting (send one from website)")
								.withStyle(ChatFormatting.GRAY),
						true);
			} else {
				Rotation rotation = anchor != null ? anchor.rotation() : Rotation.NONE;
				int w = Footprint.width(pending.width(), pending.length(), rotation);
				int l = Footprint.length(pending.width(), pending.length(), rotation);
				int h = pending.height();
				String facing = facing(rotation);
				int yOff = anchor != null ? anchor.yOffset() : 0;
				String yStr = (yOff >= 0 ? "+" : "") + yOff;

				Component hud = Component.literal("\"" + jobs.pendingName() + "\" ")
						.withStyle(ChatFormatting.LIGHT_PURPLE)
						.append(Component.literal(w + "×" + h + "×" + l + " ").withStyle(ChatFormatting.AQUA))
						.append(Component.literal("| Facing: " + facing + " ").withStyle(ChatFormatting.YELLOW))
						.append(Component.literal("| Y: " + yStr + " ").withStyle(ChatFormatting.GREEN))
						.append(Component.literal("| Sneak+R-Click: Pitch±Y/Turn | Punch: Build").withStyle(ChatFormatting.GRAY));

				player.sendSystemMessage(hud, true);
			}

			// Wireframe periodic refresh every 20 ticks
			if (tickCount % 20 == 0 && anchor != null && pending != null) {
				if (anchor.dimension().equals(player.level().dimension())) {
					outline(player, anchor, pending);
				}
			}
		}
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
				Footprint.origin(schematic.width(), schematic.length(), anchor.rotation(), anchor.pos().above(anchor.yOffset()));
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
				null, anchor.pos().above(anchor.yOffset()), SoundEvents.BEACON_ACTIVATE, SoundSource.PLAYERS, 0.7f, 1.4f);
	}

	private static void refuse(ServerPlayer player, String reason) {
		player.sendSystemMessage(Component.literal("CraftMagic: " + reason).withStyle(ChatFormatting.RED));
	}
}
