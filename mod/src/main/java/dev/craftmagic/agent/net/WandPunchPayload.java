package dev.craftmagic.agent.net;

import dev.craftmagic.agent.CraftMagicMod;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.ResourceLocation;

/**
 * "I swung the wand at nothing."
 *
 * <p>Punching a <em>block</em> or a mob reaches the server on its own — vanilla sends those,
 * and Fabric surfaces them as {@code AttackBlockCallback} / {@code AttackEntityCallback}.
 * Punching <em>air</em> does not: the client sends only a swing animation, and there is no
 * server-side event for it. So the modded client says so explicitly, and this is the message.
 *
 * <p>It carries nothing. Who punched is the connection, when is now, and <em>where</em> is
 * the anchor the server already stored — deliberately, so a modified client cannot claim to
 * have marked a spot it never marked. The empty body is the security property.
 */
public record WandPunchPayload() implements CustomPacketPayload {
	public static final CustomPacketPayload.Type<WandPunchPayload> TYPE =
			new CustomPacketPayload.Type<>(
					ResourceLocation.fromNamespaceAndPath(CraftMagicMod.MOD_ID, "wand_punch"));

	/** No fields, so decoding is a constant rather than a read. */
	public static final StreamCodec<FriendlyByteBuf, WandPunchPayload> CODEC =
			StreamCodec.unit(new WandPunchPayload());

	@Override
	public CustomPacketPayload.Type<WandPunchPayload> type() {
		return TYPE;
	}
}
