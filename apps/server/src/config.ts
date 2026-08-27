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
  openaiApiKey: string | undefined;
  /** Model used for build generation. */
  anthropicModel: 'claude-sonnet-5' | 'claude-opus-5' | 'claude-haiku-4-5';
  /** Hard ceiling on Anthropic spend per calendar month, in USD. */
  monthlyBudgetUsd: number;
  spendLedgerPath: string;
  /** Force this account to be an admin at boot. See index.ts for why. */
  /**
   * Where Codex subscription calls go.
   *
   * A setting because this endpoint belongs to a client rather than to a published API, so it
   * can move — and a moved endpoint should be a config change, not a release.
   */
  codexBaseUrl: string | undefined;
  adminEmail: string | undefined;
  sessionSecret: string;
  isProduction: boolean;
}

function requiredInProduction(name: string, value: string | undefined, isProduction: boolean): string {
  if (value) return value;
  if (isProduction) {
    // Named concretely, because this throw happens before the logger exists and the only
    // place it surfaces is a container log somebody has to go looking for.
    throw new Error(
      `${name} must be set in production. Set it in the service's environment ` +
        `(any 32+ random bytes, e.g. \`openssl rand -base64 32\`). It is not generated ` +
        `automatically on purpose: a fresh value on every restart would sign every user out.`,
    );
  }
  return `dev-only-${name.toLowerCase()}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === 'production';
  const port = Number.parseInt(env.PORT ?? '3016', 10);

  // ServerHoster injects `PUBLIC_URL` when a domain is attached, so accept it as an alias.
  // Getting this wrong is quiet and nasty: publicOrigin would fall back to localhost, the
  // Origin check would reject the real site, and the pairing and schematic URLs handed to
  // the mod would point at the container's own loopback.
  const publicOrigin = (env.PUBLIC_ORIGIN ?? env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    publicOrigin,
    webDist: env.WEB_DIST ?? path.join(repoRoot, 'apps/web/dist'),
    databaseUrl: env.DATABASE_URL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    anthropicModel: (env.CRAFTMAGIC_MODEL as Config['anthropicModel']) ?? 'claude-sonnet-5',
    // Defaults low on purpose. A missing or unparseable value must not mean "unlimited".
    monthlyBudgetUsd: parsePositive(env.ANTHROPIC_MONTHLY_BUDGET_USD, 1),
    spendLedgerPath: resolveLedgerPath(env),
    codexBaseUrl: env.CODEX_BASE_URL?.trim() || undefined,
    adminEmail: env.ADMIN_EMAIL?.trim().toLowerCase() || undefined,
    sessionSecret: requiredInProduction('SESSION_SECRET', env.SESSION_SECRET, isProduction),
    isProduction,
  };
}

/**
 * Where the spend ledger lives.
 *
 * `DATA_DIR` is ServerHoster's persistent volume, and it matters more here than anywhere else
 * in the config: the container filesystem is replaced on every rebuild, so a ledger inside the
 * image resets the month's recorded spend to zero each deploy. The budget ceiling would then
 * be "$N per deploy" rather than "$N per month" — the guard would still look like it worked
 * while silently permitting several times the intended spend.
 */
function resolveLedgerPath(env: NodeJS.ProcessEnv): string {
  if (env.ANTHROPIC_SPEND_LEDGER) return path.resolve(repoRoot, env.ANTHROPIC_SPEND_LEDGER);
  if (env.DATA_DIR) return path.join(env.DATA_DIR, 'spend', 'ledger.json');
  return path.resolve(repoRoot, '.spend/ledger.json');
}

function parsePositive(raw: string | undefined, fallback: number): number {
  const value = Number.parseFloat(raw ?? '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
