import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, whether running from `src/` (tsx/strip-types) or `dist/`. */
export const repoRoot = path.resolve(here, '../../..');

export interface Config {
  port: number;
  host: string;
  /** Public origin, used to build absolute URLs handed to the mod. */
  publicOrigin: string;
  webDist: string;
  databaseUrl: string | undefined;
  anthropicApiKey: string | undefined;
  /** Model used for build generation. */
  anthropicModel: 'claude-sonnet-5' | 'claude-opus-5' | 'claude-haiku-4-5';
  /** Hard ceiling on Anthropic spend per calendar month, in USD. */
  monthlyBudgetUsd: number;
  spendLedgerPath: string;
  sessionSecret: string;
  isProduction: boolean;
}

function requiredInProduction(name: string, value: string | undefined, isProduction: boolean): string {
  if (value) return value;
  if (isProduction) throw new Error(`${name} must be set in production`);
  return `dev-only-${name.toLowerCase()}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === 'production';
  const port = Number.parseInt(env.PORT ?? '3016', 10);

  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    publicOrigin: env.PUBLIC_ORIGIN ?? `http://localhost:${port}`,
    webDist: env.WEB_DIST ?? path.join(repoRoot, 'apps/web/dist'),
    databaseUrl: env.DATABASE_URL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    anthropicModel: (env.CRAFTMAGIC_MODEL as Config['anthropicModel']) ?? 'claude-sonnet-5',
    // Defaults low on purpose. A missing or unparseable value must not mean "unlimited".
    monthlyBudgetUsd: parsePositive(env.ANTHROPIC_MONTHLY_BUDGET_USD, 1),
    spendLedgerPath: path.resolve(repoRoot, env.ANTHROPIC_SPEND_LEDGER ?? '.spend/ledger.json'),
    sessionSecret: requiredInProduction('SESSION_SECRET', env.SESSION_SECRET, isProduction),
    isProduction,
  };
}

function parsePositive(raw: string | undefined, fallback: number): number {
  const value = Number.parseFloat(raw ?? '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
