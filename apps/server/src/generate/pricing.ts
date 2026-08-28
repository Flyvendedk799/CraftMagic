/**
 * Model pricing and provider identity.
 *
 * Lives in `@flyvendedk799/ai-auth` now, along with the credential handling it is inseparable
 * from — whether a call is billed per token or to a plan is the same question as how it
 * authenticates, and splitting the two across two repositories would mean answering it twice.
 *
 * Re-exported through this module rather than imported directly at the twenty-odd call sites,
 * because the path is not the interesting part of any of them and a package rename should not
 * be a twenty-file diff.
 */

export {
  costOf,
  formatUsd,
  FREE,
  isPricingKnown,
  isSubscription,
  PRICING,
  pricingFor,
  providerOf,
  SUBSCRIPTION_PROVIDERS,
  UNKNOWN_MODEL_PRICING,
  wireOf,
  worstCaseCost,
  type CostBreakdown,
  type ModelId,
  type ModelPricing,
  type ProviderId,
  type TokenUsage,
} from '@flyvendedk799/ai-auth';
