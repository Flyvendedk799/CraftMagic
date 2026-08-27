/**
 * Admin settings: which model provider to use, and its key.
 *
 * These moved out of the environment because changing either used to mean an SSH session and
 * a redeploy. The rules that make that safe:
 *
 *   * **A key is never sent back.** `GET` returns a masked hint (`sk-ant-…9ZQ`) — enough to
 *     recognise which key is installed, useless for spending money with. There is no route
 *     that returns the whole value, so a compromised admin session cannot exfiltrate the key,
 *     only replace it.
 *   * **Admin is an account flag, not a second login.** Another credential is another thing to
 *     leak, and the question that matters is whether *this signed-in person* may change the
 *     key.
 *   * **Every route requires an admin**, including the read. Knowing which provider and model
 *     a deployment runs, and how much of the budget is left, is not public information.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Auth } from '../auth/session.js';
import type { AuthStore } from '../auth/store.js';
import { isPricingKnown, isSubscription, pricingFor, PRICING, type ProviderId } from '../generate/pricing.js';
import type { SpendLedger } from '../generate/spend.js';
import { SETTING_KEYS, type SettingsStore } from '../settings/store.js';

export interface AdminRoutesOptions {
  auth: Auth;
  authStore: AuthStore | null;
  settings: SettingsStore | null;
  ledger: SpendLedger;
  /** Reads the effective configuration, environment fallback included. */
  resolveAi: () => Promise<{
    provider: ProviderId;
    model: string;
    keySource: 'settings' | 'environment' | 'subscription' | 'none';
    ready: boolean;
    anthropicKeyHint: string | null;
    openaiKeyHint: string | null;
  }>;
  /**
   * Whether the two CLI logins exist on this machine, and on whose plan.
   *
   * Read fresh on every request rather than cached: the whole point of harvesting a local
   * login is that signing in or out of `claude` takes effect without touching this server,
   * and a cached answer would make the admin page the one place that had not noticed.
   *
   * Nothing here is a credential. The page is told that a login exists, which plan it is on
   * and when it expires — never the token, which has no route out of this process at all.
   */
  subscriptions: () => Promise<SubscriptionStatus>;
}

export interface SubscriptionStatus {
  claudeCode: {
    connected: boolean;
    subscriptionType: string | null;
    source: 'keychain' | 'file' | null;
    expiresAt: number | null;
    expired: boolean;
  };
  codex: {
    connected: boolean;
    planType: string | null;
    email: string | null;
    accountId: string | null;
    expiresAt: number | null;
    expired: boolean;
  };
}

const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'claude-code', 'codex'];

/** Long enough for any real key, short enough that nobody pastes a file into it. */
const MAX_KEY_LENGTH = 512;

export function adminRoutes(options: AdminRoutesOptions): FastifyPluginAsync {
  return async (app) => {
    /** The signed-in admin, or null having already answered. */
    async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
      if (!options.settings || !options.authStore) {
        await reply.code(503).send({
          error: 'no_database',
          message: 'settings need a database, and this server has none configured',
        });
        return null;
      }
      const user = await options.auth.requireUser(request, reply);
      if (!user) return null;

      if (!user.isAdmin) {
        // 404, not 403: the same reasoning as everywhere else here — a non-admin learns
        // nothing about whether an admin area exists.
        await reply.code(404).send({ error: 'not_found' });
        return null;
      }
      return user;
    }

    app.get('/api/admin/settings', async (request, reply) => {
      const user = await requireAdmin(request, reply);
      if (!user) return;

      const [ai, subscriptions] = await Promise.all([options.resolveAi(), options.subscriptions()]);
      return {
        provider: ai.provider,
        model: ai.model,
        keySource: ai.keySource,
        ready: ai.ready,
        subscriptions,
        anthropicKeyHint: ai.anthropicKeyHint,
        openaiKeyHint: ai.openaiKeyHint,
        providers: PROVIDERS,
        // So the page can warn when a typed model has no published rate and the budget guard
        // is falling back to its pessimistic assumption.
        knownModels: Object.keys(PRICING),
        // A subscription has no per-token rate, so "we do not know this model's price" is not
        // a warning worth showing: nothing is going to be charged either way.
        pricingKnown: isSubscription(ai.provider) || isPricingKnown(ai.model),
        metered: !isSubscription(ai.provider),
        pricing: pricingFor(ai.model),
        spend: options.ledger.summary(),
      };
    });

    app.put('/api/admin/settings', async (request, reply) => {
      const user = await requireAdmin(request, reply);
      if (!user) return;

      const body = (request.body ?? {}) as {
        provider?: unknown;
        model?: unknown;
        anthropicKey?: unknown;
        openaiKey?: unknown;
      };

      if (body.provider !== undefined) {
        if (typeof body.provider !== 'string' || !PROVIDERS.includes(body.provider as ProviderId)) {
          return reply.code(400).send({ error: 'bad_provider', allowed: PROVIDERS });
        }
        await options.settings!.put(SETTING_KEYS.provider, body.provider, false, user.id);
      }

      if (body.model !== undefined) {
        if (typeof body.model !== 'string' || body.model.trim().length === 0 || body.model.length > 100) {
          return reply.code(400).send({ error: 'bad_model' });
        }
        await options.settings!.put(SETTING_KEYS.model, body.model.trim(), false, user.id);
      }

      // An empty string means "clear this key"; omitting the field means "leave it alone".
      // Without that distinction, saving the form to change the model would wipe the key,
      // because the page never had the key to send back.
      for (const [field, key] of [
        ['anthropicKey', SETTING_KEYS.anthropicKey],
        ['openaiKey', SETTING_KEYS.openaiKey],
      ] as const) {
        const value = body[field];
        if (value === undefined) continue;
        if (typeof value !== 'string' || value.length > MAX_KEY_LENGTH) {
          return reply.code(400).send({ error: 'bad_key', field });
        }
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          await options.settings!.clear(key);
        } else {
          await options.settings!.put(key, trimmed, true, user.id);
        }
      }

      const ai = await options.resolveAi();
      request.log.info(
        { provider: ai.provider, model: ai.model, by: user.email },
        'admin updated AI settings',
      );
      return {
        provider: ai.provider,
        model: ai.model,
        keySource: ai.keySource,
        ready: ai.ready,
        anthropicKeyHint: ai.anthropicKeyHint,
        openaiKeyHint: ai.openaiKeyHint,
        pricingKnown: isSubscription(ai.provider) || isPricingKnown(ai.model),
      };
    });
  };
}
