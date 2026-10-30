package dev.craftmagic.agent.tools;

import dev.craftmagic.agent.build.UndoJournal;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Check that undo puts the world back the way it was, without a running game.
 *
 * <p>Undo first shipped recording only positions and setting each one to air on the way back,
 * so a build placed into a hillside took the hillside with it. {@link UndoJournal} now records
 * what each block replaced; this drives it against a toy world (positions are strings, states
 * are strings) through the same newest-first, budgeted, skip-what-the-player-changed loop that
 * {@code BuildTask} runs, and checks what comes out.
 *
 *   gradlew verifyUndo
 */
public final class UndoCheck {
	private UndoCheck() {
	}

	private static int failures;

	public static void main(String[] args) {
		restoresWhatWasThere();
		rollsBackNewestFirst();
		repeatedPositionEndsOnTheOriginal();
		respectsTheBudget();
		leavesPlayerChangesAlone();
		resumesAfterInterruption();
		emptyJournalIsImmediatelyDone();
		refusesToRecordDuringRollback();

		System.out.println();
		if (failures > 0) {
			System.out.println(failures + " undo case(s) wrong");
			System.exit(1);
		}
		System.out.println("undo journal verified");
	}

	/** A toy world: build then undo, exactly as BuildTask does it. */
	private static final class World {
		final Map<String, String> blocks = new HashMap<>();
		final UndoJournal<String, String, String> journal = new UndoJournal<>();
		final List<String> restoredOrder = new ArrayList<>();
		final Map<String, String> restoredData = new HashMap<>();

		String get(String pos) {
			return blocks.getOrDefault(pos, "air");
		}

		void place(String pos, String state) {
			String previous = get(pos);
			if (previous.equals(state)) return; // setBlock reports no change; nothing to record
			String data = previous.startsWith("sign") ? "text:" + previous : null;
			blocks.put(pos, state);
			journal.record(pos, previous, data, state);
		}

		/** One tick of rollback; returns how many blocks it put back. */
		int undoTick(int budget) {
			int changed = 0;
			for (UndoJournal.Entry<String, String, String> e : journal.nextBatch(budget)) {
				if (!UndoJournal.stillOurs(get(e.pos()), e.placed())) continue;
				blocks.put(e.pos(), e.previous());
				if (e.previousData() != null) restoredData.put(e.pos(), e.previousData());
				restoredOrder.add(e.pos());
				changed++;
			}
			return changed;
		}

		void undoAll(int budget) {
			journal.beginRollback();
			int guard = 0;
			while (!journal.isRolledBack() && guard++ < 10_000) undoTick(budget);
		}
	}

	private static void restoresWhatWasThere() {
		World w = new World();
		w.blocks.put("0,64,0", "grass");
		w.blocks.put("1,64,0", "dirt");
		w.blocks.put("2,64,0", "sign_oak");
		Map<String, String> before = new HashMap<>(w.blocks);

		w.place("0,64,0", "stone");
		w.place("1,64,0", "stone");
		w.place("2,64,0", "stone");
		w.place("0,65,0", "planks"); // was air
		w.undoAll(400);

		check("terrain comes back, not air", w.blocks.equals(withAir(before, "0,65,0")));
		check("block-entity data travels with the entry",
				Objects.equals(w.restoredData.get("2,64,0"), "text:sign_oak") && w.restoredData.size() == 1);
	}

	private static void rollsBackNewestFirst() {
		World w = new World();
		w.place("a", "1");
		w.place("b", "2");
		w.place("c", "3");
		w.undoAll(400);
		check("rollback is newest first", w.restoredOrder.equals(List.of("c", "b", "a")));
	}

	private static void repeatedPositionEndsOnTheOriginal() {
		World w = new World();
		w.blocks.put("p", "grass");
		w.place("p", "scaffold");
		w.place("p", "stone");
		w.undoAll(1);
		check("a twice-written position ends on what was there first", w.get("p").equals("grass"));
	}

	private static void respectsTheBudget() {
		World w = new World();
		for (int i = 0; i < 1000; i++) w.place("p" + i, "stone");
		w.journal.beginRollback();
		int first = w.undoTick(400);
		int second = w.undoTick(400);
		int third = w.undoTick(400);
		check("a tick never exceeds its budget", first == 400 && second == 400 && third == 200);
		check("rolledBack counts what was walked", w.journal.rolledBack() == 1000 && w.journal.isRolledBack());
	}

	private static void leavesPlayerChangesAlone() {
		World w = new World();
		w.blocks.put("x", "grass");
		w.blocks.put("y", "grass");
		w.place("x", "stone");
		w.place("y", "stone");
		w.blocks.put("x", "diamond_block"); // the player swapped one out afterwards
		w.undoAll(400);
		check("a block the player changed is left as they left it", w.get("x").equals("diamond_block"));
		check("the rest is still restored", w.get("y").equals("grass"));
	}

	private static void resumesAfterInterruption() {
		World w = new World();
		for (int i = 0; i < 10; i++) w.place("p" + i, "stone");
		w.journal.beginRollback();
		w.undoTick(4); // then cancelled
		w.journal.beginRollback(); // asked again
		w.undoTick(100);
		check("an interrupted rollback resumes rather than restarting",
				w.restoredOrder.size() == 10 && w.journal.isRolledBack());
	}

	private static void emptyJournalIsImmediatelyDone() {
		UndoJournal<String, String, String> j = new UndoJournal<>();
		check("an unstarted journal is not rolled back", !j.isRolledBack() && !j.isRollingBack());
		j.beginRollback();
		check("an empty rollback is finished at once", j.isRolledBack() && j.nextBatch(10).isEmpty());
		check("an empty journal has no last position", j.lastPosition() == null);
	}

	private static void refusesToRecordDuringRollback() {
		UndoJournal<String, String, String> j = new UndoJournal<>();
		j.record("a", "air", null, "stone");
		j.beginRollback();
		boolean threw = false;
		try {
			j.record("b", "air", null, "stone");
		} catch (IllegalStateException expected) {
			threw = true;
		}
		check("recording during rollback is refused", threw);
	}

	private static Map<String, String> withAir(Map<String, String> before, String pos) {
		Map<String, String> m = new HashMap<>(before);
		m.put(pos, "air");
		return m;
	}

	private static void check(String description, boolean ok) {
		if (!ok) failures++;
		System.out.printf("  %s  %s%n", ok ? "PASS" : "FAIL", description);
	}
}
