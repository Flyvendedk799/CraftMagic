/**
 * Admin settings: which AI serves generation, on which model, and paid for how.
 *
 * Four providers in two kinds, and the split that matters is who pays rather than who serves.
 * Two are metered API keys, which the deployment's card settles and the monthly budget guard
 * polices. Two are subscriptions — the `claude` and `codex` logins already on the server's
 * machine — which cost this deployment nothing because a plan has already been bought.
 *
 * That difference drives the form. A metered provider shows a key field, a rate and a spend
 * ceiling. A subscription shows none of those, because they would all be zero or a lie, and
 * shows instead the one thing that decides whether it will work: is there a login on that
 * machine, whose plan is it, and has its token gone stale.
 *
 * The key fields start empty and stay empty, because the server never sends a key back — only
 * a masked hint of the one installed. That shapes the rest of the form: leaving a field blank
 * means "keep what is there", and the page says so rather than letting someone assume an empty
 * box means no key is set and that saving will not disturb it.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../library/auth.js';
import { ClaudeTerminal, type ClaudeConnection } from '@flyvendedk799/ai-auth/react';
import {
  isSubscription,
  loadSettings,
  saveSettings,
  type AdminSettings,
  type ProviderId,
  type SubscriptionStatus,
} from './admin.js';
import '@flyvendedk799/ai-auth/react/terminal.css';
import './admin.css';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; settings: AdminSettings }
  | { status: 'error'; message: string };

const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: 'Claude API key',
  openai: 'OpenAI API key',
  'claude-code': 'Claude subscription',
  codex: 'ChatGPT subscription',
};

/** What each one is, in the one line the radio has room for. */
const PROVIDER_BLURB: Record<ProviderId, string> = {
  anthropic: 'Metered. Billed per token to this deployment.',
  openai: 'Metered. Billed per token to this deployment.',
  'claude-code': 'Uses the claude login on this server. Billed to that plan.',
  codex: 'Uses the codex login on this server. Billed to that plan.',
};

const KEY_PLACEHOLDER: Record<ProviderId, string> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
  'claude-code': '',
  codex: '',
};

/** The default model for a provider. Must agree with `defaultModelFor` on the server. */
const DEFAULT_MODEL: Record<ProviderId, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5',
  'claude-code': 'claude-sonnet-5',
  codex: 'gpt-5-codex',
};

export function AdminPage() {
  const auth = useAuth();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [provider, setProvider] = useState<ProviderId>('anthropic');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  /** This account's own connected subscription, reported up by the terminal. */
  const [connection, setConnection] = useState<ClaudeConnection | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const settings = await loadSettings();
      setLoad({ status: 'ready', settings });
      setProvider(settings.provider);
      setModel(settings.model);
    } catch (err) {
      setLoad({ status: 'error', message: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    if (auth.status === 'loading') return;
    if (auth.status === 'anonymous') {
      setLoad({ status: 'error', message: 'Sign in to reach these settings.' });
      return;
    }
    void refresh();
  }, [auth.status, refresh]);

  const onSave = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setSaving(true);
      setFailed(null);
      setSaved(null);
      try {
        await saveSettings({
          provider,
          model: model.trim(),
          // Only sent when typed. An empty field must not clear a working key just because
          // someone came here to change the model.
          ...(key.trim() ? (provider === 'openai' ? { openaiKey: key.trim() } : { anthropicKey: key.trim() }) : {}),
        });
        setKey('');
        setSaved('Saved. New generations use these settings immediately.');
        await refresh();
      } catch (err) {
        setFailed((err as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [provider, model, key, refresh],
  );

  const settings = load.status === 'ready' ? load.settings : null;
  const hint = settings
    ? provider === 'openai'
      ? settings.openaiKeyHint
      : settings.anthropicKeyHint
    : null;

  return (
    <div className="admin" data-ready={load.status === 'loading' ? '0' : '1'}>
      <header className="admin__head">
        <div>
          <h1 className="admin__title">Settings</h1>
          <p className="admin__sub">Which AI generates builds, on which model, and who pays for it.</p>
        </div>
        <Link className="admin__back" to="/editor">
          ← Back to the editor
        </Link>
      </header>

      {load.status === 'loading' && <p className="admin__note">Loading…</p>}

      {load.status === 'error' && (
        <section className="panel">
          <p className="admin__error" role="alert">
            {load.message}
          </p>
        </section>
      )}

      {settings && (
        <>
          <form className="panel admin__form" onSubmit={(e) => void onSave(e)}>
            <h2>Provider</h2>

            <div className="admin__providers">
              {settings.providers.map((id) => (
                <label key={id} className={`admin__provider ${provider === id ? 'admin__provider--on' : ''}`}>
                  <input
                    type="radio"
                    name="provider"
                    value={id}
                    checked={provider === id}
                    onChange={() => {
                      setProvider(id);
                      // The default model belongs to the provider, so switching without this
                      // leaves a Claude model selected against OpenAI.
                      setModel(DEFAULT_MODEL[id]);
                      setKey('');
                    }}
                  />
                  <span>{PROVIDER_LABEL[id]}</span>
                  <span className="admin__provider-blurb">{PROVIDER_BLURB[id]}</span>
                  {/* The bottom line of each card is the one thing that decides whether it
                      will work: a key hint for the metered pair, a connection for the two
                      subscriptions. Same slot, because it is the same question. */}
                  {isSubscription(id) ? (
                    <ConnectionLine id={id} status={settings.subscriptions} />
                  ) : (
                    <span className="admin__provider-key">
                      {(id === 'openai' ? settings.openaiKeyHint : settings.anthropicKeyHint) ?? 'no key'}
                    </span>
                  )}
                </label>
              ))}
            </div>

            <label className="admin__field">
              <span className="admin__label">Model</span>
              <input
                className="admin__input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                list="known-models"
                placeholder={provider === 'openai' ? 'gpt-5' : 'claude-sonnet-5'}
                spellCheck={false}
              />
              <datalist id="known-models">
                {settings.knownModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>

            {!isSubscription(provider) && !settings.pricingKnown && (
              <p className="admin__warn">
                No published rate is known for <code>{settings.model}</code>, so the budget guard
                assumes ${settings.pricing.input}/M in and ${settings.pricing.output}/M out. That is
                deliberately pessimistic — spending stops early rather than overshooting.
              </p>
            )}

            {provider === 'claude-code' ? (
              <>
                {/* The connect flow, shown as the shell it stands in for. Above the machine-login
                    note rather than instead of it: the account's own subscription is the thing to
                    do here, and the server's login is only what it falls back to. */}
                <div className="admin__field">
                  <span className="admin__label">Your Claude subscription</span>
                  <ClaudeTerminal onChange={setConnection} />
                </div>
                <ClaudeSubscriptionNote
                  connection={connection}
                  machine={settings.subscriptions.claudeCode}
                />
              </>
            ) : isSubscription(provider) ? (
              <SubscriptionNote provider={provider} status={settings.subscriptions} />
            ) : (
              <>
                <label className="admin__field">
                  <span className="admin__label">
                    API key {hint && <span className="admin__hint">currently {hint}</span>}
                  </span>
                  <input
                    className="admin__input"
                    type="password"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder={hint ? 'leave blank to keep the current key' : KEY_PLACEHOLDER[provider]}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>

                <p className="admin__note">
                  Keys are encrypted before they are stored and are never sent back to this page —
                  that is why the field is blank even when one is set.
                  {settings.keySource === 'environment' && (
                    <> The key in use right now comes from the server’s environment.</>
                  )}
                </p>
              </>
            )}

            <div className="admin__actions">
              <button type="submit" disabled={saving || !model.trim()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              {saved && <span className="admin__ok">{saved}</span>}
              {failed && (
                <span className="admin__error" role="alert">
                  {failed}
                </span>
              )}
            </div>
          </form>

          <section className="panel">
            <h2>Spend this month</h2>
            {!settings.metered && (
              <p className="admin__note admin__note--lead">
                Nothing is being charged right now: generation runs on a subscription, so the
                figures below are the history of what metered providers have cost, not what
                today’s calls are costing. Subscription calls are recorded at zero.
              </p>
            )}
            <dl className="admin__spend">
              <div>
                <dt>Used</dt>
                <dd>${settings.spend.spentThisMonthUsd.toFixed(4)}</dd>
              </div>
              <div>
                <dt>Remaining</dt>
                <dd>${settings.spend.remainingUsd.toFixed(2)}</dd>
              </div>
              <div>
                <dt>Ceiling</dt>
                <dd>${settings.spend.monthlyBudgetUsd.toFixed(2)}</dd>
              </div>
              <div>
                <dt>Calls</dt>
                <dd>{settings.spend.callsThisMonth}</dd>
              </div>
            </dl>
            <p className="admin__note">
              The ceiling is <code>ANTHROPIC_MONTHLY_BUDGET_USD</code> in the server’s
              environment, and it is enforced per instance — two deployments sharing one key
              have two separate ceilings.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Which of the two credentials will actually serve this account.
 *
 * There are two, they are checked in a fixed order, and the order is the feature: an account's
 * own subscription first, the server's machine login only if it has none. Saying so plainly
 * matters more than it looks — the difference between the two is *whose plan gets spent*, and
 * a page that showed only "connected" would be hiding exactly that.
 */
function ClaudeSubscriptionNote({
  connection,
  machine,
}: {
  connection: ClaudeConnection | null;
  machine: SubscriptionStatus['claudeCode'];
}) {
  if (connection?.connected) {
    return (
      <p className="admin__note">
        Generations from this account bill to your own subscription
        {connection.plan ? ` (${connection.plan} plan)` : ''}. The token is stored encrypted,
        refreshed automatically, and never sent back to this page.
      </p>
    );
  }

  if (machine.connected) {
    return (
      <p className="admin__warn">
        This account has no subscription of its own, so its generations fall back to the{' '}
        <code>claude</code> login on the server
        {machine.subscriptionType ? ` (${machine.subscriptionType} plan)` : ''} — which means they
        are billed to whoever set this server up. Sign in above to use your own instead.
      </p>
    );
  }

  return (
    <p className="admin__warn">
      Neither this account nor the server has a Claude subscription connected, so generation will
      refuse. Sign in above.
    </p>
  );
}

/**
 * Whether the CLI login this provider needs is on the server's machine.
 *
 * Three states, and the middle one is the reason this is not a boolean: a login can be there
 * and stale. Claude Code's can be refreshed on the way out so a stale one still works and is
 * only worth mentioning; Codex's cannot be refreshed without breaking the CLI's own session,
 * so a stale one genuinely does not work and has to say so.
 */
function ConnectionLine({ id, status }: { id: ProviderId; status: SubscriptionStatus }) {
  const entry = id === 'claude-code' ? status.claudeCode : status.codex;
  if (!entry.connected) {
    return <span className="admin__provider-key admin__provider-key--off">not signed in here</span>;
  }

  const plan = id === 'claude-code' ? status.claudeCode.subscriptionType : status.codex.planType;
  const blocked = id === 'codex' && entry.expired;

  return (
    <span className={`admin__provider-key ${blocked ? 'admin__provider-key--off' : 'admin__provider-key--on'}`}>
      {blocked ? 'token expired' : plan ? `${plan} plan` : 'connected'}
    </span>
  );
}

/**
 * What to do about a subscription, in place of the key field.
 *
 * The whole of "connecting" is signing in to a CLI on the server, which is a thing that
 * happens in a terminal and cannot be done from a web page — so this does not pretend to
 * offer a button. It says what state the login is in and what command changes it, which is
 * the only honest help a browser can give here.
 */
function SubscriptionNote({ provider, status }: { provider: ProviderId; status: SubscriptionStatus }) {
  const claude = provider === 'claude-code';
  const entry = claude ? status.claudeCode : status.codex;
  const command = claude ? 'claude' : 'codex';

  if (!entry.connected) {
    return (
      <p className="admin__warn">
        No <code>{command}</code> login was found on the server’s machine, so generation will
        refuse until there is one. Run <code>{command}</code> there, sign in, and reload this
        page — nothing needs to be pasted here, and no token is ever stored by this app.
      </p>
    );
  }

  // Only Codex is blocked by an expired token: Claude Code's can be refreshed on the way out.
  if (entry.expired && !claude) {
    return (
      <p className="admin__warn">
        The <code>codex</code> login on the server has expired. Run <code>codex</code> once on
        that machine to refresh it — the CLI keeps its own token current, and this app
        deliberately does not refresh it, because doing so would rotate the token out from
        under the CLI and break its session.
      </p>
    );
  }

  const plan = claude ? status.claudeCode.subscriptionType : status.codex.planType;
  const where = claude
    ? status.claudeCode.source === 'keychain'
      ? 'the macOS keychain'
      : '~/.claude/.credentials.json'
    : '~/.codex/auth.json';

  return (
    <p className="admin__note">
      Signed in{plan ? ` on a ${plan} plan` : ''}, read from {where} on the server. Calls are
      billed to that subscription rather than to this deployment, so the budget ceiling below
      does not apply to them and they are recorded at zero.
      {claude && entry.expired && (
        <> The stored token has expired; it will be refreshed automatically on the next call.</>
      )}
    </p>
  );
}
