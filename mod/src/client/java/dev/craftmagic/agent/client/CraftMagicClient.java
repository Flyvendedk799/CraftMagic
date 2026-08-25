package dev.craftmagic.agent.client;

import dev.craftmagic.agent.net.WandPunchPayload;
import dev.craftmagic.agent.wand.WandItem;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.event.client.player.ClientPreAttackCallback;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.minecraft.world.InteractionHand;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Client entrypoint.
 *
 * <p>Deliberately thin. Everything that decides what actually gets placed stays on the
 * server, so a modified client cannot build past the safety limits — the client's only job
 * here is to report a gesture the vanilla protocol throws away.
 *
 * <p>Lives in {@code src/client}, which Loom's split source sets keep off the dedicated
 * server's classpath entirely.
 */
public class CraftMagicClient implements ClientModInitializer {
	public static final Logger LOGGER = LoggerFactory.getLogger("craftmagic-client");

	@Override
	public void onInitializeClient() {
		registerWandPunch();
		LOGGER.info("CraftMagic client ready");
	}

	/**
	 * Turn "swing the wand at nothing" into a packet.
	 *
	 * <p>Punching a block or a mob already reaches the server, and {@link
	 * dev.craftmagic.agent.wand.WandHandler} handles both. Punching <em>air</em> is the gap:
	 * vanilla sends a swing animation and nothing else, and there is no server-side event for
	 * it. This is the one thing the client has to say out loud.
	 *
	 * <p>It says only "I punched" — never where. The server already knows where, because the
	 * server is what stored the mark.
	 */
	private static void registerWandPunch() {
		ClientPreAttackCallback.EVENT.register((client, player, clickCount) -> {
			if (!WandItem.isWand(player.getMainHandItem())) return false;

			// A server without the mod — or an older one — cannot read the payload. Hand the
			// click back to vanilla rather than swallowing it: silently disabling left-click
			// on a stick would look like the game had broken.
			if (!ClientPlayNetworking.canSend(WandPunchPayload.TYPE)) return false;

			// clickCount is 0 on the ticks where the button is merely still down. Sending on
			// those would be forty builds a second; the server's cooldown would eat them, but
			// the packets would still be sent.
			if (clickCount > 0) {
				ClientPlayNetworking.send(new WandPunchPayload());
				// Swing anyway, so the gesture looks like it landed. Purely cosmetic — the
				// server ignores the animation.
				player.swing(InteractionHand.MAIN_HAND);
			}

			// Cancel the vanilla attack in every case, including the held-button ticks: the
			// wand must never break a block (instantly, in creative) or hit a mob.
			return true;
		});
	}
}
