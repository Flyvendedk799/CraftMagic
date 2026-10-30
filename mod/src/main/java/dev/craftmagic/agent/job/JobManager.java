package dev.craftmagic.agent.job;

import com.google.gson.JsonObject;
import dev.craftmagic.agent.build.BuildTask;
import dev.craftmagic.agent.build.BuilderBot;
import dev.craftmagic.agent.build.Footprint;
import dev.craftmagic.agent.build.Schematic;
import dev.craftmagic.agent.config.ModConfig;
import dev.craftmagic.agent.hud.ActionBar;
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
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.UUID;
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
	/**
	 * Report even when nothing moved, every this many progress windows (30 s).
	 *
	 * <p>A paused build places nothing, and the server treats a job it has not heard about for
	 * five minutes as a dropped connection — so without this, pausing a build for a coffee got
	 * it reaped as failed. Well under the server's cutoff, well over its heartbeat.
	 */
	private static final int KEEPALIVE_REPORTS = 30;
	/** How long the bot stays for its victory lap before it is removed. */
	private static final int CELEBRATION_TICKS = 40;
	/** Players this close to the bot see build progress when nobody in particular started it. */
	private static final double PROGRESS_AUDIENCE_RANGE = 96;

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
	/**
	 * The most recent build that finished or was cancelled, kept so it can be undone.
	 *
	 * <p>Only one, and only in memory: its journal holds every block it replaced, which is the
	 * whole cost of undo, and a restart forgets it. An undo for anything else is refused with a
	 * reason rather than guessed at.
	 */
	private ActiveBuild lastFinished;
	/** Bots finishing their celebration; despawned when their time is up. */
	private final List<RetiringBot> retiring = new ArrayList<>();
	/** Who is being shown build progress on the action bar, so the wand can stay out of the way. */
	private final Set<UUID> progressAudience = new HashSet<>();
	private int ticksSinceReport;
	private int blocksChangedInWindow;
	private int currentRate;

	private static final class RetiringBot {
		final BuilderBot bot;
		int ticksLeft;

		RetiringBot(BuilderBot bot, int ticksLeft) {
			this.bot = bot;
			this.ticksLeft = ticksLeft;
		}
	}

	/** {@code region} is null for a lone build, which is what almost every job is. */
	private record PendingJob(
			String jobId, String name, Schematic schematic, int blockCount, Protocol.Region region) {}

	private static final class ActiveBuild {
		final String jobId;
		final BuildTask task;
		final BuilderBot bot;
		final ServerLevel level;
		/** The player who started it, or null for the console, a command block, or a map region. */
		final UUID owner;
		int lastReported = -1;
		int quietReports;

		ActiveBuild(String jobId, BuildTask task, BuilderBot bot, ServerLevel level, UUID owner) {
			this.jobId = jobId;
			this.task = task;
			this.bot = bot;
			this.level = level;
			this.owner = owner;
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
			case "job.pause" -> onPause(message.get("jobId").getAsString());
			case "job.resume" -> onResume(message.get("jobId").getAsString());
			case "job.undo" -> onUndo(message.get("jobId").getAsString());
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

	private void onPause(String jobId) {
		if (active != null && active.jobId.equals(jobId)) {
			pauseActive();
		}
	}

	private void onResume(String jobId) {
		if (active != null && active.jobId.equals(jobId)) {
			resumeActive();
		}
	}

	/**
	 * An undo asked for from the website.
	 *
	 * <p>The server has already moved the job to {@code undoing}, so a refusal must say so —
	 * otherwise the row sits in an active state with nothing behind it until the stale-job reaper
	 * fails it. The reply puts it back to {@code done} (the only state the website offers undo
	 * from) with the reason attached, and leaves its counts alone.
	 */
	private void onUndo(String jobId) {
		if (active != null && active.jobId.equals(jobId) && active.task.isUndoing()) return;
		String problem = undo(jobId);
		if (problem != null) {
			socket.send(Protocol.jobRefusal(jobId, "done", "could not undo: " + problem));
		}
	}

	// --- the server tick -------------------------------------------------

	public void tick() {
		tickRetiring();

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

		if (active == null) {
			progressAudience.clear();
			return;
		}

		active.bot.tick();
		int changed = active.task.tick();
		blocksChangedInWindow += changed;

		// Report on a timer rather than per block: at 200 blocks a second a message per block
		// would be thousands of frames a minute up the socket.
		if (++ticksSinceReport >= PROGRESS_REPORT_TICKS) {
			ticksSinceReport = 0;
			currentRate = blocksChangedInWindow;
			blocksChangedInWindow = 0;
			int progress = progressOf(active.task);
			boolean moved = progress != active.lastReported;
			if (moved || ++active.quietReports >= KEEPALIVE_REPORTS) {
				active.lastReported = progress;
				active.quietReports = 0;
				report(active);
			}
			if (moved) {
				active.bot.setName(botPrefix(active.task) + percentDone(active.task) + "%");
			}
		}

		showProgress(active);

		if (active.task.isFinished()) finish();
	}

	private void tickRetiring() {
		for (Iterator<RetiringBot> it = retiring.iterator(); it.hasNext(); ) {
			RetiringBot r = it.next();
			r.bot.tickCelebration();
			if (--r.ticksLeft <= 0) {
				r.bot.despawn();
				it.remove();
			}
		}
	}

	/** What the server calls the task's current activity. */
	private static String stateOf(BuildTask task) {
		if (task.isUndoing()) return "undoing";
		return task.isPaused() ? "paused" : "building";
	}

	/**
	 * The count reported to the server: how many of this build's blocks are in the world.
	 *
	 * <p>It rises while building and falls while undoing, so the job row means the same thing
	 * throughout — and an undo starts from the count the row already holds rather than jumping
	 * to zero and back.
	 */
	private static int progressOf(BuildTask task) {
		return task.isUndoing() ? task.undoTotal() - task.undone() : task.placed();
	}

	/** For the action bar and the bot's name tag: how far the current activity has got. */
	private static int percentDone(BuildTask task) {
		return task.isUndoing() ? percent(task.undone(), task.undoTotal()) : percent(task.placed(), task.total());
	}

	private static String botPrefix(BuildTask task) {
		if (task.isUndoing()) return "↺ ";
		return task.isPaused() ? "⏸ " : "⚒ ";
	}

	private void report(ActiveBuild build) {
		socket.send(Protocol.jobState(build.jobId, stateOf(build.task), progressOf(build.task), build.task.total()));
	}

	/**
	 * The action-bar progress line, for the people it concerns.
	 *
	 * <p>That is the player who started the build, when there is one and they are online —
	 * nobody else on a server needs a stranger's progress bar over their hotbar. A build nobody
	 * started (the console, a command block, a region of a map) is shown to whoever is near the
	 * bot instead. {@link ActionBar} keeps it to a line when something changed.
	 */
	private void showProgress(ActiveBuild build) {
		progressAudience.clear();
		ServerPlayer owner = build.owner == null ? null : server.getPlayerList().getPlayer(build.owner);
		if (owner != null) {
			progressAudience.add(owner.getUUID());
		} else {
			BlockPos at = build.bot.blockPosition();
			double range = PROGRESS_AUDIENCE_RANGE * PROGRESS_AUDIENCE_RANGE;
			for (ServerPlayer player : build.level.players()) {
				if (player.blockPosition().distSqr(at) <= range) progressAudience.add(player.getUUID());
			}
		}
		if (progressAudience.isEmpty()) return;

		BuildTask task = build.task;
		int done = task.isUndoing() ? task.undone() : task.placed();
		int total = task.isUndoing() ? task.undoTotal() : task.total();
		int pct = percentDone(task);
		int filled = Math.min(10, Math.max(0, pct / 10));
		String bar = "█".repeat(filled) + "░".repeat(10 - filled);
		ChatFormatting color = task.isPaused() ? ChatFormatting.YELLOW : (task.isUndoing() ? ChatFormatting.GOLD : ChatFormatting.GREEN);
		String prefix = task.isPaused() ? "PAUSED " : (task.isUndoing() ? "UNDOING " : "");
		Component line = Component.literal("[" + bar + "] " + prefix + pct + "% (" + done + "/" + total + " blocks) "
						+ currentRate + " blk/s")
				.withStyle(color);

		long now = server.getTickCount();
		for (UUID id : progressAudience) {
			ServerPlayer player = server.getPlayerList().getPlayer(id);
			if (player != null) ActionBar.show(player, line, now);
		}
	}

	/** Whether this player is being shown build progress, which takes the action bar from the wand. */
	public boolean isShowingProgressTo(ServerPlayer player) {
		return active != null && progressAudience.contains(player.getUUID());
	}

	private void finish() {
		ActiveBuild finished = active;
		active = null;
		progressAudience.clear();
		BuildTask task = finished.task;

		// Cancelled — from the website, or by /craftmagic cancel. Kept as the last build so its
		// blocks can still be taken back out with /craftmagic undo.
		if (task.isCancelled()) {
			finished.bot.despawn();
			socket.send(Protocol.jobState(finished.jobId, "cancelled", progressOf(task), task.total()));
			broadcast(Component.literal("CraftMagic: " + (task.isUndoing() ? "undo" : "build") + " stopped.")
					.withStyle(ChatFormatting.GRAY));
			lastFinished = finished;
			return;
		}

		// A finished undo is its own outcome, not a cancellation: the website shows a cancelled
		// job as something that went wrong, and this is the thing the player asked for.
		if (task.isUndoing()) {
			finished.bot.despawn();
			socket.send(Protocol.jobState(finished.jobId, "undone", progressOf(task), task.total()));
			broadcast(Component.literal("CraftMagic: build undone — " + task.undone() + " blocks put back.")
					.withStyle(ChatFormatting.GOLD));
			return;
		}

		finished.bot.celebrate(finished.level);
		retiring.add(new RetiringBot(finished.bot, CELEBRATION_TICKS));
		socket.send(Protocol.jobState(finished.jobId, "done", task.placed(), task.total()));

		BlockPos at = task.origin();
		broadcast(Component.literal("CraftMagic: done — " + task.placed() + " blocks placed at "
				+ at.getX() + ", " + at.getY() + ", " + at.getZ()).withStyle(ChatFormatting.GREEN));
		lastFinished = finished;
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
			return startBuildAt(level == null ? player.level() : level, placed, turned, player);
		}

		// Centred on the player and rising from the block they stand on, which is what
		// "put it here" means to someone looking at the ground. Centring is rotation-aware:
		// a quarter turn swaps the footprint's width and length, and centring on the
		// unrotated size slid a long building out from under the player who aimed it.
		Schematic schematic = awaitingPlacement.schematic();
		BlockPos origin =
				Footprint.origin(schematic.width(), schematic.length(), rotation, player.blockPosition());
		return startBuildAt(player.level(), origin, rotation, player);
	}

	/**
	 * Build at explicit coordinates.
	 *
	 * Exists so the console, a command block, or a player on a vanilla client can place a
	 * build without the interactive preview — and it is the only path an automated test can
	 * drive, since nothing else works without a human standing in the world.
	 */
	public String startBuildAt(ServerLevel level, BlockPos origin, Rotation rotation) {
		return startBuildAt(level, origin, rotation, null);
	}

	/** As above, remembering who asked, so their action bar is the one that shows progress. */
	public String startBuildAt(ServerLevel level, BlockPos origin, Rotation rotation, ServerPlayer by) {
		if (active != null) return "a build is already in progress";
		if (awaitingPlacement == null) return "no build is waiting — send one from the website first";

		PendingJob job = awaitingPlacement;
		awaitingPlacement = null;

		BuilderBot bot = BuilderBot.spawn(level, origin, job.name());
		BuildTask task = new BuildTask(level, job.schematic(), origin, rotation, bot, ModConfig.get().buildSpeed);

		active = new ActiveBuild(job.jobId(), task, bot, level, by == null ? null : by.getUUID());
		// A new build replaces the undo record: only the latest build can be undone.
		lastFinished = null;
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

	public boolean pauseActive() {
		// Not an undo: pause/resume speak "building" to the server, and a resumed undo reported
		// as building would put a job that is being torn down back on the website's progress bar.
		if (active == null || active.task.isFinished() || active.task.isPaused() || active.task.isUndoing()) return false;
		active.task.pause();
		report(active);
		broadcast(Component.literal("CraftMagic: build paused.").withStyle(ChatFormatting.YELLOW));
		return true;
	}

	public boolean resumeActive() {
		if (active == null || active.task.isFinished() || !active.task.isPaused()) return false;
		active.task.resume();
		report(active);
		broadcast(Component.literal("CraftMagic: build resumed.").withStyle(ChatFormatting.GREEN));
		return true;
	}

	/**
	 * Roll a build back, putting back what it replaced. Returns null on success, or why not.
	 *
	 * <p>{@code jobId} null is the in-game command, which means "the build in progress, or else
	 * the last one". A job id is the website, and then it must be exactly that job: undoing
	 * whatever happens to be active because <em>some</em> undo arrived would tear down a build
	 * nobody asked about.
	 */
	public String undo(String jobId) {
		if (active != null) {
			if (jobId != null && !active.jobId.equals(jobId)) {
				return "another build is in progress — wait for it to finish, or cancel it";
			}
			if (active.task.isUndoing()) return "that build is already being undone";
			active.task.startUndo();
			active.lastReported = -1;
			report(active);
			broadcast(Component.literal("CraftMagic: undoing build in reverse...").withStyle(ChatFormatting.GOLD));
			return null;
		}

		if (lastFinished == null || (jobId != null && !lastFinished.jobId.equals(jobId))) {
			return "this world only remembers its most recent build, and only until it restarts";
		}

		// The build's own bot is gone (despawned when it finished), so the undo gets a new one
		// and the task is pointed at it — driving the old one would move an entity that no
		// longer exists.
		ActiveBuild previous = lastFinished;
		lastFinished = null;
		BuilderBot bot = BuilderBot.spawn(previous.level, previous.task.lastChanged(), "Undo");
		previous.task.attachBot(bot);
		previous.task.startUndo();
		active = new ActiveBuild(previous.jobId, previous.task, bot, previous.level, previous.owner);
		ticksSinceReport = 0;
		report(active);
		broadcast(Component.literal("CraftMagic: undoing build in reverse...").withStyle(ChatFormatting.GOLD));
		return null;
	}

	public boolean cancelActive() {
		if (active == null) return false;
		active.task.cancel();
		finish();
		return true;
	}

	public void shutdown() {
		if (active != null) {
			active.bot.despawn();
			active = null;
		}
		for (RetiringBot r : retiring) r.bot.despawn();
		retiring.clear();
		lastFinished = null;
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
