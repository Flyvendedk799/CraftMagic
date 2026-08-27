-- Per-account Claude subscription credentials.
--
-- The first version of the subscription provider read the one `claude` login on the server's
-- machine, which meant every visitor's generation was billed to whoever set the server up.
-- This is what makes it per person: an account signs in to its own Claude plan and its own
-- generations come out of that plan.
--
-- One row per user, not a history. A second login replaces the first, because "which
-- credential is in force" has exactly one answer and keeping the old ones would be keeping
-- live credentials nothing will ever use.
--
-- `payload` is the same AES-256-GCM envelope the settings table uses — `iv:tag:ciphertext`,
-- keyed off SESSION_SECRET. A refresh token is a long-lived credential that can spend
-- somebody's plan, and a database dump is a far more ordinary accident than a compromised
-- host. Rotating SESSION_SECRET makes these unreadable, which reads as "signed out" and is
-- the right failure: the user signs in again and nothing is silently wrong.
CREATE TABLE claude_oauth (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload     text NOT NULL,
  -- Denormalised out of the payload so the "which plan is this" line on the settings page
  -- costs a read rather than a decrypt.
  plan        text,
  -- Unix ms of the access token's expiry. Also outside the envelope, so a status check can
  -- say "expired" without touching the cipher.
  expires_at  bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
