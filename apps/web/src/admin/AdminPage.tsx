/**
 * Admin settings: the AI provider, its model, and the keys.
 *
 * The key fields start empty and stay empty, because the server never sends a key back — only
 * a masked hint of the one installed. That shapes the whole form: leaving a field blank means
 * "keep what is there", and the page says so rather than letting someone assume an empty box
 * means no key is set and that saving will not disturb it.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../library/auth.js';
import { loadSettings, saveSettings, type AdminSettings, type ProviderId } from './admin.js';
import './admin.css';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; settings: AdminSettings }
  | { status: 'error'; message: string };

const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'OpenAI',
};

const KEY_PLACEHOLDER: Record<ProviderId, string> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
};

export function AdminPage() {
  const auth = useAuth();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [provider, setProvider] = useState<ProviderId>('anthropic');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
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
          <p className="admin__sub">Which model generates builds, and the key it uses.</p>
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
                      setModel(id === 'openai' ? 'gpt-5' : 'claude-sonnet-5');
                      setKey('');
                    }}
                  />
                  <span>{PROVIDER_LABEL[id]}</span>
                  <span className="admin__provider-key">
                    {(id === 'openai' ? settings.openaiKeyHint : settings.anthropicKeyHint) ?? 'no key'}
                  </span>
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

            {!settings.pricingKnown && (
              <p className="admin__warn">
                No published rate is known for <code>{settings.model}</code>, so the budget guard
                assumes ${settings.pricing.input}/M in and ${settings.pricing.output}/M out. That is
                deliberately pessimistic — spending stops early rather than overshooting.
              </p>
            )}

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
