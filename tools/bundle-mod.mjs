/**
 * Copy the built Fabric mod into `apps/web/public` so the site can hand it to visitors.
 *
 * "Send to game" tells a player to run `/craftmagic pair ABC123`, which is useless until they
 * have the mod — so the jar has to be downloadable from the site itself.
 *
 * It lands in `public/` (committed) rather than `dist/` (generated) on purpose. The jar is
 * built by Gradle with a JDK 25, and the deployment path — a Docker image built by
 * ServerHoster from the repo — has no JVM at all. Treating the jar as a committed release
 * artifact is what lets the server build without a Java toolchain. It is the one binary in the
 * repo, it is ~500 KB, and it changes only when the mod does.
 *
 * Run this after `gradlew build` in `mod/`, then commit the result.
 *
 *   node tools/bundle-mod.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const libs = path.join(root, 'mod/build/libs');
const outDir = path.join(root, 'apps/web/public/mod');

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

// A stable filename so the download link never changes, plus a manifest carrying the real
// version — the page needs something to display and the player needs to know what they got.
const stableName = 'craftmagic-mod.jar';
fs.copyFileSync(path.join(libs, jar.name), path.join(outDir, stableName));

const version = /-(\d+\.\d+\.\d+)\.jar$/.exec(jar.name)?.[1] ?? 'unknown';
const manifest = {
  file: `/mod/${stableName}`,
  originalName: jar.name,
  version,
  minecraft: '26.2',
  loader: 'fabric',
  loaderVersion: '0.19.3',
  java: 25,
  bytes: jar.stat.size,
  builtAt: jar.stat.mtime.toISOString(),
};
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `bundled ${jar.name} → apps/web/public/mod/${stableName} ` +
    `(${(jar.stat.size / 1024).toFixed(0)} KB, v${version}) — commit this`,
);
