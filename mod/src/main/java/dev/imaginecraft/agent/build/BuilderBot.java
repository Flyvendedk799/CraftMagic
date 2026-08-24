package dev.imaginecraft.agent.build;

import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.decoration.ArmorStand;
import net.minecraft.world.phys.Vec3;

/**
 * The visible builder.
 *
 * An armor stand rather than a custom entity, deliberately: it renders correctly on a
 * <em>vanilla</em> client, so other players on a dedicated server can watch the build happen
 * without installing anything. A custom entity would be invisible to them, or worse, show as
 * a missing-entity error.
 *
 * <p>It is a marker with no gravity and no collision — a hovering construction drone, not a
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
		stand.setInvisible(true);
		stand.setNoGravity(true);
		stand.setInvulnerable(true);
		// setMarker is private in 26.2, so the bot keeps a hitbox. Invulnerable plus silent
		// covers the cases that matter — it cannot be destroyed and does not clutter the
		// soundscape while the build runs.
		stand.setNoBasePlate(true);
		stand.setSilent(true);
		stand.setCustomName(Component.literal("⚒ " + buildName));
		stand.setCustomNameVisible(true);
		level.addFreshEntity(stand);

		return new BuilderBot(stand, start);
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
