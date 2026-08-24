package dev.imaginecraft.agent.job;

import com.google.gson.JsonObject;
import dev.imaginecraft.agent.build.BuildTask;
import dev.imaginecraft.agent.build.BuilderBot;
import dev.imaginecraft.agent.build.Schematic;
import dev.imaginecraft.agent.config.ModConfig;
import dev.imaginecraft.agent.net.AgentSocket;
import dev.imaginecraft.agent.net.Protocol;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.Rotation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Turns a job offer from the website into blocks in the world.
 *
 * <p>Everything that touches the world happens on the server thread, driven from the tick
 * event. Network work — fetching the schematic — happens off it, because a blocking HTTP
 * call on the server thread stalls every player in the world. The handoff between the two is
 * a single {@link AtomicReference}: the download thread parks a parsed schematic, and the
 * next tick picks it up.
 *
 * <p>A job never places blocks on arrival. It waits for a player to choose where, because a
 * website deciding to overwrite part of someone's world unprompted is the one behaviour that
 * would make this feature unshippable.
 */
public final class JobManager {
	private static final Logger LOGGER = LoggerFactory.getLogger("imaginecraft-jobs");
	private static final int PROGRESS_REPORT_TICKS = 20;

	private final MinecraftServer server;
	private final AgentSocket socket;
	// HTTP/1.1 for the same reason as the pairing call: Java's default h2c upgrade confuses a
	// Node HTTP/1.1 server about body framing.
	private final HttpClient http = HttpClient.newBuilder()
			.version(HttpClient.Version.HTTP_1_1)
			.connectTimeout(Duration.ofSeconds(20))
			.build();

	/** Set off-thread by the downloader, consumed on the server thread. */
	private final AtomicReference<PendingJob> ready = new AtomicReference<>();

	private PendingJob awaitingPlacement;
	private ActiveBuild active;
	private int ticksSinceReport;

	private record PendingJob(String jobId, String name, Schematic schematic, int blockCount) {}

	private static final class ActiveBuild {
		final String jobId;
		final BuildTask task;
		final BuilderBot bot;
		int lastReported;

		ActiveBuild(String jobId, BuildTask task, BuilderBot bot) {
			this.jobId = jobId;
			this.task = task;
			this.bot = bot;
		}
	}

	public JobManager(MinecraftServer server, AgentSocket socket) {
		this.server = server;
		this.socket = socket;
	}

	// --- messages from the website ---------------------------------------

	public void handle(JsonObject message) {
		switch (Protocol.type(message)) {
			case "job.offer" -> onOffer(message);
			case "job.cancel" -> onCancel(message.get("jobId").getAsString());
			default -> LOGGER.debug("ignoring message {}", Protocol.type(message));
		}
	}

	private void onOffer(JsonObject message) {
		String jobId = message.get("jobId").getAsString();
		String name = message.has("name") ? message.get("name").getAsString() : "Build";
		String dataUrl = message.get("dataUrl").getAsString();

		// The server re-offers anything still pending whenever an agent connects, so a
		// reconnect mid-job would otherwise download the same build again and overwrite the
		// one already waiting to be placed.
		if (active != null && active.jobId.equals(jobId)) return;
		if (awaitingPlacement != null && awaitingPlacement.jobId().equals(jobId)) return;

		if (active != null) {
			socket.send(Protocol.jobState(jobId, "failed", 0, 0));
			broadcast(Component.literal("ImagineCraft: already building something — try again when it finishes.")
					.withStyle(ChatFormatting.RED));
			return;
		}

		socket.send(Protocol.jobAck(jobId));
		broadcast(Component.literal("ImagineCraft: fetching \"" + name + "\"…").withStyle(ChatFormatting.GRAY));

		ModConfig config = ModConfig.get();
		String url = config.serverUrl.replaceFirst("/+$", "") + dataUrl;

		HttpRequest request = HttpRequest.newBuilder(URI.create(url))
				.timeout(Duration.ofSeconds(60))
				.header("Authorization", "Bearer " + config.agentToken)
				.GET()
				.build();

		http.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray())
				.whenComplete((response, error) -> {
					if (error != null || response.statusCode() != 200) {
						String reason = error != null ? error.getMessage() : "HTTP " + response.statusCode();
						LOGGER.warn("could not fetch {}: {}", url, reason);
						socket.send(Protocol.jobState(jobId, "failed", 0, 0));
						broadcast(Component.literal("ImagineCraft: could not download the build (" + reason + ")")
								.withStyle(ChatFormatting.RED));
						return;
					}

					try {
						Schematic schematic = Schematic.read(response.body());
						ready.set(new PendingJob(jobId, name, schematic, schematic.solidCount()));
					} catch (Exception e) {
						LOGGER.warn("could not parse the schematic for job {}", jobId, e);
						socket.send(Protocol.jobState(jobId, "failed", 0, 0));
						broadcast(Component.literal("ImagineCraft: that build could not be read (" + e.getMessage() + ")")
								.withStyle(ChatFormatting.RED));
					}
				});
	}

	private void onCancel(String jobId) {
		if (active != null && active.jobId.equals(jobId)) {
			active.task.cancel();
			return;
		}
		if (awaitingPlacement != null && awaitingPlacement.jobId().equals(jobId)) {
			awaitingPlacement = null;
			broadcast(Component.literal("ImagineCraft: that build was cancelled from the website.")
					.withStyle(ChatFormatting.GRAY));
		}
	}

	// --- the server tick -------------------------------------------------

	public void tick() {
		PendingJob arrived = ready.getAndSet(null);
		if (arrived != null) {
			awaitingPlacement = arrived;
			socket.send(Protocol.jobState(arrived.jobId(), "previewing", 0, arrived.blockCount()));
			broadcast(
					Component.literal("ImagineCraft: \"" + arrived.name() + "\" is ready — ")
							.withStyle(ChatFormatting.GREEN)
							.append(Component.literal(arrived.schematic().width() + "×" + arrived.schematic().height()
									+ "×" + arrived.schematic().length() + ", " + arrived.blockCount() + " blocks. ")
									.withStyle(ChatFormatting.GRAY))
							.append(Component.literal("Stand where you want it and run /imaginecraft build")
									.withStyle(ChatFormatting.YELLOW)));
		}

		if (active == null) return;

		active.bot.tick();
		active.task.tick();

		// Report on a timer rather than per block: at 200 blocks a second a message per block
		// would be thousands of frames a minute up the socket.
		if (++ticksSinceReport >= PROGRESS_REPORT_TICKS) {
			ticksSinceReport = 0;
			if (active.task.placed() != active.lastReported) {
				active.lastReported = active.task.placed();
				socket.send(Protocol.jobState(active.jobId, "building", active.task.placed(), active.task.total()));
				active.bot.setName("⚒ " + percent(active.task.placed(), active.task.total()) + "%");
			}
		}

		if (active.task.isFinished()) finish();
	}

	private void finish() {
		ActiveBuild finished = active;
		active = null;

		finished.bot.despawn();
		socket.send(Protocol.jobState(finished.jobId, "done", finished.task.placed(), finished.task.total()));

		BlockPos at = finished.task.origin();
		broadcast(Component.literal("ImagineCraft: done — " + finished.task.placed() + " blocks placed at "
				+ at.getX() + ", " + at.getY() + ", " + at.getZ()).withStyle(ChatFormatting.GREEN));
	}

	// --- placement, triggered by the player ------------------------------

	public boolean hasPendingBuild() {
		return awaitingPlacement != null;
	}

	public String pendingName() {
		return awaitingPlacement == null ? null : awaitingPlacement.name();
	}

	public boolean isBuilding() {
		return active != null;
	}

	/**
	 * Start building at a player's feet.
	 *
	 * The structure is centred horizontally on the player and rises from the block they are
	 * standing on, which is what "put it here" means to someone looking at the ground.
	 */
	public String startBuild(ServerPlayer player, Rotation rotation) {
		if (awaitingPlacement == null) return "no build is waiting — send one from the website first";

		// Centred on the player and rising from the block they stand on, which is what
		// "put it here" means to someone looking at the ground.
		Schematic schematic = awaitingPlacement.schematic();
		BlockPos origin = player
				.blockPosition()
				.offset(-schematic.width() / 2, 0, -schematic.length() / 2);
		return startBuildAt(player.level(), origin, rotation);
	}

	/**
	 * Build at explicit coordinates.
	 *
	 * Exists so the console, a command block, or a player on a vanilla client can place a
	 * build without the interactive preview — and it is the only path an automated test can
	 * drive, since nothing else works without a human standing in the world.
	 */
	public String startBuildAt(ServerLevel level, BlockPos origin, Rotation rotation) {
		if (active != null) return "a build is already in progress";
		if (awaitingPlacement == null) return "no build is waiting — send one from the website first";

		PendingJob job = awaitingPlacement;
		awaitingPlacement = null;

		BuilderBot bot = BuilderBot.spawn(level, origin, job.name());
		BuildTask task = new BuildTask(level, job.schematic(), origin, rotation, bot, ModConfig.get().buildSpeed);

		active = new ActiveBuild(job.jobId(), task, bot);
		ticksSinceReport = 0;

		socket.send(Protocol.jobState(job.jobId(), "building", 0, task.total()));
		broadcast(Component.literal("ImagineCraft: building \"" + job.name() + "\" — " + task.total() + " blocks.")
				.withStyle(ChatFormatting.GREEN));
		return null;
	}

	public boolean cancelActive() {
		if (active == null) return false;
		active.task.cancel();
		socket.send(Protocol.jobState(active.jobId, "cancelled", active.task.placed(), active.task.total()));
		active.bot.despawn();
		active = null;
		return true;
	}

	public void shutdown() {
		if (active != null) {
			active.bot.despawn();
			active = null;
		}
	}

	private static int percent(int placed, int total) {
		return total == 0 ? 100 : (int) Math.round((placed * 100.0) / total);
	}

	private void broadcast(Component message) {
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			player.sendSystemMessage(message);
		}
		LOGGER.info("{}", message.getString());
	}
}
