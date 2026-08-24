-- Initial schema.
--
-- Two conventions worth stating once:
--   * Secrets are stored as SHA-256 digests, never as the value itself. A leaked database
--     must not hand out working session cookies or agent tokens.
--   * Voxels live in `bytea` while the program lives in `jsonb`. The program is the thing
--     you query and re-expand; the voxels are an opaque cache of one expansion of it.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  password_hash text NOT NULL,
  -- A per-user cap so one account cannot drain the shared API balance.
  daily_gen_quota int NOT NULL DEFAULT 30,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE builds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Null until accounts exist; a build made before signing in still needs somewhere to live.
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  size_x      int NOT NULL,
  size_y      int NOT NULL,
  size_z      int NOT NULL,
  block_count int NOT NULL,
  -- The program is nullable because a build can also arrive as raw voxels (an import), in
  -- which case there is nothing parametric to re-expand.
  program     jsonb,
  voxels      bytea NOT NULL,
  -- Set once a build has been hand-edited, so re-expanding its program is known to be lossy.
  detached    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX builds_user_idx ON builds(user_id, created_at DESC);

CREATE TABLE generations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  build_id      uuid REFERENCES builds(id) ON DELETE SET NULL,
  prompt        text NOT NULL,
  status        text NOT NULL CHECK (status IN (
                  'queued','streaming','validating','repairing',
                  'succeeded','succeeded_with_omissions','failed')),
  model         text,
  input_tokens  int,
  output_tokens int,
  cost_usd      numeric(10, 6),
  program       jsonb,
  error         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX generations_user_idx ON generations(user_id, created_at DESC);

CREATE TABLE agents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   bytea UNIQUE NOT NULL,
  env_type     text CHECK (env_type IN ('integrated','dedicated')),
  mc_version   text,
  mod_version  text,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_user_idx ON agents(user_id);

CREATE TABLE pair_codes (
  code       char(6) PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  agent_id   uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  build_id        uuid NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  status          text NOT NULL CHECK (status IN (
                    'pending','offered','previewing','building','done','cancelled','failed')),
  progress_placed int NOT NULL DEFAULT 0,
  progress_total  int NOT NULL DEFAULT 0,
  anchor          jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_jobs_agent_idx ON agent_jobs(agent_id, created_at DESC);
-- One active job per agent is enforced in code; this index makes that check cheap.
CREATE INDEX agent_jobs_active_idx ON agent_jobs(agent_id)
  WHERE status IN ('pending','offered','previewing','building');
