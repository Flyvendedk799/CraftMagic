package dev.imaginecraft.agent.config;

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
 * Persisted mod settings, stored at {@code config/imaginecraft.json}.
 *
 * <p>Holds the agent token obtained during pairing. The token is a bearer credential for
 * this world's connection, so the file is written with no extra copies and never logged.
 */
public final class ModConfig {
	private static final Logger LOGGER = LoggerFactory.getLogger("imaginecraft-config");
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
	private static final String FILE_NAME = "imaginecraft.json";

	/**
	 * Where the site lives. Overridable via {@code /imaginecraft server <url>} so a local dev
	 * server can be used instead.
	 *
	 * <p>This is the deployment's address rather than a domain because no domain is registered
	 * yet. It must stay in step with {@code PUBLIC_ORIGIN} on the server: pairing sends the
	 * token here, and the schematic is fetched from whatever this resolves to.
	 */
	public String serverUrl = "http://85.190.100.23:3016";

	/** Null until {@code /imaginecraft pair <code>} succeeds. */
	public String agentToken = null;

	/** Blocks placed per second while building. {@code 0} means place everything at once. */
	public int buildSpeed = 40;

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
