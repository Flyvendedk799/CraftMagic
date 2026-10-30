package dev.craftmagic.agent.build;

import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.decoration.ArmorStand;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.phys.Vec3;

/**
 * The visible builder.
 *
 * An armor stand rather than a custom entity, deliberately: it renders correctly on a
 * <em>vanilla</em> client, so other players on a dedicated server can watch the build happen
 * without installing anything. A custom entity would be invisible to them, or worse, show as
 * a missing-entity error.
 *
 * <p>It has no gravity and moves by teleporting — a hovering construction drone, not a
 * pathfinding creature. Anything that walks would get stuck on the structure it is building.
 */
public final class BuilderBot {
	/** How far above the block being placed the bot floats. */
	private static final double HOVER = 1.6;
	/** Fraction of the remaining distance covered per tick — a soft follow rather than a snap. */
	private static final double EASING = 0.28;

	private final ArmorStand entity;
	private Vec3 target;

	private BuilderBot(ArmorStand entity, Vec3 target) {
		this.entity = entity;
		this.target = target;
	}

	public static BuilderBot spawn(ServerLevel level, BlockPos near, String buildName) {
		Vec3 start = new Vec3(near.getX() + 0.5, near.getY() + HOVER, near.getZ() + 0.5);

		ArmorStand stand = new ArmorStand(level, start.x, start.y, start.z);
		// The stand used to be invisible, so the only thing a player saw was its floating name
		// tag. It is visible now because it is dressed for the job — arms, a gold helmet, a
		// glinting pickaxe it swings at every block — and all of that is vanilla equipment on a
		// vanilla entity, so a client without the mod draws it like any other armour stand.
		//
		// setMarker and setSmall are both private in 26.2, so the bot keeps a full-size stand's
		// hitbox. Invulnerable plus silent covers the cases that matter — it cannot be destroyed
		// and does not clutter the soundscape while the build runs.
		stand.setInvisible(false);
		stand.setShowArms(true);
		stand.setNoBasePlate(true);
		stand.setNoGravity(true);
		stand.setInvulnerable(true);
		stand.setSilent(true);

		ItemStack pickaxe = new ItemStack(Items.GOLDEN_PICKAXE);
		pickaxe.set(DataComponents.ENCHANTMENT_GLINT_OVERRIDE, true);
		stand.setItemSlot(EquipmentSlot.MAINHAND, pickaxe);

		ItemStack helmet = new ItemStack(Items.GOLDEN_HELMET);
		stand.setItemSlot(EquipmentSlot.HEAD, helmet);

		stand.setCustomName(Component.literal("⚒ " + buildName));
		stand.setCustomNameVisible(true);
		level.addFreshEntity(stand);

		return new BuilderBot(stand, start);
	}

	/** Trigger arm swing animation during block placement ticks. */
	public void swing() {
		if (!entity.isRemoved()) {
			entity.swing(InteractionHand.MAIN_HAND);
		}
	}

	/**
	 * Completion fanfare: celebratory sounds, a burst of firework and totem particles, and a
	 * salute. The caller keeps the bot alive for a moment afterwards ({@link #tickCelebration})
	 * — despawning it in the same tick would remove it before any client had drawn the burst.
	 */
	public void celebrate(ServerLevel level) {
		if (entity.isRemoved()) return;

		BlockPos pos = entity.blockPosition();
		double x = entity.getX();
		double y = entity.getY();
		double z = entity.getZ();

		// Celebratory audio fanfare
		level.playSound(null, pos, SoundEvents.UI_TOAST_CHALLENGE_COMPLETE, SoundSource.PLAYERS, 1.0f, 1.0f);
		level.playSound(null, pos, SoundEvents.PLAYER_LEVELUP, SoundSource.PLAYERS, 0.8f, 1.2f);

		// Fireworks and totem particles burst
		level.sendParticles(ParticleTypes.FIREWORK, x, y + 0.8, z, 30, 0.4, 0.4, 0.4, 0.1);
		level.sendParticles(ParticleTypes.TOTEM_OF_UNDYING, x, y + 0.5, z, 35, 0.3, 0.3, 0.3, 0.1);

		// Bot spin and salute
		entity.setYRot(entity.getYRot() + 180f);
		entity.setYHeadRot(entity.getYHeadRot() + 180f);
		entity.swing(InteractionHand.MAIN_HAND);
	}

	/** One tick of the victory spin, while the bot waits to be despawned. */
	public void tickCelebration() {
		if (entity.isRemoved()) return;
		float yaw = entity.getYRot() + 18f;
		entity.setYRot(yaw);
		entity.setYHeadRot(yaw);
	}

	/** Point the bot at the block it is about to place. */
	public void moveTo(BlockPos block) {
		this.target = new Vec3(block.getX() + 0.5, block.getY() + HOVER, block.getZ() + 0.5);
	}

	/**
	 * Ease toward the target.
	 *
	 * Called every tick regardless of whether a block was placed this tick, so the bot keeps
	 * gliding at high build speeds instead of teleporting between distant blocks.
	 */
	public void tick() {
		if (entity.isRemoved()) return;

		Vec3 current = entity.position();
		Vec3 next = current.add(target.subtract(current).scale(EASING));
		entity.teleportTo(next.x, next.y, next.z);

		// Face the direction of travel so it reads as deliberate movement.
		Vec3 delta = target.subtract(current);
		if (delta.horizontalDistanceSqr() > 0.01) {
			float yaw = (float) (Math.atan2(delta.z, delta.x) * (180 / Math.PI)) - 90f;
			entity.setYRot(yaw);
			entity.setYHeadRot(yaw);
		}
	}

	public void setName(String text) {
		if (!entity.isRemoved()) entity.setCustomName(Component.literal(text));
	}

	public void despawn() {
		if (!entity.isRemoved()) entity.discard();
	}

	public BlockPos blockPosition() {
		return entity.blockPosition();
	}
}
