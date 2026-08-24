package dev.imaginecraft.agent.client;

import net.fabricmc.api.ClientModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Client entrypoint.
 *
 * <p>Deliberately thin. The client's only jobs are drawing the placement hologram, handling
 * the anchor keybinds, and showing toasts — everything that decides what actually gets
 * placed stays on the server, so a modified client cannot build past the safety limits.
 *
 * <p>Lives in {@code src/client}, which Loom's split source sets keep off the dedicated
 * server's classpath entirely.
 */
public class ImagineCraftClient implements ClientModInitializer {
	public static final Logger LOGGER = LoggerFactory.getLogger("imaginecraft-client");

	@Override
	public void onInitializeClient() {
		// TODO(M4): register keybinds (place/rotate/confirm/cancel) and the preview renderer.
		LOGGER.info("ImagineCraft client ready");
	}
}
