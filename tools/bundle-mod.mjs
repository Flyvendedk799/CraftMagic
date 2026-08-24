/**
 * Copy the built Fabric mod into the web output so the site can hand it to visitors.
 *
 * "Send to game" tells a player to run `/imaginecraft pair ABC123`, which is useless until
 * they have the mod — and there was no link anywhere that gave it to them. The jar is a build
 * artifact of a different toolchain (Gradle, outside the npm workspaces), so rather than
 * committing a binary it gets copied into `apps/web/dist` at package time and served as a
 * static file by the same handler that serves the app.
 *
 *   node tools/bundle-mod.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const libs = path.join(root, 'mod/build/libs');
const outDir = path.join(root, 'apps/web/dist/mod');

if (!fs.existsSync(libs)) {
  console.error('mod/build/libs missing — run `gradlew build` in mod/ first');
  process.exit(1);
}

// `-sources` and `-dev` jars are build by-products; the loadable mod is the plain one.
const jars = fs
  .readdirSync(libs)
  .filter((f) => f.endsWith('.jar') && !/-(sources|dev|shadow)\.jar$/.test(f))
  .map((f) => ({ name: f, stat: fs.statSync(path.join(libs, f)) }))
  .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

if (jars.length === 0) {
  console.error(`no loadable jar in ${libs}`);
  process.exit(1);
}

const jar = jars[0];
fs.mkdirSync(outDir, { recursive: true });

// A stable filename so the download link never has to change, plus a manifest carrying the
// real version — the UI needs something to display and the player needs to know what they got.
const stableName = 'imaginecraft-mod.jar';
fs.copyFileSync(path.join(libs, jar.name), path.join(outDir, stableName));

const version = /-(\d+\.\d+\.\d+)\.jar$/.exec(jar.name)?.[1] ?? 'unknown';
const manifest = {
  file: `/mod/${stableName}`,
  originalName: jar.name,
  version,
  minecraft: '26.2',
  loader: 'fabric',
  bytes: jar.stat.size,
  builtAt: jar.stat.mtime.toISOString(),
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`bundled ${jar.name} → apps/web/dist/mod/${stableName} (${(jar.stat.size / 1024).toFixed(0)} KB, v${version})`);
