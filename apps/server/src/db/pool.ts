/**
 * Postgres connection and migrations.
 *
 * Migrations are plain `.sql` files applied in filename order and recorded in a table, run
 * at boot. That is deliberately the simplest thing that works: this project has one server
 * process and one database, so a migration tool would add a dependency and a CLI step
 * without buying anything.
 *
 * The server still starts when the database is unreachable. Generation, the editor and the
 * exports do not need it, and refusing to boot would take out working features because a
 * not-yet-used one is unavailable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));

export type Db = pg.Pool;

let pool: pg.Pool | undefined;
let available = false;

export function isDbAvailable(): boolean {
	return available;
}

/**
 * Connect and migrate. Returns null if the database cannot be reached, having logged why —
 * callers treat that as "this feature is off" rather than a crash.
 */
export async function initDb(
	connectionString: string | undefined,
	log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void },
): Promise<Db | null> {
	if (!connectionString) {
		log.warn({}, 'DATABASE_URL not set — pairing, jobs and accounts are unavailable');
		return null;
	}

	pool = new pg.Pool({
		connectionString,
		max: 8,
		// A hung connection attempt must not hold up boot.
		connectionTimeoutMillis: 5_000,
		idleTimeoutMillis: 30_000,
	});

	// A pool-level error handler is required: without one, a dropped backend connection
	// raises an unhandled 'error' event and takes the process down.
	pool.on('error', (err) => log.warn({ err }, 'idle postgres client errored'));

	try {
		await pool.query('SELECT 1');
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'could not reach postgres — pairing and jobs are unavailable');
		await pool.end().catch(() => undefined);
		pool = undefined;
		return null;
	}

	await migrate(pool, log);
	available = true;
	return pool;
}

async function migrate(db: pg.Pool, log: { info: (o: unknown, m?: string) => void }): Promise<void> {
	await db.query(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			name       text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
	`);

	const dir = path.join(here, 'migrations');
	if (!fs.existsSync(dir)) return;

	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
	const applied = new Set(
		(await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
	);

	for (const file of files) {
		if (applied.has(file)) continue;

		const sql = fs.readFileSync(path.join(dir, file), 'utf8');
		const client = await db.connect();
		try {
			// Each migration is one transaction, so a failure half-way leaves nothing behind.
			await client.query('BEGIN');
			await client.query(sql);
			await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
			await client.query('COMMIT');
			log.info({ migration: file }, 'applied migration');
		} catch (err) {
			await client.query('ROLLBACK').catch(() => undefined);
			throw new Error(`migration ${file} failed: ${(err as Error).message}`);
		} finally {
			client.release();
		}
	}
}

export async function closeDb(): Promise<void> {
	available = false;
	await pool?.end().catch(() => undefined);
	pool = undefined;
}
