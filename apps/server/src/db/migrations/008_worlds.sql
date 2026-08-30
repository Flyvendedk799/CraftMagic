-- Worlds: the table 007 said would have to exist.
--
-- A world is not a build with a different label. It has no voxels, no program and no block
-- count, and `builds.voxels` is NOT NULL — so a world was never a row that table could hold.
-- What a world has instead is a *description* that materialises into voxels one region at a
-- time, and a description has a shape of its own.
--
-- The heightfield goes in `bytea`, not in the json. It is the one part of a world that is
-- big: an `Int16Array` of heights and a `Uint8Array` of stratum indices, one entry each per
-- column, so a 1024² map is 3 MB. Written as a JSON array of numbers that becomes something
-- like 7 MB of decimal text per save, parsed on every read, and the whole point of describing
-- a world rather than storing it is that the description stays small. Two columns rather than
-- one interleaved blob because they are different widths and the client already holds them as
-- two arrays; splicing them together here would buy nothing and cost a decode on both sides.
--
-- Everything else — the strata palette, the sparse overlay of carved 16³ chunks, the
-- placements — is small, queryable and versioned by the client's own normaliser, so it lives
-- in one `doc` jsonb the same way `builds.plan` and `builds.edits` do. The server ferries it.
--
-- Extent and bounds are columns rather than json because the server has to know them without
-- reading the document: they are what says how long `heights` is supposed to be, and a blob
-- whose length disagrees with its stated size is a world that can never be read back.
CREATE TABLE worlds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable and ON DELETE CASCADE, matching `builds`: same owner column, same lifetime.
  -- No route mints a null owner, but the scoping predicate has to be able to express one.
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  size_x      int NOT NULL,
  size_z      int NOT NULL,
  min_y       int NOT NULL,
  max_y       int NOT NULL,
  sea_level   int NOT NULL,
  region_size int NOT NULL,
  -- Int16 little-endian, `size_x * size_z * 2` bytes. Signed because Minecraft y runs
  -- -64..320 and an unsigned height cannot name the floor of the world.
  heights     bytea NOT NULL,
  -- One byte per column, indexing the strata palette inside `doc`.
  strata      bytea NOT NULL,
  doc         jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The only listing there is: a user's own worlds, newest first. No partial predicate to
-- match `builds_library_idx` — a world is only ever written by an explicit save, so there
-- is no transport row to keep out of the list.
CREATE INDEX worlds_user_idx ON worlds(user_id, created_at DESC);
