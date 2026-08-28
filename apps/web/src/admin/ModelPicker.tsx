/**
 * Choosing a model.
 *
 * This was a text box with a `<datalist>` behind it. Two things were wrong with that. A
 * datalist is a suggestion most people never discover, so in practice the control was "type
 * the exact id from memory" — and it listed every model in the pricing table regardless of
 * provider, so picking OpenAI still offered you Claude models that could not possibly work.
 *
 * What replaced it is a list you can read. The reason it shows **weight** rather than only
 * names is a specific failure: a subscription meters each model on its own allowance, so the
 * heavy one can be refused for hours while the light one answers every request. When that
 * happens the fix is to pick something lighter — and that is impossible to do from a list of
 * bare identifiers, which is exactly the position a live deployment was left in.
 *
 * The typed-in id survives, behind a "custom" row. Providers ship models faster than this
 * list can be updated, and a chooser that cannot express next week's model is a chooser
 * someone has to work around.
 */

// The registry entry, not the package root. The root is Node-only and pulls `node:crypto` in
// behind it, which a browser bundle cannot resolve.
import { modelsFor, pricingFor, isPricingKnown, type ProviderId } from '@flyvendedk799/ai-auth/registry';

const TIER_LABEL = {
  light: 'light',
  balanced: 'balanced',
  heavy: 'heavy',
} as const;

export interface ModelPickerProps {
  provider: ProviderId;
  value: string;
  onChange: (model: string) => void;
  /** Subscriptions have no per-token price to show, only an allowance to spend. */
  metered: boolean;
}

export function ModelPicker({ provider, value, onChange, metered }: ModelPickerProps) {
  const models = modelsFor(provider);
  const known = models.some((model) => model.id === value);
  // Custom stays selected while the field is empty, so clearing it does not silently jump the
  // selection back to a catalogued model the user did not choose.
  const custom = !known;

  return (
    <div className="models">
      <span className="admin__label">Model</span>

      <div className="models__list" role="radiogroup" aria-label="Model">
        {models.map((model) => {
          const rate = pricingFor(model.id);
          return (
            <label
              key={model.id}
              className="models__row"
              data-selected={value === model.id ? '1' : '0'}
            >
              <input
                type="radio"
                name="model"
                value={model.id}
                checked={value === model.id}
                onChange={() => onChange(model.id)}
              />
              <span className="models__body">
                <span className="models__head">
                  <strong className="models__name">{model.label}</strong>
                  <span className={`models__tier models__tier--${model.tier}`}>
                    {TIER_LABEL[model.tier]}
                  </span>
                  {metered && isPricingKnown(model.id) && (
                    <span className="models__rate">
                      ${rate.input}/${rate.output} per M
                    </span>
                  )}
                </span>
                <span className="models__note">{model.note}</span>
                <code className="models__id">{model.id}</code>
              </span>
            </label>
          );
        })}

        <label className="models__row" data-selected={custom ? '1' : '0'}>
          <input
            type="radio"
            name="model"
            checked={custom}
            // Selecting "custom" empties the field rather than keeping the last catalogued id,
            // because leaving `claude-opus-5` sitting in a box labelled "something else" is a
            // way to save a model you thought you had changed.
            onChange={() => onChange('')}
          />
          <span className="models__body">
            <span className="models__head">
              <strong className="models__name">Something else</strong>
            </span>
            <span className="models__note">
              Any id the provider accepts. Newer models work here before this list knows them.
            </span>
            {custom && (
              <input
                className="admin__input models__custom"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder={provider === 'openai' || provider === 'codex' ? 'gpt-5' : 'claude-sonnet-5'}
                spellCheck={false}
                aria-label="Model id"
              />
            )}
          </span>
        </label>
      </div>

      <p className="models__hint">
        A plan meters each model separately, so a lighter one often still works when a heavier
        one is refused.
      </p>
    </div>
  );
}
