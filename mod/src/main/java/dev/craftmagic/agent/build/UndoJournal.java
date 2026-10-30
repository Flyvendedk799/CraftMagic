package dev.craftmagic.agent.build;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * What a build replaced, in the order it replaced it, so it can be put back.
 *
 * <p>Undo used to remember only <em>where</em> it had placed blocks and set every one of those
 * positions to air. That is right only for a build that went up in empty sky: anything built
 * into a hillside, onto a floor or over a path took the hillside, the floor and the path with
 * it when it was undone. So each entry keeps the state that was there before, the block-entity
 * data that went with it (a sign's text, a banner's pattern), and the state this build put down.
 *
 * <p>Two rules make rollback safe, and both live here so they can be checked without a running
 * game ({@code gradlew verifyUndo}):
 *
 * <ul>
 *   <li><b>Newest first.</b> If a position is ever written twice, rolling back in reverse puts
 *       the oldest "before" back last, which is the one that was really there.
 *   <li><b>Only what is still ours.</b> A block the player has changed since the build placed
 *       it is theirs now, and undo leaves it alone rather than reverting their work — see
 *       {@link #stillOurs}.
 * </ul>
 *
 * <p>Generic over position, state and data so the ordering logic has no Minecraft dependency.
 *
 * @param <P> a position
 * @param <S> a block state
 * @param <D> block-entity data for the previous state, or null when it had none
 */
public final class UndoJournal<P, S, D> {
	/** One replaced block. {@code previousData} is null when the old block had no block entity. */
	public record Entry<P, S, D>(P pos, S previous, D previousData, S placed) {}

	private final List<Entry<P, S, D>> entries = new ArrayList<>();
	private boolean rollingBack;
	/** Index of the next entry to roll back; meaningful only while rolling back. */
	private int cursor;

	public void record(P pos, S previous, D previousData, S placed) {
		// A build that is being rolled back does not place anything, so a record here would be
		// a bug in the caller — and appending behind the cursor would silently never be undone.
		if (rollingBack) throw new IllegalStateException("cannot record while rolling back");
		entries.add(new Entry<>(pos, previous, previousData, placed));
	}

	public int size() {
		return entries.size();
	}

	/**
	 * Start rolling back, or carry on from where an interrupted rollback stopped.
	 *
	 * <p>Idempotent on purpose: a cancelled rollback that is asked again resumes rather than
	 * walking back over the entries it already restored.
	 */
	public void beginRollback() {
		if (rollingBack) return;
		rollingBack = true;
		cursor = entries.size() - 1;
	}

	public boolean isRollingBack() {
		return rollingBack;
	}

	public boolean isRolledBack() {
		return rollingBack && cursor < 0;
	}

	/** How many entries have been rolled back so far. */
	public int rolledBack() {
		return rollingBack ? entries.size() - 1 - cursor : 0;
	}

	/** Up to {@code budget} entries still to roll back, newest first. Advances the cursor. */
	public List<Entry<P, S, D>> nextBatch(int budget) {
		if (!rollingBack || cursor < 0 || budget <= 0) return Collections.emptyList();
		List<Entry<P, S, D>> batch = new ArrayList<>(Math.min(budget, cursor + 1));
		while (batch.size() < budget && cursor >= 0) {
			batch.add(entries.get(cursor--));
		}
		return batch;
	}

	/** The most recent entry's position, or null for an empty journal. */
	public P lastPosition() {
		return entries.isEmpty() ? null : entries.get(entries.size() - 1).pos();
	}

	/**
	 * Whether a position still holds what this build put there.
	 *
	 * <p>If not, the player (or the world — a sapling grew, water flowed in) has changed it since,
	 * and restoring the old block would destroy that change.
	 */
	public static <S> boolean stillOurs(S current, S placed) {
		return Objects.equals(current, placed);
	}
}
