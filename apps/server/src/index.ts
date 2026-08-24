import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { loadConfig, repoRoot } from './config.js';
import { registerAgentWs } from './agent/ws.js';
import { agentRoutes } from './agent/routes.js';
import { AgentHub } from './agent/hub.js';
import { AgentStore } from './agent/store.js';
import { authRoutes } from './auth/routes.js';
import { originGuard } from './auth/origin.js';
import { createAuth } from './auth/session.js';
import { AuthStore } from './auth/store.js';
import { initDb } from './db/pool.js';
import { generateRoutes } from './generate/routes.js';
import { adminRoutes } from './admin/routes.js';
import { SettingsStore, maskKey, type AiSettings } from './settings/store.js';
import { GenerationQuota } from './generate/quota.js';
import { SpendLedger } from './generate/spend.js';

// Secrets live in apps/server/.env, which is gitignored. Loaded before config is read.
const envFile = path.join(repoRoot, 'apps/server/.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: config.isProduction ? undefined : { target: 'pino-pretty' },
  },
});

await app.register(fastifyWebsocket);

// Unsigned: the session token is 32 CSPRNG bytes and only its SHA-256 is stored, so a
// signature would authenticate a value that is already unguessable and unforgeable.
await app.register(fastifyCookie);

// Registered on the root instance rather than inside the auth plugin, so it covers every
// mutating route including ones added later. See `auth/origin.ts` for why a missing Origin
// header is allowed.
app.addHook(
	'onRequest',
	originGuard({ publicOrigin: config.publicOrigin, isProduction: config.isProduction }),
);

// Some endpoints take no input at all (minting a pairing code), and clients send that in
// two different unhelpful ways: no Content-Type at all (Fastify answers 415) or
// `application/json` with an empty body (`FST_ERR_CTP_EMPTY_JSON_BODY`). Both are a POST
// with nothing to say, so both are treated as `{}`. Malformed JSON still fails loudly —
// that is a real client bug and hiding it would be worse.
//
// Parsed as a Buffer rather than a string: with `parseAs: 'string'` Fastify compares the
// decoded *character* count against the byte-based Content-Length, so any multi-byte
// character makes a perfectly valid request fail with FST_ERR_CTP_INVALID_CONTENT_LENGTH.
// Decoding the bytes ourselves sidesteps that entirely.
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
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
  const buffer = body as Buffer;
  done(null, buffer && buffer.length > 0 ? { raw: buffer.toString('utf8') } : {});
});

/**
 * Liveness, plus whether the database is actually usable.
 *
 * The database is optional by design — the editor, exports and the guide all work without it —
 * so a server with an unreachable Postgres still answers every request happily. That made a
 * misconfigured deployment indistinguishable from a healthy one from the outside, while
 * pairing and the library were silently dead. Reporting it here is the difference between a
 * deploy check that means something and one that only proves the process is running.
 *
 * `db` is declared below and referenced here rather than captured: the handler only ever runs
 * after `listen()`, by which point the connection has been resolved.
 */
app.get('/api/health', async () => {
  // Asked rather than remembered — a pool that connected at boot and died since is not
  // "connected", and that is exactly the state worth catching.
  //
  // `not_configured` and `unavailable` are kept apart deliberately. `initDb` returns null
  // both when there is no DATABASE_URL and when there is one that failed to connect, so
  // reporting on `db` alone told a deployment with a wrong password that it had no database
  // configured — which sent the search in exactly the wrong direction.
  let database: 'connected' | 'unavailable' | 'not_configured';
  if (!config.databaseUrl) {
    database = 'not_configured';
  } else if (!db) {
    database = 'unavailable';
  } else {
    try {
      await db.query('SELECT 1');
      database = 'connected';
    } catch {
      database = 'unavailable';
    }
  }

  return {
    ok: true,
    service: 'craftmagic',
    version: process.env.npm_package_version ?? '0.1.0',
    database,
    time: new Date().toISOString(),
  };
});

// The database is optional: generation, the editor and the exports all work without it, so
// an unreachable Postgres disables pairing rather than taking the server down.
const db = await initDb(config.databaseUrl, app.log);
const store = db ? new AgentStore(db) : null;
const hub = store ? new AgentHub(store) : null;
const authStore = db ? new AuthStore(db) : null;
const quota = db ? new GenerationQuota(db) : null;

// Everything that needs to know who is calling takes this, rather than a Fastify decorator:
// decorators respect plugin encapsulation, so one registered inside a plugin is missing from
// the next one — a failure that shows up at runtime on the route that needed it.
const auth = createAuth(authStore);

await app.register(registerAgentWs({ store, hub }));
await app.register(agentRoutes({ store, hub, auth, publicOrigin: config.publicOrigin }));
await app.register(authRoutes({ store: authStore, auth, quota }));

if (store) {
  app.log.info('agent pairing, jobs and accounts enabled');
}

// Expiry is enforced in the session lookup, so this only keeps the table from growing without
// bound. Unref'd: a pending timer must not be the reason the process refuses to exit.
if (authStore) {
  const sweep = () =>
    void authStore
      .sweepExpiredSessions()
      .then((removed) => removed > 0 && app.log.info({ removed }, 'swept expired sessions'))
      .catch((err: unknown) => app.log.warn({ err }, 'session sweep failed'));
  sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();
}

const ledger = new SpendLedger(config.spendLedgerPath, config.monthlyBudgetUsd);
const settings = db ? new SettingsStore(db, config.sessionSecret) : null;

/**
 * The provider, model and key in force right now.
 *
 * Read per request rather than captured here, so a change on the admin page takes effect
 * immediately. Without a database there are no settings, so the environment is the whole
 * answer — which is also what a fresh install has before anyone has registered.
 */
const resolveAi = async (): Promise<AiSettings> => {
  const env = {
    ...(config.anthropicApiKey ? { anthropicKey: config.anthropicApiKey } : {}),
    ...(config.openaiApiKey ? { openaiKey: config.openaiApiKey } : {}),
    model: config.anthropicModel,
  };
  if (!settings) {
    const apiKey = env.anthropicKey ?? null;
    return {
      provider: 'anthropic',
      model: env.model,
      apiKey,
      keySource: apiKey ? 'environment' : 'none',
      anthropicKeyHint: apiKey ? maskKey(apiKey) : null,
      openaiKeyHint: env.openaiKey ? maskKey(env.openaiKey) : null,
    };
  }
  return settings.effective(env);
};

await app.register(generateRoutes({ ledger, resolveAi, auth, quota }));
await app.register(
  adminRoutes({ auth, authStore, settings, ledger, resolveAi }),
);

const startupAi = await resolveAi();
if (!startupAi.apiKey) {
  app.log.warn(
    'no AI key configured — generation returns 503 until one is set in /admin or the environment',
  );
} else {
  // Only checked when a key is present: without one nothing can be spent, so an unwritable
  // ledger is harmless and must not stop the editor, exports and guide from being served.
  ledger.assertWritable();
  app.log.info(
    {
      provider: startupAi.provider,
      model: startupAi.model,
      keySource: startupAi.keySource,
      budgetUsd: config.monthlyBudgetUsd,
      spentUsd: ledger.spentThisMonth(),
      ledger: ledger.path,
    },
    'generation enabled',
  );
}

// The built frontend is served from this same process, so there is one service to deploy.
// Missing in dev before the first `npm run build --workspace @craftmagic/web`.
if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist });
  app.setNotFoundHandler((request, reply) => {
    // API 404s stay JSON; everything else falls through to the SPA.
    if (request.url.startsWith('/api/') || request.url.startsWith('/agent/')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn({ webDist: config.webDist }, 'web dist not built yet — serving API only');
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ publicOrigin: config.publicOrigin }, 'craftmagic server listening');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
