/**
 * Admin settings client.
 *
 * A key is write-only from here. The server sends back a masked hint and never the value, so
 * this module has no way to display an existing key and does not pretend to: the field is
 * always empty, and leaving it empty means "keep the one already installed".
 */

export type ProviderId = 'anthropic' | 'openai';

export interface AdminSettings {
  provider: ProviderId;
  model: string;
  keySource: 'settings' | 'environment' | 'none';
  anthropicKeyHint: string | null;
  openaiKeyHint: string | null;
  providers: ProviderId[];
  knownModels: string[];
  pricingKnown: boolean;
  pricing: { input: number; output: number };
  spend: {
    spentThisMonthUsd: number;
    remainingUsd: number;
    monthlyBudgetUsd: number;
    callsThisMonth: number;
  };
}

export interface SettingsUpdate {
  provider?: ProviderId;
  model?: string;
  /** Empty string clears the stored key; omitted leaves it untouched. */
  anthropicKey?: string;
  openaiKey?: string;
}

async function request(method: 'GET' | 'PUT', body?: unknown): Promise<Response> {
  return fetch('/api/admin/settings', {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function loadSettings(): Promise<AdminSettings> {
  const response = await request('GET');
  if (response.status === 404) throw new Error('You do not have access to these settings.');
  if (!response.ok) throw new Error(await describe(response));
  return (await response.json()) as AdminSettings;
}

export async function saveSettings(update: SettingsUpdate): Promise<void> {
  const response = await request('PUT', update);
  if (!response.ok) throw new Error(await describe(response));
}

async function describe(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
