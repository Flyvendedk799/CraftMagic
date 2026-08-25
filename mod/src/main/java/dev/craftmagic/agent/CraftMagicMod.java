package dev.craftmagic.agent;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.craftmagic.agent.command.CraftMagicCommand;
import dev.craftmagic.agent.config.ModConfig;
import dev.craftmagic.agent.job.JobManager;
import dev.craftmagic.agent.net.AgentSocket;
import dev.craftmagic.agent.net.Protocol;
import dev.craftmagic.agent.wand.WandHandler;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.function.Consumer;

/**
 * Common entrypoint.
 *
 * <p>Everything that touches the world lives on the logical server: the socket, the job
 * state machine, and block placement. That holds for singleplayer too, where the
 * integrated server is still a server. The client half only draws the placement preview.
 */
public class CraftMagicMod implements ModInitializer {
	public static final String MOD_ID = "craftmagic";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	private static AgentSocket socket;
	private static JobManager jobs;
	private static String modVersion = "unknown";
	private static String mcVersion = "unknown";
	private static Protocol.EnvType envType;

	/**
	 * The running server, or null outside a world.
	 *
	 * <p>Kept because a Brigadier {@code requires} predicate cannot rely on
	 * {@code CommandSourceStack.getServer()}: Minecraft builds the command-tree packet with a
	 * synthetic source whose server is null, and dereferencing it there threw inside
	 * {@code PlayerList.placeNewPlayer}, which the client reports as "Invalid player data" —
	 * an error that names neither the mod nor the real cause.
	 */
	private static volatile MinecraftServer server;

	/** The running server, or null before SERVER_STARTED and after shutdown. */
	public static MinecraftServer server() {
		return server;
	}

	@Override
	public void onInitialize() {
		modVersion = FabricLoader.getInstance()
				.getModContainer(MOD_ID)
				.map(c -> c.getMetadata().getVersion().getFriendlyString())
				.orElse("unknown");

		CraftMagicCommand.register();
		// Registered here rather than per-server because Fabric's interaction events and the
		// payload registry are global and accept exactly one registration for the process.
		// The wand's own state is torn down in shutdown().
		WandHandler.register();
		ServerLifecycleEvents.SERVER_STARTED.register(this::onServerStarted);
		ServerLifecycleEvents.SERVER_STOPPING.register(server -> shutdown());
		// The job pipeline advances on the server thread, which is the only place block
		// placement and entity movement are safe.
		ServerTickEvents.END_SERVER_TICK.register(server -> {
			if (jobs != null) jobs.tick();
		});

		LOGGER.info("CraftMagic agent {} initialised", modVersion);
	}

	/**
	 * Exchange a pairing code for an agent token.
	 *
	 * <p>Runs off the server thread: a blocking HTTP call there would stall every player in
	 * the world for as long as the request takes. The callbacks are invoked on the HTTP
	 * client's thread, which is fine for sending chat but not for touching world state.
	 */
	public static void pairAsync(String code, Consumer<String> onSuccess, Consumer<String> onError) {
		ModConfig config = ModConfig.get();
		String endpoint = config.serverUrl.replaceFirst("/+$", "") + "/api/agent/claim";

		JsonObject payload = new JsonObject();
		payload.addProperty("code", code);
		payload.addProperty("modVersion", modVersion);
		payload.addProperty("mcVersion", mcVersion);
		payload.addProperty("envType", envType == null ? "integrated" : envType.wireName);

		HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint))
				.timeout(Duration.ofSeconds(20))
				.header("Content-Type", "application/json")
				.POST(HttpRequest.BodyPublishers.ofString(payload.toString(), StandardCharsets.UTF_8))
				.build();

		// HTTP/1.1 explicitly. Java's client defaults to HTTP/2 and opens with an h2c upgrade,
		// which a Node HTTP/1.1 server mis-frames: the body arrives at a different length than
		// the Content-Length it advertised, and the request is rejected before any handler runs.
		HttpClient.newBuilder()
				.version(HttpClient.Version.HTTP_1_1)
				.connectTimeout(Duration.ofSeconds(20))
				.build()
				.sendAsync(request, HttpResponse.BodyHandlers.ofString())
				.whenComplete((response, error) -> {
					if (error != null) {
						// Also logged, not only sent to the command source: an RCON or command-block
						// caller has usually stopped listening by the time this lands.
						LOGGER.warn("pairing failed: could not reach {}", endpoint, error);
						onError.accept("could not reach " + endpoint + " (" + error.getMessage() + ")");
						return;
					}
					if (response.statusCode() == 404) {
						LOGGER.warn("pairing failed: code rejected by {}", endpoint);
						onError.accept("that code is not valid, or it has expired");
						return;
					}
					if (response.statusCode() != 200) {
						LOGGER.warn("pairing failed: {} replied {} — {}", endpoint, response.statusCode(), response.body());
						onError.accept("server replied " + response.statusCode());
						return;
					}

					try {
						JsonObject body = JsonParser.parseString(response.body()).getAsJsonObject();
						String token = body.get("agentToken").getAsString();
						config.agentToken = token;
						config.save();
						LOGGER.info("paired with {} — connecting", endpoint);
						onSuccess.accept("Paired. Builds sent from the website will now appear here.");
						// reconnect, not start: pairing a second time mints a new token, and a
						// socket already running would keep using the old one.
						if (socket != null) socket.reconnect();
					} catch (RuntimeException e) {
						LOGGER.warn("pairing failed: unreadable reply from {}", endpoint, e);
						onError.accept("could not read the server's reply: " + e.getMessage());
					}
				});
	}

	public static void disconnect() {
		if (socket != null) socket.stop();
	}

	private void onServerStarted(MinecraftServer server) {
		CraftMagicMod.server = server;
		envType = server.isDedicatedServer()
				? Protocol.EnvType.DEDICATED
				: Protocol.EnvType.INTEGRATED;
		mcVersion = server.getServerVersion();

		socket = new AgentSocket(modVersion, mcVersion, envType, message -> {
			if (jobs != null) jobs.handle(message);
		});
		jobs = new JobManager(server, socket);

		if (ModConfig.get().isPaired()) {
			socket.start();
		} else {
			LOGGER.info("No agent token stored. Run /craftmagic pair <code> to link this world.");
		}
	}

	private void shutdown() {
		// Cleared first: leaving a stale reference behind would keep a whole finished world
		// alive, and in singleplayer a player leaves and rejoins worlds all session.
		server = null;
		// Marked spots name a world that is going away; keeping them would hold its players
		// alive, and in singleplayer a session moves between worlds all evening.
		WandHandler.clear();
		if (jobs != null) {
			jobs.shutdown();
			jobs = null;
		}
		if (socket != null) {
			socket.stop();
			socket = null;
		}
	}

	public static JobManager jobs() {
		return jobs;
	}

	public static AgentSocket socket() {
		return socket;
	}
}
