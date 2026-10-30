package dev.craftmagic.agent.hud;

import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The one way this mod writes to a player's action bar.
 *
 * <p>Two features want the action bar — build progress and the wand's readout — and both used
 * to write it on every tick, to every player, regardless of whether anything had changed. That
 * is twenty packets a second per player per feature, and because each overwrote the other the
 * bar flickered between them. So writes go through here: a player is sent a line only when it
 * differs from what they were last sent (and not more than every {@link #MIN_INTERVAL_TICKS}),
 * or when the last one is about to fade ({@link #REFRESH_TICKS}). Which feature gets the bar is
 * decided by the callers — build progress wins; the wand stays quiet for a player who is being
 * shown it.
 */
public final class ActionBar {
	/** Never more often than this, however fast the text changes (a counter at 400 blocks a tick). */
	static final long MIN_INTERVAL_TICKS = 10;
	/** The client fades an action-bar line after about three seconds; resend before that. */
	static final long REFRESH_TICKS = 40;

	private record Shown(String text, long tick) {}

	private static final Map<UUID, Shown> SHOWN = new ConcurrentHashMap<>();

	private ActionBar() {
	}

	/** Show {@code line} to one player if it is due. {@code now} is the server tick count. */
	public static void show(ServerPlayer player, Component line, long now) {
		String text = line.getString();
		Shown last = SHOWN.get(player.getUUID());
		if (last != null && !due(last.text(), last.tick(), text, now)) return;
		player.sendSystemMessage(line, true);
		SHOWN.put(player.getUUID(), new Shown(text, now));
	}

	/**
	 * Whether a line should be sent, as a pure function of what was sent last and when.
	 *
	 * <p>A tick count lower than the last one means a new server (a different singleplayer world
	 * in the same session), and the old record means nothing there.
	 */
	public static boolean due(String lastText, long lastTick, String text, long now) {
		if (lastText == null) return true;
		long since = now - lastTick;
		if (since < 0) return true;
		if (!lastText.equals(text)) return since >= MIN_INTERVAL_TICKS;
		return since >= REFRESH_TICKS;
	}

	/** Drop every record. Called when the server stops, for the same reason as the wand's state. */
	public static void clear() {
		SHOWN.clear();
	}
}
