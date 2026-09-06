package dev.craftmagic.agent.config;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonSyntaxException;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Persisted mod settings, stored at {@code config/craftmagic.json}.
 *
 * <p>Holds the agent token obtained during pairing. The token is a bearer credential for
 * this world's connection, so the file is written with no extra copies and never logged.
 */
public final class ModConfig {
	private static final Logger LOGGER = LoggerFactory.getLogger("craftmagic-config");
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
	private static final String FILE_NAME = "craftmagic.json";

	/**
	 * Where the site lives. Overridable via {@code /craftmagic server <url>} so a local dev
	 * server can be used instead.
	 *
	 * <p>Must stay in step with {@code PUBLIC_ORIGIN} on the server: pairing posts the code
	 * here, and the schematic is fetched from whatever this resolves to. Because it is https,
	 * {@link #websocketUrl()} derives {@code wss://} — which is also why the site has to be
	 * reachable over TLS before a shipped jar can pair. Point it somewhere else for local work:
	 * {@code /craftmagic server http://localhost:3016}.
	 */
	public String serverUrl = "https://craftmagic.online";

	/** Null until {@code /craftmagic pair <code>} succeeds. */
	public String agentToken = null;

	/**
	 * Blocks placed per second while building. {@code 0} means place everything at once.
	 *
	 * <p>Was 40, which made the bot pleasant to watch and a map impossible to deliver: a
	 * region at the engine's 500,000-block cap took about three and a half hours, while the
	 * website — which had no way to ask — advertised 8,000 a second and printed "about a
	 * minute" beside it. 800 is a twentieth of what {@link
	 * dev.craftmagic.agent.build.BuildTask} will do per tick, lands that region in around ten
	 * minutes, and stays slow enough that the placement is still something you watch happen
	 * rather than a world that blinks into existence.
	 *
	 * <p>{@code /craftmagic speed} still overrides it either way.
	 */
	public int buildSpeed = 800;

	private static ModConfig instance;

	private ModConfig() {
	}

	public static synchronized ModConfig get() {
		if (instance == null) {
			instance = load();
		}
		return instance;
	}

	private static Path path() {
		return FabricLoader.getInstance().getConfigDir().resolve(FILE_NAME);
	}

	private static ModConfig load() {
		Path file = path();
		if (!Files.exists(file)) {
			ModConfig fresh = new ModConfig();
			fresh.save();
			return fresh;
		}
		try {
			String json = Files.readString(file, StandardCharsets.UTF_8);
			ModConfig loaded = GSON.fromJson(json, ModConfig.class);
			// An empty or `null` file parses to null rather than throwing.
			return loaded != null ? loaded : new ModConfig();
		} catch (IOException | JsonSyntaxException e) {
			LOGGER.error("Could not read {} — falling back to defaults. Pairing will be required again.", file, e);
			return new ModConfig();
		}
	}

	public synchronized void save() {
		Path file = path();
		try {
			Files.createDirectories(file.getParent());
			Files.writeString(file, GSON.toJson(this), StandardCharsets.UTF_8);
		} catch (IOException e) {
			LOGGER.error("Could not write {}", file, e);
		}
	}

	public boolean isPaired() {
		return agentToken != null && !agentToken.isBlank();
	}

	/** Base websocket URL derived from {@link #serverUrl}, so only one setting has to be right. */
	public String websocketUrl() {
		String base = serverUrl.replaceFirst("/+$", "");
		if (base.startsWith("https://")) {
			return "wss://" + base.substring("https://".length()) + "/agent/ws";
		}
		if (base.startsWith("http://")) {
			return "ws://" + base.substring("http://".length()) + "/agent/ws";
		}
		return base + "/agent/ws";
	}
}
