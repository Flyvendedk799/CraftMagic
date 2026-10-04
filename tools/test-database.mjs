/** Disposable PostgreSQL-WASM test database. This is a test-only adapter, not the production database. */
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';
const db = await PGlite.create({ extensions: { citext } });
const port = Number(process.env.CM_TEST_DB_PORT ?? 55439);
const server = new PGLiteSocketServer({
  db,
  host: '127.0.0.1',
  port,
  maxConnections: 16,
});
await server.start();
const env = {
  ...process.env,
  DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
};
let child;
try {
  const command = process.argv.slice(2);
  child = command.length
    ? spawn(command[0], command.slice(1), {
        env,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
    : spawn(
        process.execPath,
        [
          '../../node_modules/vitest/vitest.mjs',
          'run',
          '--no-file-parallelism',
        ],
        {
          cwd: new URL('../apps/server/', import.meta.url),
          env,
          stdio: 'inherit',
        },
      );
  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  process.exitCode = code ?? 1;
} finally {
  child?.kill();
  await server.stop();
  await db.close();
}
