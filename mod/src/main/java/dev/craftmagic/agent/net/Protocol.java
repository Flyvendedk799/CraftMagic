package dev.craftmagic.agent.net;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * Wire format for the agent control channel. Mirrors
 * {@code packages/core/src/protocol/agent.ts} — keep the two in step.
 *
 * <p>Messages are small and few, so they are built and read as {@link JsonObject} rather
 * than through reflective binding: no adapter registry to keep in sync, and an unknown
 * field from a newer server is simply ignored instead of throwing.
 *
 * <p>Bulk voxel data never travels over this channel. It is fetched over HTTPS as
 * {@code .schem} bytes — the same file the website exports and WorldEdit reads.
 */
public final class Protocol {
	public static final int VERSION = 1;

	private Protocol() {
	}

	public static String hello(String modVersion, String mcVersion, EnvType envType) {
		JsonObject o = new JsonObject();
		o.addProperty("t", "hello");
		o.addProperty("protocolVersion", VERSION);
		o.addProperty("modVersion", modVersion);
		o.addProperty("mcVersion", mcVersion);
		o.addProperty("envType", envType.wireName);
		return o.toString();
	}

	public static String pong(int id) {
		JsonObject o = new JsonObject();
		o.addProperty("t", "pong");
		o.addProperty("id", id);
		return o.toString();
	}

	public static String jobAck(String jobId) {
		JsonObject o = new JsonObject();
		o.addProperty("t", "job.ack");
		o.addProperty("jobId", jobId);
		return o.toString();
	}

	public static String jobState(String jobId, String state, int placed, int total) {
		JsonObject o = new JsonObject();
		o.addProperty("t", "job.state");
		o.addProperty("jobId", jobId);
		o.addProperty("state", state);
		JsonObject progress = new JsonObject();
		progress.addProperty("placed", placed);
		progress.addProperty("total", total);
		o.add("progress", progress);
		return o.toString();
	}

	/** Returns null for anything that is not a JSON object carrying a string {@code t}. */
	public static JsonObject parse(String raw) {
		try {
			JsonObject o = JsonParser.parseString(raw).getAsJsonObject();
			return o.has("t") && o.get("t").isJsonPrimitive() ? o : null;
		} catch (RuntimeException e) {
			return null;
		}
	}

	public static String type(JsonObject message) {
		return message.get("t").getAsString();
	}

	public enum EnvType {
		/** Singleplayer, or a world opened to LAN. */
		INTEGRATED("integrated"),
		/** A standalone server process. */
		DEDICATED("dedicated");

		public final String wireName;

		EnvType(String wireName) {
			this.wireName = wireName;
		}
	}
}
