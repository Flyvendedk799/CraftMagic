package dev.craftmagic.agent.build;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.particles.BlockParticleOption;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.world.Clearable;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.entity.BlockEntity;
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
	/** Not final: an undo after the build finished gets a fresh bot, the first one is gone. */
	private BuilderBot bot;
	private final int blocksPerTick;

	private final List<Placement> placements = new ArrayList<>();
	private final UndoJournal<BlockPos, BlockState, CompoundTag> journal = new UndoJournal<>();
	private int cursor;
	private boolean cancelled;
	private boolean paused;

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
		if (journal.isRollingBack()) return journal.isRolledBack();
		return cursor >= placements.size();
	}

	/** Stop. Also stops a rollback, which {@link #startUndo} can later pick up where it left off. */
	public void cancel() {
		cancelled = true;
	}

	public boolean isCancelled() {
		return cancelled;
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

	/** Hand the task a bot to drive. Used when a finished build is undone with a new one. */
	public void attachBot(BuilderBot bot) {
		this.bot = bot;
	}

	/**
	 * Stop placing and put back what this build replaced, newest first.
	 *
	 * <p>Works on a build in progress (what is down so far comes back out) and on a finished or
	 * cancelled one. Clears {@code cancelled} and {@code paused}, because a stopped task asked to
	 * undo is being asked to run again.
	 */
	public void startUndo() {
		cancelled = false;
		paused = false;
		journal.beginRollback();
	}

	public boolean isUndoing() {
		return journal.isRollingBack();
	}

	/** Blocks put back so far by the undo. */
	public int undone() {
		return journal.rolledBack();
	}

	/** Blocks the undo has to put back in total. */
	public int undoTotal() {
		return journal.size();
	}

	/** Where the last block went down, or the origin if none did — where an undo bot should start. */
	public BlockPos lastChanged() {
		BlockPos last = journal.lastPosition();
		return last == null ? origin : last;
	}

	/** Place this tick's budget, or roll back in reverse if undoing. Returns how many blocks were changed. */
	public int tick() {
		if (isFinished() || paused) return 0;
		return journal.isRollingBack() ? rollBack() : place();
	}

	private int place() {
		int placedThisTick = 0;
		BlockPos last = null;

		while (placedThisTick < blocksPerTick && cursor < placements.size()) {
			Placement placement = placements.get(cursor++);
			BlockPos pos = placement.pos();

			// The world has a build height; a schematic anchored too high would otherwise
			// throw for every block above it.
			if (!level.isInWorldBounds(pos)) continue;

			// Read before the write: this is the only moment the old block still exists.
			BlockState previous = level.getBlockState(pos);
			BlockEntity previousEntity = level.getBlockEntity(pos);
			CompoundTag previousData =
					previousEntity == null ? null : previousEntity.saveWithFullMetadata(level.registryAccess());

			// Block-entity side effects stay on, as they always were: a chest the build lands
			// on spills its items rather than having them deleted. Undo puts the chest back
			// empty for exactly that reason (see restore) — restoring the contents as well would
			// hand the player a second copy of everything that fell out.
			if (level.setBlock(pos, placement.state(), Block.UPDATE_CLIENTS)) {
				journal.record(pos, previous, previousData, placement.state());
			}
			last = pos;
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

	private int rollBack() {
		int changed = 0;
		BlockPos last = null;

		for (UndoJournal.Entry<BlockPos, BlockState, CompoundTag> entry : journal.nextBatch(blocksPerTick)) {
			BlockPos pos = entry.pos();
			BlockState current = level.getBlockState(pos);
			// Changed since we placed it — broken, replaced, grown over. Theirs now.
			if (!UndoJournal.stillOurs(current, entry.placed())) continue;

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
			restore(pos, entry.previous(), entry.previousData(), entry.placed());
			last = pos;
			changed++;
		}

		if (last != null) {
			bot.moveTo(last);
			bot.swing();
			level.playSound(null, last, SoundEvents.ITEM_BREAK.value(), SoundSource.BLOCKS, 0.5f, 1.0f);
		}

		return changed;
	}

	/**
	 * Put a block back as it was before the build.
	 *
	 * <p>The block-entity data is loaded into a fresh block entity, so a sign gets its text back
	 * and a banner its pattern. Inventories are then emptied: their items dropped into the world
	 * when the build replaced them, and the player may well have picked them up since.
	 *
	 * <p>The one exception is a block the build only re-oriented (a chest turned to face another
	 * way). Minecraft keeps the same block entity through that, items and all, so the live one is
	 * the truth and the snapshot is skipped — loading it would roll its contents back in time.
	 */
	private void restore(BlockPos pos, BlockState previous, CompoundTag previousData, BlockState placed) {
		level.setBlock(pos, previous, Block.UPDATE_CLIENTS);
		if (previousData == null || previous.is(placed.getBlock())) return;

		BlockEntity restored = BlockEntity.loadStatic(pos, previous, previousData, level.registryAccess());
		if (restored == null) return;
		if (restored instanceof Clearable inventory) inventory.clearContent();
		level.setBlockEntity(restored);
		restored.setChanged();
		level.sendBlockUpdated(pos, previous, previous, Block.UPDATE_CLIENTS);
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
