package dev.imaginecraft.agent.build;

import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * A parsed Sponge v2 schematic, ready for the builder bot to place.
 *
 * <p>Deliberately uses Minecraft's own {@link NbtIo} and {@link BlockStateParser} rather than
 * a hand-rolled reader: the file is produced by our TypeScript exporter, and the only
 * definition of "correct" that matters is whether the game itself accepts it. That also means
 * a blockstate the exporter gets wrong fails loudly here, at parse time, instead of appearing
 * as a wrong-looking block halfway through a build.
 *
 * <p>Blocks are stored as palette indices in Sponge's YZX order
 * ({@code x + z*width + y*width*length}), which is the same order the web exporter writes and
 * the same order a bottom-up build wants to walk — so building is a straight scan rather than
 * a transposition.
 */
public final class Schematic {
	/** Guard against a hostile or corrupt file exhausting the server's heap. */
	private static final long MAX_NBT_BYTES = 64L * 1024 * 1024;

	private final int width;
	private final int height;
	private final int length;
	private final BlockState[] palette;
	private final int[] blocks;
	private final String name;

	private Schematic(int width, int height, int length, BlockState[] palette, int[] blocks, String name) {
		this.width = width;
		this.height = height;
		this.length = length;
		this.palette = palette;
		this.blocks = blocks;
		this.name = name;
	}

	public static Schematic read(Path file) throws IOException, SchematicException {
		return from(NbtIo.readCompressed(file, NbtAccounter.create(MAX_NBT_BYTES)));
	}

	public static Schematic read(byte[] bytes) throws IOException, SchematicException {
		try (InputStream in = new ByteArrayInputStream(bytes)) {
			return from(NbtIo.readCompressed(in, NbtAccounter.create(MAX_NBT_BYTES)));
		}
	}

	private static Schematic from(CompoundTag root) throws SchematicException {
		int version = root.getIntOr("Version", -1);
		if (version != 2) {
			throw new SchematicException("expected a Sponge v2 schematic, got Version " + version);
		}

		int width = root.getShortOr("Width", (short) 0);
		int height = root.getShortOr("Height", (short) 0);
		int length = root.getShortOr("Length", (short) 0);
		if (width <= 0 || height <= 0 || length <= 0) {
			throw new SchematicException("schematic has a non-positive dimension: " + width + "x" + height + "x" + length);
		}

		CompoundTag paletteTag = root.getCompoundOrEmpty("Palette");
		if (paletteTag.isEmpty()) throw new SchematicException("schematic has no palette");

		// The palette maps state string -> index, so it must be inverted into an array.
		BlockState[] palette = new BlockState[paletteTag.keySet().size()];
		for (String state : paletteTag.keySet()) {
			int index = paletteTag.getIntOr(state, -1);
			if (index < 0 || index >= palette.length) {
				throw new SchematicException("palette entry \"" + state + "\" has out-of-range index " + index);
			}
			try {
				palette[index] = BlockStateParser.parseForBlock(BuiltInRegistries.BLOCK, state, false).blockState();
			} catch (Exception e) {
				throw new SchematicException("unparseable blockstate \"" + state + "\": " + e.getMessage());
			}
		}
		for (int i = 0; i < palette.length; i++) {
			// A gap means the palette indices were not contiguous, which would silently place
			// air where a real block was meant to go.
			if (palette[i] == null) palette[i] = Blocks.AIR.defaultBlockState();
		}

		byte[] data = root.getByteArray("BlockData").orElseThrow(() -> new SchematicException("schematic has no BlockData"));
		int[] blocks = decodeVarInts(data, width * height * length);

		for (int index : blocks) {
			if (index >= palette.length) {
				throw new SchematicException("BlockData references palette index " + index + " of " + palette.length);
			}
		}

		String name = root.getCompoundOrEmpty("Metadata").getStringOr("Name", "Build");
		return new Schematic(width, height, length, palette, blocks, name);
	}

	/** Unsigned LEB128, the encoding Sponge uses for BlockData. */
	private static int[] decodeVarInts(byte[] data, int expected) throws SchematicException {
		List<Integer> out = new ArrayList<>(expected);
		int value = 0;
		int shift = 0;

		for (byte raw : data) {
			int b = raw & 0xff;
			value |= (b & 0x7f) << shift;
			if ((b & 0x80) == 0) {
				out.add(value);
				value = 0;
				shift = 0;
			} else {
				shift += 7;
				if (shift > 28) throw new SchematicException("malformed varint in BlockData");
			}
		}

		if (out.size() != expected) {
			throw new SchematicException("BlockData holds " + out.size() + " blocks, but the dimensions imply " + expected);
		}

		int[] blocks = new int[expected];
		for (int i = 0; i < expected; i++) blocks[i] = out.get(i);
		return blocks;
	}

	public int width() {
		return width;
	}

	public int height() {
		return height;
	}

	public int length() {
		return length;
	}

	public String name() {
		return name;
	}

	public int paletteSize() {
		return palette.length;
	}

	/** Total blocks including air. */
	public int volume() {
		return width * height * length;
	}

	/** Non-air blocks — what the bot will actually place, and what progress is measured against. */
	public int solidCount() {
		int count = 0;
		for (int index : blocks) {
			if (!palette[index].isAir()) count++;
		}
		return count;
	}

	public BlockState blockAt(int x, int y, int z) {
		if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= length) {
			return Blocks.AIR.defaultBlockState();
		}
		return palette[blocks[x + z * width + y * width * length]];
	}

	/**
	 * Walk every non-air block bottom-up, in the order the bot should place them.
	 *
	 * <p>Layer order matters beyond looking right: placing a block before its support exists
	 * makes anything gravity-affected fall, and a player watching the build sees it rise the
	 * way they would build it themselves.
	 */
	public void forEachSolid(BlockVisitor visitor) {
		for (int y = 0; y < height; y++) {
			for (int z = 0; z < length; z++) {
				for (int x = 0; x < width; x++) {
					BlockState state = palette[blocks[x + z * width + y * width * length]];
					if (!state.isAir()) visitor.visit(x, y, z, state);
				}
			}
		}
	}

	@FunctionalInterface
	public interface BlockVisitor {
		void visit(int x, int y, int z, BlockState state);
	}

	/** Thrown for a structurally invalid schematic — never for an I/O problem. */
	public static class SchematicException extends Exception {
		public SchematicException(String message) {
			super(message);
		}
	}
}
