-- Allow 'paused' status on agent_jobs for bot pause/resume controls.
ALTER TABLE agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_status_check;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_status_check CHECK (status IN (
  'pending','offered','previewing','building','paused','done','cancelled','failed'
));

DROP INDEX IF EXISTS agent_jobs_active_idx;
CREATE INDEX agent_jobs_active_idx ON agent_jobs(agent_id)
  WHERE status IN ('pending','offered','previewing','building','paused');
