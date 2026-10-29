package dev.craftmagic.agent.build;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.particles.BlockParticleOption;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockState;

import java.util.ArrayList;
import java.util.List;

/**
 * Places a schematic into the world, a few blocks per tick.
 *
 * <p>Three decisions shape this class:
 *
 * <ul>
 *   <li><b>Bottom-up, layer by layer.</b> Not merely for looks: placing a block before its
 *       support exists makes sand and gravel fall, and a viewer sees the structure rise the
 *       way they would build it themselves.
 *   <li><b>Neighbour physics are suppressed</b> ({@code Block.UPDATE_CLIENTS} only). Without
 *       that, every placement triggers block updates — gravity blocks collapse mid-build,
 *       redstone fires, and water spreads before its container is finished.
 *   <li><b>A per-tick budget, never a bulk write.</b> A 200k-block build placed in one tick
 *       freezes the server for seconds and disconnects players. Even "instant" is spread
 *       across ticks.
 * </ul>
 */
public final class BuildTask {
	/** Even the fastest setting stays under this, so a single tick cannot stall the server. */
	private static final int MAX_BLOCKS_PER_TICK = 400;

	private final ServerLevel level;
	private final Schematic schematic;
	private final BlockPos origin;
	private final Rotation rotation;
	private final BuilderBot bot;
	private final int blocksPerTick;

	private final List<Placement> placements = new ArrayList<>();
	private final List<BlockPos> placedHistory = new ArrayList<>();
	private int cursor;
	private boolean cancelled;
	private boolean paused;
	private boolean undoing;
	private int undoCursor;

	private record Placement(BlockPos pos, BlockState state) {}

	public BuildTask(
			ServerLevel level,
			Schematic schematic,
			BlockPos origin,
			Rotation rotation,
			BuilderBot bot,
			int blocksPerSecond) {
		this.level = level;
		this.schematic = schematic;
		this.origin = origin;
		this.rotation = rotation;
		this.bot = bot;
		// 0 means "as fast as allowed" rather than "never place anything".
		this.blocksPerTick =
				blocksPerSecond <= 0 ? MAX_BLOCKS_PER_TICK : Math.max(1, Math.min(MAX_BLOCKS_PER_TICK, blocksPerSecond / 20));

		plan();
	}

	/**
	 * Resolve every placement up front.
	 *
	 * Doing the rotation and coordinate maths once, rather than per tick, keeps the tick loop
	 * to a bounds check and a `setBlock`. The list costs about 24 bytes per block, which is
	 * far cheaper than the schematic it came from.
	 */
	private void plan() {
		schematic.forEachSolid((x, y, z, state) -> {
			// Rotation is applied to the offset and to the block's own state, so a rotated
			// staircase still faces along the stairs.
			int rx = x;
			int rz = z;
			switch (rotation) {
				case CLOCKWISE_90 -> {
					rx = schematic.length() - 1 - z;
					rz = x;
				}
				case CLOCKWISE_180 -> {
					rx = schematic.width() - 1 - x;
					rz = schematic.length() - 1 - z;
				}
				case COUNTERCLOCKWISE_90 -> {
					rx = z;
					rz = schematic.width() - 1 - x;
				}
				default -> {
					// NONE
				}
			}

			placements.add(
					new Placement(origin.offset(rx, y, rz), state.rotate(rotation)));
		});
	}

	public int total() {
		return placements.size();
	}

	public int placed() {
		return cursor;
	}

	public boolean isFinished() {
		if (cancelled) return true;
		if (undoing) return undoCursor < 0;
		return cursor >= placements.size();
	}

	public void cancel() {
		cancelled = true;
	}

	public void pause() {
		paused = true;
	}

	public void resume() {
		paused = false;
	}

	public boolean isPaused() {
		return paused;
	}

	public void startUndo() {
		undoing = true;
		paused = false;
		undoCursor = placedHistory.size() - 1;
	}

	public boolean isUndoing() {
		return undoing;
	}

	public List<BlockPos> placedHistory() {
		return placedHistory;
	}

	/** Place this tick's budget, or dismantle in reverse if undoing. Returns how many blocks were changed. */
	public int tick() {
		if (isFinished() || paused) return 0;

		if (undoing) {
			int undoneThisTick = 0;
			BlockPos last = null;
			while (undoneThisTick < blocksPerTick && undoCursor >= 0) {
				BlockPos pos = placedHistory.get(undoCursor--);
				if (level.isInWorldBounds(pos)) {
					BlockState current = level.getBlockState(pos);
					if (!current.isAir()) {
						level.sendParticles(
								new BlockParticleOption(ParticleTypes.BLOCK, current),
								pos.getX() + 0.5,
								pos.getY() + 0.5,
								pos.getZ() + 0.5,
								4,
								0.2,
								0.2,
								0.2,
								0.05);
					}
					level.setBlock(pos, Blocks.AIR.defaultBlockState(), Block.UPDATE_CLIENTS);
					last = pos;
					undoneThisTick++;
				}
			}

			if (last != null) {
				bot.moveTo(last);
				bot.swing();
				level.playSound(
						null,
						last,
						SoundEvents.ITEM_BREAK,
						SoundSource.BLOCKS,
						0.5f,
						1.0f);
			}

			return undoneThisTick;
		}

		int placedThisTick = 0;
		BlockPos last = null;

		while (placedThisTick < blocksPerTick && cursor < placements.size()) {
			Placement placement = placements.get(cursor++);

			// The world has a build height; a schematic anchored too high would otherwise
			// throw for every block above it.
			if (!level.isInWorldBounds(placement.pos())) continue;

			level.setBlock(placement.pos(), placement.state(), Block.UPDATE_CLIENTS);
			placedHistory.add(placement.pos());
			last = placement.pos();
			placedThisTick++;
		}

		if (last != null) {
			bot.moveTo(last);
			bot.swing();
			playPlacementSound(last);
			level.sendParticles(
					new BlockParticleOption(ParticleTypes.BLOCK, level.getBlockState(last)),
					last.getX() + 0.5,
					last.getY() + 0.5,
					last.getZ() + 0.5,
					5,
					0.2,
					0.2,
					0.2,
					0.05);
		}

		return placedThisTick;
	}

	/**
	 * One sound per tick, not per block.
	 *
	 * At 200 blocks a second, a sound per placement is an unlistenable buzz and floods the
	 * packet queue for every nearby player.
	 */
	private void playPlacementSound(BlockPos pos) {
		BlockState state = level.getBlockState(pos);
		SoundType sound = state.getSoundType();
		level.playSound(
				null,
				pos,
				sound.getPlaceSound(),
				SoundSource.BLOCKS,
				(sound.getVolume() + 1.0f) / 4.0f,
				sound.getPitch() * 0.8f);
	}

	/** Where the finished build sits, for the completion message. */
	public BlockPos origin() {
		return origin;
	}

	public Direction facing() {
		return rotation.rotate(Direction.NORTH);
	}
}
