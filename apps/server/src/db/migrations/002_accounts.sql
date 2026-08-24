-- Accounts, sessions and the build library.
--
-- 001 already declared `users`, `sessions` and a nullable `builds.user_id`, so ownership
-- needs no new columns. What it could not anticipate is the difference between the two
-- reasons a build gets written:
--
--   * "Send to game" writes one row per click, because the mod fetches the build by id over
--     HTTPS and the browser is not reachable from a Minecraft server. Those rows are the
--     transport, not the user's work.
--   * "Save to library" writes a row the user expects to find again.
--
-- Without a flag the library would fill with a duplicate of every build ever sent to a
-- world, which is the same failure as having no library at all.

ALTER TABLE builds ADD COLUMN in_library boolean NOT NULL DEFAULT false;

-- Partial rather than plain: the library only ever reads the flagged rows, and the send-to-
-- game rows outnumber them by however many times a build was sent.
CREATE INDEX builds_library_idx ON builds(user_id, created_at DESC) WHERE in_library;

-- Expired sessions are swept on a timer rather than left to accumulate. Without this index
-- that sweep is a sequential scan over a table that only grows, on a schedule.
CREATE INDEX sessions_expires_idx ON sessions(expires_at);
