/**
 * Test-only: a real server, against a real database.
 *
 * The interesting properties of this codebase — ownership scoping, the session cookie, the
 * origin guard — are all properties of *routes*, not of functions. A unit test of
 * `AgentStore.getBuild` proves the SQL; only a request proves that the route remembered to
 * pass a scope to it. So these tests drive the actual plugins through `app.inject()`.
 *
 * Postgres is required. When it is unreachable the suites that need it are `describe.skip`ped
 * and say so loudly: a test that quietly no-ops when its dependency is missing reports green
 * for a security property nobody checked, which is worse than not having the test.
 *
 *   ./tools/pg.ps1 start
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { agentRoutes } from '../agent/routes.js';
import { AgentHub } from '../agent/hub.js';
import { AgentStore } from '../agent/store.js';
import { originGuard } from '../auth/origin.js';
import { authRoutes } from '../auth/routes.js';
import { createAuth } from '../auth/session.js';
import { AuthStore } from '../auth/store.js';
import { closeDb, initDb, type Db } from '../db/pool.js';
import { generateRoutes } from '../generate/routes.js';
import { GenerationQuota } from '../generate/quota.js';
import { SpendLedger } from '../generate/spend.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

export const TEST_ORIGIN = 'http://localhost:3016';

/** Connect and migrate, or return null having explained why. */
export async function openTestDb(): Promise<Db | null> {
	const envFile = path.join(repoRoot, 'apps/server/.env');
	if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

	if (!process.env.DATABASE_URL) {
		console.warn('\n  SKIPPING database-backed tests: DATABASE_URL is not set.\n');
		return null;
	}

	const silent = { info: () => undefined, warn: () => undefined };
	const db = await initDb(process.env.DATABASE_URL, silent);
	if (!db) {
		console.warn('\n  SKIPPING database-backed tests: postgres unreachable. Run ./tools/pg.ps1 start\n');
	}
	return db;
}

export async function closeTestDb(): Promise<void> {
	await closeDb();
}

export interface TestApp {
	app: FastifyInstance;
	db: Db;
	/** POST/PATCH/DELETE as a signed-in user; `cookie` omitted means signed out. */
	call(
		method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
		url: string,
		options?: { body?: unknown; cookie?: string; headers?: Record<string, string> },
	): Promise<{ status: number; body: Record<string, unknown>; cookie: string | null }>;
	/** Register a fresh account and return its cookie and id. */
	signUp(label: string): Promise<{ cookie: string; id: string; email: string }>;
}

export interface BuildTestAppOptions {
	/**
	 * Passed straight to `generateRoutes`. Undefined is the production default — the server
	 * deliberately runs without a key so an unauthenticated port cannot spend money, and the
	 * generation routes must answer 503 rather than fail to start.
	 */
	apiKey?: string;
	/** Null exercises the no-database path without tearing down the pool. */
	quota?: GenerationQuota | null;
}

/**
 * The same plugins, in the same order, as `index.ts`.
 *
 * Mirrored rather than imported because `index.ts` is a script: it reads the environment,
 * opens a listening socket and serves the built frontend, none of which a test wants. The
 * pieces that carry the security properties — the cookie plugin, the origin hook, and the
 * three route plugins with one shared `auth` — are constructed here exactly as they are there.
 */
export async function buildTestApp(db: Db, options: BuildTestAppOptions = {}): Promise<TestApp> {
	const app = Fastify({ logger: false });

	await app.register(fastifyCookie);
	app.addHook('onRequest', originGuard({ publicOrigin: TEST_ORIGIN, isProduction: false }));

	// Both parsers matter here: several routes are POSTs with no body at all, and without
	// these Fastify answers 415 or FST_ERR_CTP_EMPTY_JSON_BODY before the handler runs.
	app.removeContentTypeParser('application/json');
	app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
		const buffer = body as Buffer;
		if (!buffer || buffer.length === 0) return done(null, {});
		try {
			done(null, JSON.parse(buffer.toString('utf8')));
		} catch (err) {
			done(err as Error);
		}
	});

	const store = new AgentStore(db);
	const hub = new AgentHub(store);
	const authStore = new AuthStore(db);
	const quota = options.quota === undefined ? new GenerationQuota(db) : options.quota;
	const auth = createAuth(authStore);

	await app.register(agentRoutes({ store, hub, auth, publicOrigin: TEST_ORIGIN }));
	await app.register(authRoutes({ store: authStore, auth, quota }));
	await app.register(
		generateRoutes({
			// A temp file per app, so a test can never append to the real ledger.
			ledger: new SpendLedger(
				path.join(fs.mkdtempSync(path.join(repoRoot, 'node_modules/.cache-ic-test-')), 'ledger.json'),
				100,
			),
			model: 'claude-sonnet-5',
			apiKey: options.apiKey,
			auth,
			quota,
		}),
	);

	await app.ready();

	const call: TestApp['call'] = async (method, url, opts = {}) => {
		const response = await app.inject({
			method,
			url,
			headers: {
				'content-type': 'application/json',
				...(opts.cookie ? { cookie: opts.cookie } : {}),
				...opts.headers,
			},
			...(opts.body === undefined ? {} : { payload: JSON.stringify(opts.body) }),
		});

		let body: Record<string, unknown> = {};
		try {
			body = response.body ? JSON.parse(response.body) : {};
		} catch {
			body = { raw: response.body };
		}

		const setCookie = response.headers['set-cookie'];
		const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [String(setCookie)] : [];
		const session = headers.find((c) => c.startsWith('cm_session='))?.split(';')[0] ?? null;

		return { status: response.statusCode, body, cookie: session };
	};

	const signUp: TestApp['signUp'] = async (label) => {
		// Stamped unique so a re-run does not collide with the accounts the last one left.
		const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
		const result = await call('POST', '/api/auth/register', {
			body: { email, password: 'a-perfectly-fine-password' },
		});
		if (result.status !== 201 || !result.cookie) {
			throw new Error(`could not register a test account: HTTP ${result.status} ${JSON.stringify(result.body)}`);
		}
		return { cookie: result.cookie, id: (result.body.user as { id: string }).id, email };
	};

	return { app, db, call, signUp };
}
