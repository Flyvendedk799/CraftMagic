package dev.craftmagic.agent.wand;

import net.minecraft.ChatFormatting;
import net.minecraft.core.component.DataComponents;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.CustomData;
import net.minecraft.world.item.component.ItemLore;

import java.util.List;

/**
 * The magic wand — a stick, deliberately.
 *
 * <p>Not a registered item. A registered item would need a model, a texture, a lang entry and
 * a creative tab, and — the part that matters — it would render as a missing-model cube for
 * every <em>vanilla</em> client on a dedicated server, the same people the {@link
 * dev.craftmagic.agent.build.BuilderBot} armor stand exists to keep in the loop. A stick
 * carrying data components is a real, ordinary item everywhere: it stacks, it survives death
 * and inventory sync, and a vanilla client draws it correctly with no mod installed.
 *
 * <p>Identity lives in {@code minecraft:custom_data} rather than the name, so renaming a stick
 * on an anvil does not mint a wand. That is tidiness, not security: the wand grants nothing
 * {@code /craftmagic build} does not already give every player in a paired world.
 */
public final class WandItem {
	/**
	 * The marker key inside {@code custom_data}.
	 *
	 * <p>Presence is the whole test — read with {@code contains} rather than a typed getter,
	 * because the NBT accessors have changed shape across versions while {@code contains(String)}
	 * has not.
	 */
	private static final String WAND_TAG = "CraftMagicWand";

	private WandItem() {
	}

	/** A fresh wand, ready to hand to a player. */
	public static ItemStack create() {
		ItemStack stack = new ItemStack(Items.STICK);

		CompoundTag marker = new CompoundTag();
		marker.putBoolean(WAND_TAG, true);
		stack.set(DataComponents.CUSTOM_DATA, CustomData.of(marker));

		// withItalic(false): a custom name is italic by default, which reads as "renamed on an
		// anvil" rather than "this is a tool with rules".
		stack.set(
				DataComponents.CUSTOM_NAME,
				Component.literal("CraftMagic Wand")
						.withStyle(style -> style.withColor(ChatFormatting.LIGHT_PURPLE).withItalic(false)));

		// The controls live on the item because that is where someone looks when they have
		// forgotten them, which is every time after the first session.
		stack.set(
				DataComponents.LORE,
				new ItemLore(List.of(
						Component.literal("Right-click — mark the spot").withStyle(ChatFormatting.GRAY),
						Component.literal("Sneak + right-click — turn it 90°").withStyle(ChatFormatting.GRAY),
						Component.literal("Punch the air — build it").withStyle(ChatFormatting.GRAY))));

		stack.set(DataComponents.ENCHANTMENT_GLINT_OVERRIDE, true);
		return stack;
	}

	/** Is this the wand, as opposed to any other stick? */
	public static boolean isWand(ItemStack stack) {
		if (stack == null || stack.isEmpty() || !stack.is(Items.STICK)) return false;
		CustomData data = stack.get(DataComponents.CUSTOM_DATA);
		return data != null && data.copyTag().contains(WAND_TAG);
	}
}
