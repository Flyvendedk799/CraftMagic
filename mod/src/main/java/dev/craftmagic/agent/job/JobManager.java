package dev.craftmagic.agent.job;

import com.google.gson.JsonObject;
import dev.craftmagic.agent.build.BuildTask;
import dev.craftmagic.agent.build.BuilderBot;
import dev.craftmagic.agent.build.Footprint;
import dev.craftmagic.agent.build.Schematic;
import dev.craftmagic.agent.config.ModConfig;
import dev.craftmagic.agent.net.AgentSocket;
import dev.craftmagic.agent.net.Protocol;
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
 *
 * <p>A world is the one exception, and only halfway. A world is too big to be one build, so it
 * arrives as a run of ordinary builds, one per region. Region 0 is offered like anything else
 * and waits for a player, who chooses the corner and the facing of the entire map; it reports
 * that choice back as the job's anchor, and every region after it is offered with that anchor
 * attached and goes down without asking again. The consent is still the player's — they gave
 * it once, for the map, instead of sixteen times for sixteen squares of it.
 */
public final class JobManager {
	private static final Logger LOGGER = LoggerFactory.getLogger("craftmagic-jobs");
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

	/** {@code region} is null for a lone build, which is what almost every job is. */
	private record PendingJob(
			String jobId, String name, Schematic schematic, int blockCount, Protocol.Region region) {}

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
		Protocol.Region region = Protocol.region(message);

		// The server re-offers anything still pending whenever an agent connects, so a
		// reconnect mid-job would otherwise download the same build again and overwrite the
		// one already waiting to be placed.
		if (active != null && active.jobId.equals(jobId)) return;
		if (awaitingPlacement != null && awaitingPlacement.jobId().equals(jobId)) return;

		if (active != null) {
			socket.send(Protocol.jobState(jobId, "failed", 0, 0));
			broadcast(Component.literal("CraftMagic: already building something — try again when it finishes.")
					.withStyle(ChatFormatting.RED));
			return;
		}

		socket.send(Protocol.jobAck(jobId));
		broadcast(Component.literal("CraftMagic: fetching \"" + name + "\"…").withStyle(ChatFormatting.GRAY));

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
						broadcast(Component.literal("CraftMagic: could not download the build (" + reason + ")")
								.withStyle(ChatFormatting.RED));
						return;
					}

					try {
						Schematic schematic = Schematic.read(response.body());
						ready.set(new PendingJob(jobId, name, schematic, schematic.solidCount(), region));
					} catch (Exception e) {
						LOGGER.warn("could not parse the schematic for job {}", jobId, e);
						socket.send(Protocol.jobState(jobId, "failed", 0, 0));
						broadcast(Component.literal("CraftMagic: that build could not be read (" + e.getMessage() + ")")
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
			broadcast(Component.literal("CraftMagic: that build was cancelled from the website.")
					.withStyle(ChatFormatting.GRAY));
		}
	}

	// --- the server tick -------------------------------------------------

	public void tick() {
		PendingJob arrived = ready.getAndSet(null);
		if (arrived != null) {
			awaitingPlacement = arrived;
			// A continuation region already knows where it goes, so it never reaches the
			// preview: asking a player to aim square nine of a map they aimed once would be
			// asking them to reproduce a decision they cannot see any more.
			if (!placeContinuation(arrived)) {
				socket.send(Protocol.jobState(arrived.jobId(), "previewing", 0, arrived.blockCount()));
				broadcast(
						Component.literal("CraftMagic: \"" + arrived.name() + "\" is ready — ")
								.withStyle(ChatFormatting.GREEN)
								.append(Component.literal(arrived.schematic().width() + "×" + arrived.schematic().height()
										+ "×" + arrived.schematic().length() + ", " + arrived.blockCount() + " blocks. "
										+ worldNote(arrived.region()))
										.withStyle(ChatFormatting.GRAY))
								.append(Component.literal(
												"Right-click it into place with the wand, then punch the air. "
														+ "(/craftmagic wand for one, or /craftmagic build to drop it where you stand.)")
										.withStyle(ChatFormatting.YELLOW)));
			}
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
		broadcast(Component.literal("CraftMagic: done — " + finished.task.placed() + " blocks placed at "
				+ at.getX() + ", " + at.getY() + ", " + at.getZ()).withStyle(ChatFormatting.GREEN));
	}

	// --- placement of a world, one region at a time ----------------------

	/**
	 * Where a region of a world belongs, or null when the job is not one.
	 *
	 * <p>This is the fix the whole feature turns on. {@link Footprint#origin} centres a build on
	 * the player, which is exactly right for "put this house here" and exactly wrong for square
	 * nine of a map: centred, every region lands on top of the last and the world is delivered
	 * sixteen times into the same hole.
	 *
	 * <p>The rotation is the anchor's, not the player's current facing, and the offset is turned
	 * by it before it is added. Region 0's quarter turn turned the map, so a region two tiles
	 * east of the world's corner is two tiles <em>south</em> of the anchor once the map has been
	 * turned a quarter clockwise. Adding the offset unturned would place each region correctly
	 * rotated in the wrong square — a map mirrored about its diagonal and scattered, which looks
	 * like a bug in the world document rather than in this line.
	 */
	private BlockPos regionOrigin(PendingJob job) {
		Protocol.Region region = job.region();
		if (region == null || !region.isContinuation()) return null;

		Rotation rotation = Footprint.rotation(region.anchorRotation());
		BlockPos turned = Footprint.turn(region.offsetX(), region.offsetY(), region.offsetZ(), rotation);
		return new BlockPos(region.anchorX(), region.anchorY(), region.anchorZ())
				.offset(turned.getX(), turned.getY(), turned.getZ());
	}

	/**
	 * Put a continuation region down without asking anyone. Returns whether it handled the job.
	 *
	 * <p>True is returned even when the placement fails, because a region that cannot be placed
	 * is finished either way: what it must not do is fall through to the preview and wait for a
	 * player to aim a square of a map at somewhere it does not go.
	 */
	private boolean placeContinuation(PendingJob job) {
		BlockPos origin = regionOrigin(job);
		if (origin == null) return false;

		Protocol.Region region = job.region();
		ServerLevel level = levelFor(region.anchorDimension());
		if (level == null) {
			failPending(job, "the rest of this world is in " + region.anchorDimension()
					+ ", which this server does not have.");
			return true;
		}

		String problem = startBuildAt(level, origin, Footprint.rotation(region.anchorRotation()));
		if (problem != null) {
			failPending(job, problem);
			return true;
		}

		broadcast(Component.literal("CraftMagic: region " + (region.index() + 1) + " of " + region.total()
				+ " at " + origin.getX() + ", " + origin.getY() + ", " + origin.getZ() + ".")
				.withStyle(ChatFormatting.GRAY));
		return true;
	}

	/**
	 * The level a dimension key names, or null when this server has no such dimension.
	 *
	 * <p>Matched by key rather than looked up through the dimension registry, which needs a
	 * {@code ResourceKey} assembled out of two more imports for a search over at most a handful
	 * of levels. A null key is an older server that does not echo the dimension back, and the
	 * overworld is the only defensible guess there — it is where all but a rounding error of
	 * builds go.
	 */
	private ServerLevel levelFor(String dimension) {
		if (dimension == null) return server.overworld();
		for (ServerLevel level : server.getAllLevels()) {
			if (level.dimension().identifier().toString().equals(dimension)) return level;
		}
		return null;
	}

	/** Give up on a job that has arrived but cannot be placed, and say why in chat. */
	private void failPending(PendingJob job, String reason) {
		if (awaitingPlacement == job) awaitingPlacement = null;
		socket.send(Protocol.jobState(job.jobId(), "failed", 0, job.blockCount()));
		broadcast(Component.literal("CraftMagic: " + reason).withStyle(ChatFormatting.RED));
	}

	/**
	 * The sentence that tells a player the thing they are about to aim is a whole map.
	 *
	 * <p>Only for region 0. A later region reaching the preview at all means its anchor went
	 * missing somewhere, and calling it "the first of sixteen" would be telling the player the
	 * one thing that is definitely not true about it.
	 */
	private static String worldNote(Protocol.Region region) {
		if (region == null || region.index() != 0 || region.total() <= 1) return "";
		return "The first of " + region.total() + " regions — where you put it sets the whole map. ";
	}

	// --- placement, triggered by the player ------------------------------

	public boolean hasPendingBuild() {
		return awaitingPlacement != null;
	}

	public String pendingName() {
		return awaitingPlacement == null ? null : awaitingPlacement.name();
	}

	/**
	 * The build waiting to be placed, or null.
	 *
	 * <p>Exposed so the wand can outline the footprint before anything is committed — the
	 * preview needs the schematic's size, and only this class knows it.
	 */
	public Schematic pendingSchematic() {
		return awaitingPlacement == null ? null : awaitingPlacement.schematic();
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

		// A region of a world is not "here" — it is where the map says, whatever the player
		// typing this happens to be standing on. Reached when someone runs /craftmagic build
		// while a continuation region is in flight; honouring the request literally would tear
		// one square out of the map and drop it at their feet.
		BlockPos placed = regionOrigin(awaitingPlacement);
		if (placed != null) {
			Rotation turned = Footprint.rotation(awaitingPlacement.region().anchorRotation());
			ServerLevel level = levelFor(awaitingPlacement.region().anchorDimension());
			return startBuildAt(level == null ? player.level() : level, placed, turned);
		}

		// Centred on the player and rising from the block they stand on, which is what
		// "put it here" means to someone looking at the ground. Centring is rotation-aware:
		// a quarter turn swaps the footprint's width and length, and centring on the
		// unrotated size slid a long building out from under the player who aimed it.
		Schematic schematic = awaitingPlacement.schematic();
		BlockPos origin =
				Footprint.origin(schematic.width(), schematic.length(), rotation, player.blockPosition());
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

		// The anchor goes up with the first progress report and nowhere else. For a lone build
		// it is a record of where the thing ended up; for region 0 of a world it is the origin
		// the server measures every remaining region from, and the server will not offer one
		// until this frame has landed.
		Protocol.Anchor anchor = new Protocol.Anchor(
				origin.getX(),
				origin.getY(),
				origin.getZ(),
				Footprint.quarterTurns(rotation),
				level.dimension().identifier().toString());
		socket.send(Protocol.jobState(job.jobId(), "building", 0, task.total(), anchor));
		broadcast(Component.literal("CraftMagic: building \"" + job.name() + "\" — " + task.total() + " blocks.")
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
