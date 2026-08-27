/**
 * Connecting an account's own Claude subscription.
 *
 *   POST   /api/claude-code/login            begin — returns the URL to approve at
 *   POST   /api/claude-code/login/complete   finish — takes the pasted code
 *   GET    /api/claude-code                  is this account connected, and to what
 *   DELETE /api/claude-code                  disconnect
 *
 * Open to any signed-in account, not just admins, and that is the whole point of the feature:
 * the deployment-wide provider choice is an admin decision, but *whose plan pays* is the
 * user's own, and a per-user credential that only an admin could install would be neither.
 *
 * The pending login — the PKCE verifier and the state — is held in memory, keyed by user,
 * for a few minutes. Not in the database, deliberately: it is worthless after the exchange
 * and dangerous before it, so the shortest possible life is the right one, and a restart
 * mid-login costing someone one click is a better trade than persisting the one secret that
 * makes a stolen authorization code useful.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { Auth } from '../../auth/session.js';
import type { ClaudeAccountStore } from './accountStore.js';
import {
  ClaudeLoginError,
  exchangeClaudeCode,
  parsePastedCode,
  sameState,
  startClaudeLogin,
} from './claudeOAuth.js';

/** How long a started login stays valid. Long enough to read a consent screen, not much more. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/** A pasted code is short. This is generous enough for a whole URL and nothing more. */
const MAX_CODE_LENGTH = 2048;

interface Pending {
  verifier: string;
  state: string;
  expiresAt: number;
}

export interface ClaudeCodeRoutesOptions {
  auth: Auth;
  /** Null when the server has no database: there is nowhere to keep a credential. */
  store: ClaudeAccountStore | null;
  now?: () => number;
}

export function claudeCodeRoutes(options: ClaudeCodeRoutesOptions): FastifyPluginAsync {
  const now = options.now ?? Date.now;
  const pending = new Map<string, Pending>();

  /** Drop anything past its window. Called on each use, so no timer has to exist. */
  const sweep = () => {
    const at = now();
    for (const [key, entry] of pending) if (entry.expiresAt <= at) pending.delete(key);
  };

  return async (app) => {
    app.post('/api/claude-code/login', async (request, reply) => {
      const user = await options.auth.requireUser(request, reply);
      if (!user) return;
      if (!options.store) {
        return reply.code(503).send({
          error: 'no_database',
          message: 'connecting a subscription needs a database, and this server has none configured',
        });
      }

      sweep();
      const started = startClaudeLogin();
      pending.set(user.id, {
        verifier: started.verifier,
        state: started.state,
        expiresAt: now() + PENDING_TTL_MS,
      });

      request.log.info({ by: user.email }, 'claude subscription login started');
      // The verifier stays here. Only the URL crosses to the browser.
      return { url: started.url, expiresInSeconds: Math.round(PENDING_TTL_MS / 1000) };
    });

    app.post('/api/claude-code/login/complete', async (request, reply) => {
      const user = await options.auth.requireUser(request, reply);
      if (!user) return;
      if (!options.store) return reply.code(503).send({ error: 'no_database' });

      sweep();
      const entry = pending.get(user.id);
      if (!entry) {
        return reply.code(400).send({
          error: 'no_pending_login',
          message: 'That login has expired or was never started. Run the command again.',
        });
      }

      const body = (request.body ?? {}) as { code?: unknown };
      if (typeof body.code !== 'string' || body.code.length > MAX_CODE_LENGTH) {
        return reply.code(400).send({ error: 'bad_code', message: 'Paste the code from the approval page.' });
      }

      const parsed = parsePastedCode(body.code);
      if (!parsed) {
        return reply.code(400).send({ error: 'bad_code', message: 'That does not look like an authorization code.' });
      }

      // The state binds this code to the login *this* account started. A code from somebody
      // else's approval, pasted here, has to be refused — that is the entire job of the
      // parameter, and skipping the check because the code "looks right" is how it gets lost.
      if (parsed.state !== null && !sameState(entry.state, parsed.state)) {
        return reply.code(400).send({
          error: 'state_mismatch',
          message: 'That code came from a different login. Start again and use the newest link.',
        });
      }

      // Single use either way: a code that failed to exchange cannot be retried, and one that
      // succeeded must not be replayed.
      pending.delete(user.id);

      try {
        const identity = await exchangeClaudeCode({
          code: parsed.code,
          state: entry.state,
          verifier: entry.verifier,
        });
        await options.store.save(user.id, identity);
        request.log.info({ by: user.email, plan: identity.subscriptionType }, 'claude subscription connected');
        return options.store.status(user.id, now());
      } catch (error) {
        if (error instanceof ClaudeLoginError) {
          return reply.code(400).send({ error: 'exchange_failed', message: error.message, restart: error.restart });
        }
        throw error;
      }
    });

    app.get('/api/claude-code', async (request, reply) => {
      const user = await options.auth.requireUser(request, reply);
      if (!user) return;
      if (!options.store) {
        return { connected: false, plan: null, expiresAt: null, expired: false, scopes: [], available: false };
      }
      return { ...(await options.store.status(user.id, now())), available: true };
    });

    app.delete('/api/claude-code', async (request, reply) => {
      const user = await options.auth.requireUser(request, reply);
      if (!user) return;
      if (!options.store) return reply.code(503).send({ error: 'no_database' });
      pending.delete(user.id);
      await options.store.forget(user.id);
      request.log.info({ by: user.email }, 'claude subscription disconnected');
      return { connected: false, plan: null, expiresAt: null, expired: false, scopes: [], available: true };
    });
  };
}
