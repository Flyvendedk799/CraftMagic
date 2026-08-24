/**
 * Deploy CraftMagic to the VPS.
 *
 * Builds locally and ships `dist` output plus the lockfile, rather than building on the
 * server: tsc and vite emit platform-independent JavaScript, while `argon2` is a native
 * module whose Windows binary is useless on Linux. So the JavaScript travels and the
 * dependencies are installed fresh on the far side.
 *
 *   node tools/deploy.mjs [--skip-build]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'administrator@85.190.100.23';
const KEY = 'C:/Users/tobia/.ssh/serverhoster_key';
const ORIGIN = 'http://85.190.100.23:3016';

const skipBuild = process.argv.includes('--skip-build');

function run(label, file, args, opts = {}) {
  process.stdout.write(`${label}… `);
  const result = spawnSync(file, args, { cwd: root, encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    console.log('failed');
    console.error(result.stdout ?? '');
    console.error(result.stderr ?? '');
    process.exit(1);
  }
  console.log('ok');
  return result.stdout ?? '';
}

// --- build -------------------------------------------------------------------------------
if (!skipBuild) {
  run('building', 'npm.cmd', ['run', 'build'], { stdio: ['ignore', 'pipe', 'pipe'] });
} else {
  console.log('skipping build');
}

// The mod jar is NOT bundled here. It lives in `apps/web/public/mod` as a committed artifact
// and vite copies it into `dist` during the build, because Gradle and a JDK 25 are not
// available everywhere this deploys from. Rebuilding the mod is a separate, deliberate step:
// `gradlew build` then `node tools/bundle-mod.mjs`, then commit.
for (const required of ['packages/core/dist', 'apps/server/dist', 'apps/web/dist']) {
  if (!fs.existsSync(path.join(root, required))) {
    console.error(`missing ${required} — build first`);
    process.exit(1);
  }
}

// The migration runner reads this directory at boot; if the copy-assets step regressed, the
// database would come up with no tables and every route would fail at runtime instead of here.
const migrations = path.join(root, 'apps/server/dist/db/migrations');
const sqlCount = fs.existsSync(migrations)
  ? fs.readdirSync(migrations).filter((f) => f.endsWith('.sql')).length
  : 0;
if (sqlCount === 0) {
  console.error('apps/server/dist/db/migrations has no .sql files — copy-assets did not run');
  process.exit(1);
}
console.log(`bundling ${sqlCount} migration(s)`);

// --- package ----------------------------------------------------------------------------
const staging = path.join(root, 'out');
fs.mkdirSync(staging, { recursive: true });
const tarball = path.join(staging, 'craftmagic.tgz');

// GNU tar reads a leading `C:` as a remote host:path spec, so an absolute Windows path makes
// it try to reach a machine called "C". Everything runs with cwd at the repo root, so the
// archive is addressed relatively and never contains a drive letter.
const tarballRelative = 'out/craftmagic.tgz';

run('packaging', 'tar', [
  'czf', tarballRelative,
  'package.json', 'package-lock.json',
  'packages/core/package.json', 'packages/core/dist',
  'apps/server/package.json', 'apps/server/dist',
  'apps/web/package.json', 'apps/web/dist',
]);
console.log(`  ${(fs.statSync(tarball).size / 1048576).toFixed(1)} MB`);

// --- ship -------------------------------------------------------------------------------
// The database password lives in the scratchpad from provisioning; regenerating it here would
// lock the app out of its own database.
const passwordFile = path.join(root, 'out', 'db-password.txt');
if (!fs.existsSync(passwordFile)) {
  console.error(`missing ${passwordFile} — the database password from provisioning goes here`);
  process.exit(1);
}

const stamp = crypto.randomBytes(6).toString('hex');
const remoteTar = `/tmp/cm-${stamp}.tgz`;
const remotePw = `/tmp/cm-${stamp}.pw`;
const remoteScript = `/tmp/cm-${stamp}-setup.sh`;

// Relative for the same reason as tar: scp splits on `:` to find a host, so a drive letter
// makes it look for a machine named "C".
run('uploading', 'scp', [
  '-i', KEY, '-o', 'ConnectTimeout=20',
  tarballRelative, 'out/db-password.txt', 'tools/deploy/remote-setup.sh',
  `${HOST}:/tmp/`,
]);

run('staging', 'ssh', ['-i', KEY, HOST,
  `mv /tmp/${path.basename(tarball)} ${remoteTar} && ` +
  `mv /tmp/db-password.txt ${remotePw} && chmod 600 ${remotePw} && ` +
  `mv /tmp/remote-setup.sh ${remoteScript}`,
]);

console.log('\n--- remote setup ---');
const setup = spawnSync('ssh', ['-i', KEY, HOST,
  `sudo bash ${remoteScript} ${remoteTar} ${remotePw}; rc=$?; ` +
  `shred -u ${remotePw} 2>/dev/null || rm -f ${remotePw}; rm -f ${remoteTar} ${remoteScript}; exit $rc`,
], { cwd: root, encoding: 'utf8', stdio: 'inherit' });

if (setup.status !== 0) {
  console.error('\ndeploy failed');
  process.exit(1);
}

// --- verify from the outside --------------------------------------------------------------
// The remote script already checked health over loopback. This checks the same thing over the
// public internet, which is the only path that matters: a mod running on the user's home PC
// reaches this server the same way.
console.log('\n--- reachability from here ---');
let ok = true;
for (const [label, url] of [
  ['health', `${ORIGIN}/api/health`],
  ['web app', ORIGIN],
]) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const body = (await response.text()).slice(0, 160);
    console.log(`  ${response.ok ? 'PASS' : 'FAIL'}  ${label} — ${response.status} ${body.replace(/\s+/g, ' ')}`);
    if (!response.ok) ok = false;
  } catch (err) {
    console.log(`  FAIL  ${label} — ${err.message}`);
    ok = false;
  }
}

console.log(ok ? `\ndeployed — ${ORIGIN}` : '\ndeployed, but not reachable from here');
process.exitCode = ok ? 0 : 1;
