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
		return jobState(jobId, state, placed, total, null);
	}

	/**
	 * A progress report, optionally saying where the build was put.
	 *
	 * <p>The anchor is sent once, when a build starts, and it is the only thing that lets a
	 * world be delivered in pieces: the server holds onto it and measures every later region of
	 * the same world from it. Until it arrives the server will not offer region 2, because there
	 * would be nothing to measure from.
	 */
	public static String jobState(String jobId, String state, int placed, int total, Anchor anchor) {
		JsonObject o = new JsonObject();
		o.addProperty("t", "job.state");
		o.addProperty("jobId", jobId);
		o.addProperty("state", state);
		JsonObject progress = new JsonObject();
		progress.addProperty("placed", placed);
		progress.addProperty("total", total);
		o.add("progress", progress);
		if (anchor != null) {
			JsonObject a = new JsonObject();
			a.addProperty("x", anchor.x());
			a.addProperty("y", anchor.y());
			a.addProperty("z", anchor.z());
			a.addProperty("rotation", anchor.rotation());
			// Omitted rather than sent as null: the server treats the field as absent-or-string,
			// and a JSON null would fail that check and take the whole anchor down with it.
			if (anchor.dimension() != null) a.addProperty("dimension", anchor.dimension());
			o.add("anchor", a);
		}
		return o.toString();
	}

	/**
	 * Where a build was put: the corner it was built from, the quarter turns applied to it, and
	 * the dimension it went into.
	 *
	 * <p>The dimension matters only for worlds, and only because their later regions are placed
	 * with no player involved — nothing else would be left to say that a hub begun in the nether
	 * continues in the nether.
	 */
	public record Anchor(int x, int y, int z, int rotation, String dimension) {}

	/**
	 * The world-region half of a {@code job.offer}, or null when the offer is a lone build.
	 *
	 * <p>Null is the ordinary case and always will be: a house sent to a world has no region and
	 * never gains one. Reading it back as null rather than as a zeroed record is what keeps the
	 * legacy path a path rather than a special case of the new one.
	 *
	 * <p>{@code anchorX/Y/Z} and {@code anchorRotation} are only meaningful when
	 * {@link #hasAnchor()}, which is false on region 0 — the region a player places by hand, and
	 * the one whose placement everything after it is measured from.
	 */
	public record Region(
			String worldId,
			int index,
			int total,
			int rx,
			int rz,
			int offsetX,
			int offsetY,
			int offsetZ,
			boolean hasAnchor,
			int anchorX,
			int anchorY,
			int anchorZ,
			int anchorRotation,
			String anchorDimension) {

		/** True once the world has an origin to measure from, which is every region but the first. */
		public boolean isContinuation() {
			return index > 0 && hasAnchor;
		}
	}

	/**
	 * Read the region metadata out of a {@code job.offer}.
	 *
	 * <p>Absent means legacy, and so does malformed: an offer whose region block is missing a
	 * field is one this mod cannot honour, and treating it as a plain build hands it to the
	 * player to place rather than dropping it at coordinates assembled out of defaults.
	 */
	public static Region region(JsonObject offer) {
		if (!offer.has("region") || !offer.get("region").isJsonObject()) return null;
		JsonObject r = offer.getAsJsonObject("region");
		if (!r.has("worldId") || !r.has("index") || !r.has("offset")) return null;
		if (!r.get("offset").isJsonObject()) return null;
		JsonObject offset = r.getAsJsonObject("offset");

		JsonObject anchor =
				r.has("anchor") && r.get("anchor").isJsonObject() ? r.getAsJsonObject("anchor") : null;
		boolean hasAnchor = anchor != null && anchor.has("x") && anchor.has("y") && anchor.has("z");

		try {
			return new Region(
					r.get("worldId").getAsString(),
					r.get("index").getAsInt(),
					r.has("total") ? r.get("total").getAsInt() : 1,
					r.has("rx") ? r.get("rx").getAsInt() : 0,
					r.has("rz") ? r.get("rz").getAsInt() : 0,
					offset.has("x") ? offset.get("x").getAsInt() : 0,
					offset.has("y") ? offset.get("y").getAsInt() : 0,
					offset.has("z") ? offset.get("z").getAsInt() : 0,
					hasAnchor,
					hasAnchor ? anchor.get("x").getAsInt() : 0,
					hasAnchor ? anchor.get("y").getAsInt() : 0,
					hasAnchor ? anchor.get("z").getAsInt() : 0,
					hasAnchor && anchor.has("rotation") ? anchor.get("rotation").getAsInt() : 0,
					hasAnchor && anchor.has("dimension") ? anchor.get("dimension").getAsString() : null);
		} catch (RuntimeException e) {
			return null;
		}
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
