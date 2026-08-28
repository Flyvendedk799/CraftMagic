/**
 * Turning a provider's failure into a sentence someone can act on.
 *
 * The mapping lives in `@flyvendedk799/ai-auth`; what stays here is the one thing the library
 * cannot know, which is what this application calls the place these are changed. Half of the
 * messages end in an instruction, and an instruction that cannot say *where* is markedly less
 * useful than one that can.
 */

import { describeProviderError as describe, type ModelId, type ProviderId } from '@flyvendedk799/ai-auth';

/** What the admin page is called, in the words the messages should use. */
const CONFIGURE_AT = 'Settings';

export function describeProviderError(
  error: unknown,
  provider: ProviderId,
  model: ModelId,
): string | null {
  return describe(error, provider, model, { configureAt: CONFIGURE_AT });
}
