-- An undo is a state of its own.
--
-- The mod can roll a finished build back, and the first version said nothing to the server
-- while it did: the row stayed `done`, so a progress stream opened for the undo replayed `done`
-- and closed at once, and the finished undo was then reported as `cancelled`, which the website
-- shows as an error. `undoing` is the job while blocks are being put back and `undone` is the
-- end of it.
--
-- A separate file rather than an edit to 010, because a migration is recorded by name once it
-- has run, and an edit to one that already ran anywhere would never reach that database.
ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_status_check;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_status_check CHECK (status IN (
  'pending','offered','previewing','building','paused','undoing','done','undone','cancelled','failed'
));

-- `undoing` occupies the agent the same way `building` does: the mod has one build slot, and
-- it is in use until the last block is put back.
DROP INDEX IF EXISTS agent_jobs_active_idx;
CREATE INDEX agent_jobs_active_idx ON agent_jobs(agent_id)
  WHERE status IN ('pending','offered','previewing','building','paused','undoing');
