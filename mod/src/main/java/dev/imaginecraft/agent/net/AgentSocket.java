package dev.imaginecraft.agent.net;

import com.google.gson.JsonObject;
import dev.imaginecraft.agent.config.ModConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * Outbound control connection to the ImagineCraft server.
 *
 * <p>Built on {@link java.net.http.WebSocket} from the JDK: TLS works out of the box, there
 * is nothing to shade into the jar, and no third-party library to re-verify on every
 * Minecraft update.
 *
 * <p>The connection is always dialled <em>out</em> from the logical server, so nobody has to
 * open a port or expose their machine. It reconnects on its own with exponential backoff,
 * because a laptop that sleeps or a server that briefly loses DNS should recover silently.
 */
public final class AgentSocket implements WebSocket.Listener {
	private static final Logger LOGGER = LoggerFactory.getLogger("imaginecraft-socket");
	private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(15);
	private static final long BACKOFF_MIN_MS = 1_000L;
	private static final long BACKOFF_MAX_MS = 60_000L;

	private final String modVersion;
	private final String mcVersion;
	private final Protocol.EnvType envType;
	private final Consumer<JsonObject> messageHandler;

	// A WebSocket upgrade is an HTTP/1.1 mechanism; asking for HTTP/2 first only adds a
	// negotiation that some reverse proxies handle badly.
	private final HttpClient http = HttpClient.newBuilder()
			.version(HttpClient.Version.HTTP_1_1)
			.connectTimeout(CONNECT_TIMEOUT)
			.build();
	private final ScheduledExecutorService scheduler =
			Executors.newSingleThreadScheduledExecutor(r -> {
				Thread t = new Thread(r, "imaginecraft-agent-socket");
				t.setDaemon(true);
				return t;
			});

	private final AtomicBoolean running = new AtomicBoolean(false);
	private final StringBuilder inbound = new StringBuilder();
	private volatile WebSocket socket;
	private volatile long backoffMs = BACKOFF_MIN_MS;

	public AgentSocket(String modVersion, String mcVersion, Protocol.EnvType envType,
			Consumer<JsonObject> messageHandler) {
		this.modVersion = modVersion;
		this.mcVersion = mcVersion;
		this.envType = envType;
		this.messageHandler = messageHandler;
	}

	/** Starts connecting. Safe to call twice; the second call is ignored. */
	public void start() {
		if (!running.compareAndSet(false, true)) {
			return;
		}
		connect();
	}

	/**
	 * Drop the current connection and dial again.
	 *
	 * Needed after re-pairing: {@link #start()} is a no-op once running, so a world that
	 * paired a second time kept talking under its previous identity. The website then queued
	 * jobs for the agent it could see while the mod fetched them with a different token, and
	 * every download came back 403.
	 *
	 * Closing is enough to redial — {@code onClose} schedules a reconnect, which re-reads the
	 * token from config.
	 */
	public void reconnect() {
		backoffMs = BACKOFF_MIN_MS;
		WebSocket current = socket;
		if (current == null) {
			// Not connected yet; either start for the first time or let the pending retry run.
			start();
			if (running.get() && socket == null) connect();
			return;
		}
		socket = null;
		current.sendClose(WebSocket.NORMAL_CLOSURE, "re-paired");
	}

	public void stop() {
		running.set(false);
		WebSocket current = socket;
		socket = null;
		if (current != null) {
			current.sendClose(WebSocket.NORMAL_CLOSURE, "shutting down");
		}
		scheduler.shutdownNow();
	}

	public boolean isConnected() {
		WebSocket current = socket;
		return current != null && !current.isInputClosed() && !current.isOutputClosed();
	}

	public void send(String json) {
		WebSocket current = socket;
		if (current == null) {
			LOGGER.debug("dropping message, socket not connected");
			return;
		}
		current.sendText(json, true);
	}

	private void connect() {
		if (!running.get()) {
			return;
		}

		ModConfig config = ModConfig.get();
		if (!config.isPaired()) {
			// Nothing to authenticate with. Stay idle rather than hammering the server;
			// the pair command restarts us once a token exists.
			LOGGER.info("Not paired yet — run /imaginecraft pair <code> to connect this world.");
			running.set(false);
			return;
		}

		String url = config.websocketUrl();
		LOGGER.info("connecting to {}", url);

		http.newWebSocketBuilder()
				.connectTimeout(CONNECT_TIMEOUT)
				.header("Authorization", "Bearer " + config.agentToken)
				.buildAsync(URI.create(url), this)
				.whenComplete((ws, error) -> {
					if (error != null) {
						LOGGER.warn("connection failed: {}", error.getMessage());
						scheduleReconnect();
					}
				});
	}

	private void scheduleReconnect() {
		if (!running.get()) {
			return;
		}
		long delay = backoffMs;
		backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
		LOGGER.info("reconnecting in {}s", delay / 1000);
		try {
			scheduler.schedule(this::connect, delay, TimeUnit.MILLISECONDS);
		} catch (RuntimeException e) {
			// Scheduler already shut down by stop(); nothing to retry.
			LOGGER.debug("reconnect not scheduled: {}", e.getMessage());
		}
	}

	// --- WebSocket.Listener -------------------------------------------------

	@Override
	public void onOpen(WebSocket webSocket) {
		this.socket = webSocket;
		this.backoffMs = BACKOFF_MIN_MS;
		LOGGER.info("connected");
		webSocket.sendText(Protocol.hello(modVersion, mcVersion, envType), true);
		webSocket.request(1);
	}

	@Override
	public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
		inbound.append(data);
		if (last) {
			String raw = inbound.toString();
			inbound.setLength(0);
			handle(raw);
		}
		webSocket.request(1);
		return null;
	}

	private void handle(String raw) {
		JsonObject message = Protocol.parse(raw);
		if (message == null) {
			LOGGER.warn("discarded malformed frame");
			return;
		}

		String type = Protocol.type(message);
		switch (type) {
			case "ping" -> send(Protocol.pong(message.get("id").getAsInt()));
			case "hello.ok" -> LOGGER.info("paired as \"{}\"", message.get("agentName").getAsString());
			case "hello.error" -> {
				LOGGER.error("server rejected connection: {}", message.get("message").getAsString());
				// A rejected handshake will not succeed on retry, so stop instead of looping.
				running.set(false);
			}
			default -> messageHandler.accept(message);
		}
	}

	/**
	 * A socket that is no longer the live one must not trigger a reconnect.
	 *
	 * The server closes an agent's previous socket whenever a newer one authenticates. Without
	 * this guard the mod read that as a dropped connection and dialled again, the server closed
	 * the socket that had just replaced it, and the two sides chased each other forever —
	 * re-downloading the pending job on every cycle.
	 */
	private boolean isSuperseded(WebSocket webSocket) {
		WebSocket current = socket;
		return current != null && current != webSocket;
	}

	@Override
	public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
		if (isSuperseded(webSocket)) {
			LOGGER.debug("a replaced socket closed ({}), ignoring", statusCode);
			return null;
		}
		LOGGER.info("disconnected ({} {})", statusCode, reason);
		socket = null;
		scheduleReconnect();
		return null;
	}

	@Override
	public void onError(WebSocket webSocket, Throwable error) {
		if (isSuperseded(webSocket)) return;
		LOGGER.warn("socket error: {}", error.getMessage());
		socket = null;
		scheduleReconnect();
	}
}
