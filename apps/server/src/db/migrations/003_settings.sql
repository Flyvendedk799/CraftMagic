-- Runtime settings, and who may change them.
--
-- The AI provider and its API key used to come only from the environment, which meant
-- changing either required an SSH session and a redeploy. They now live here so an admin can
-- set them from the site, with the environment kept as a fallback for a fresh install.
--
-- Values are stored encrypted, not in the clear: this table holds a credential that can spend
-- money, and a database dump is a far more ordinary accident than a compromised host. The
-- application encrypts before writing and decrypts on read; Postgres never sees the plaintext.

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  -- Encrypted values are opaque, so something has to say which ones they are. Without this
  -- the read path would have to guess from the shape of the string.
  is_secret   boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);

-- Admin is a property of an account, not a separate login. A second credential to protect is
-- a second credential to leak, and the useful question is "is this signed-in person allowed
-- to change the key", which this answers directly.
ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- The first account to register becomes the admin.
--
-- Deliberate: on a fresh install there is nobody to grant it, and the alternative is a
-- bootstrap password in the environment — one more secret, and one that tends to stay at its
-- default. Whoever stands the server up registers first. Existing installs have their oldest
-- account promoted here, which is the same person.
UPDATE users
   SET is_admin = true
 WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1);
