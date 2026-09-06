-- Which region of which map a job is, written down where a restart can find it.
--
-- A world reaches Minecraft as a run of ordinary build jobs, one per region, and the run has
-- an order: region 0 is placed by a player and reports the corner it was built from, and every
-- region after it is measured from that report. Until now the two facts that ordering needs —
-- which world a job belongs to, and where region 0 landed — lived only in the hub's memory.
-- The anchor itself was already persisted (`agent_jobs.anchor`, from the mod's first progress
-- frame), but nothing said *which world* a row was region 0 of, so a server restarted between
-- region 3 and region 4 of a sixteen-region map had a database full of the answer and no way
-- to ask it. The remaining regions were then refused with "region 0 has not reported", which
-- was false, and the user was told to start the map again.
--
-- The job's region metadata (the client's `JobRegion`, minus the anchor — that is the server's
-- to add) rides here as jsonb, the same ferry-don't-interpret deal `builds.plan` has. NULL on
-- every lone build, which is almost every job.
ALTER TABLE agent_jobs ADD COLUMN region jsonb;

-- The one question asked of it: "the latest region 0 of this world". Partial, because lone
-- builds outnumber regions and would only pad the index.
CREATE INDEX agent_jobs_world_idx
  ON agent_jobs ((region->>'worldId'), created_at DESC)
  WHERE region IS NOT NULL;
