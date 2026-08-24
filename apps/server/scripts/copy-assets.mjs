/**
 * Copy non-TypeScript assets into `dist`.
 *
 * `tsc` only emits what it compiles, so `.sql` migrations stayed in `src` and the migration
 * runner found an empty directory and did nothing — the database came up with only its
 * bookkeeping table and every agent route failed at runtime with no error at build time.
 * That silence is the reason this exists as a build step rather than a README note.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const copies = [{ from: 'src/db/migrations', to: 'dist/db/migrations', ext: '.sql' }];

let copied = 0;
for (const { from, to, ext } of copies) {
	const source = path.join(root, from);
	if (!fs.existsSync(source)) continue;

	const target = path.join(root, to);
	fs.mkdirSync(target, { recursive: true });

	for (const file of fs.readdirSync(source)) {
		if (!file.endsWith(ext)) continue;
		fs.copyFileSync(path.join(source, file), path.join(target, file));
		copied++;
	}
}

console.log(`copied ${copied} asset file(s) into dist`);
