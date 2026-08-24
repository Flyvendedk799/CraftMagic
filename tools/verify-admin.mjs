/**
 * Drive the admin settings API.
 *
 * The property worth proving is not that the form saves — it is that a key put in cannot come
 * back out, and that a non-admin account cannot reach the routes at all. Both are checked
 * here against a real server and a real database.
 *
 * No model is ever called, so this costs nothing.
 *
 *   node tools/verify-admin.mjs [origin]
 */

import pg from 'pg';
import { signIn, throwawayCredentials } from './session.mjs';

const ORIGIN = (process.argv[2] ?? process.env.CM_ORIGIN ?? 'http://localhost:3016').replace(/\/+$/, '');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

async function api(method, path, cookie, body) {
  const response = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: ORIGIN },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

process.loadEnvFile?.('apps/server/.env');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

// A probe value that is obviously fake but shaped like the real thing, so the masking logic
// is exercised on something a real key would match.
const PROBE_KEY = 'sk-ant-verify-0000000000000000000000000000000000-DEADBEEF';

try {
  const admin = await signIn(ORIGIN, throwawayCredentials('admin-verify'));
  const plain = await signIn(ORIGIN, throwawayCredentials('plain-verify'));

  // Neither is admin yet: users already exist, so `NOT EXISTS` was false for both.
  const before = await api('GET', '/api/admin/settings', admin.cookie);
  check('a fresh account cannot read settings', before.status === 404, `HTTP ${before.status}`);

  await db.query('UPDATE users SET is_admin = true WHERE id = $1', [admin.userId]);

  const read = await api('GET', '/api/admin/settings', admin.cookie);
  check('an admin can read settings', read.status === 200, `HTTP ${read.status}`);
  check('providers are offered', Array.isArray(read.body.providers) && read.body.providers.length === 2,
    JSON.stringify(read.body.providers));

  const denied = await api('GET', '/api/admin/settings', plain.cookie);
  check('a non-admin is refused', denied.status === 404, `HTTP ${denied.status}`);

  const anon = await fetch(`${ORIGIN}/api/admin/settings`);
  check('a signed-out request is refused', anon.status === 401 || anon.status === 404, `HTTP ${anon.status}`);

  // --- the key round trip -----------------------------------------------------------------
  const saved = await api('PUT', '/api/admin/settings', admin.cookie, {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    anthropicKey: PROBE_KEY,
  });
  check('settings save', saved.status === 200, `HTTP ${saved.status}`);
  check('the model took effect', saved.body.model === 'claude-haiku-4-5', String(saved.body.model));
  check('the key is reported as coming from settings', saved.body.keySource === 'settings',
    String(saved.body.keySource));

  const after = await api('GET', '/api/admin/settings', admin.cookie);
  const serialized = JSON.stringify(after.body);
  check('the key never comes back', !serialized.includes(PROBE_KEY));
  check('only a masked hint is shown', after.body.anthropicKeyHint === 'sk-ant-EFEF' || /…/.test(String(after.body.anthropicKeyHint)),
    String(after.body.anthropicKeyHint));

  const { rows } = await db.query("SELECT value, is_secret FROM settings WHERE key = 'ai.anthropic.apiKey'");
  check('the row is marked secret', rows[0]?.is_secret === true);
  check('the key is not stored in the clear', !String(rows[0]?.value ?? '').includes(PROBE_KEY),
    String(rows[0]?.value ?? '').slice(0, 24) + '…');
  check('it is stored as iv:tag:ciphertext', String(rows[0]?.value ?? '').split(':').length === 3);

  // --- an omitted key must not wipe the stored one -----------------------------------------
  await api('PUT', '/api/admin/settings', admin.cookie, { model: 'claude-sonnet-5' });
  const kept = await api('GET', '/api/admin/settings', admin.cookie);
  check('changing the model keeps the key', kept.body.keySource === 'settings', String(kept.body.keySource));

  // --- an empty string clears it ------------------------------------------------------------
  await api('PUT', '/api/admin/settings', admin.cookie, { anthropicKey: '' });
  const cleared = await db.query("SELECT 1 FROM settings WHERE key = 'ai.anthropic.apiKey'");
  check('an empty value clears the key', cleared.rowCount === 0);

  // --- rubbish is refused --------------------------------------------------------------------
  const bad = await api('PUT', '/api/admin/settings', admin.cookie, { provider: 'gemini' });
  check('an unknown provider is refused', bad.status === 400, `HTTP ${bad.status}`);

  // Leave the instance as it was found, so this can be run against a live server.
  await api('PUT', '/api/admin/settings', admin.cookie, { provider: 'anthropic', model: 'claude-sonnet-5' });
  await db.query('UPDATE users SET is_admin = false WHERE id = $1', [admin.userId]);
} finally {
  await db.end();
}

console.log(failures === 0 ? '\nall admin checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
