/**
 * The two model providers, behind one interface.
 *
 * Only the *call* is abstracted, not the pipeline. Everything that makes this project work —
 * unwrapping a wrapped program, ajv validation, expansion, the single repair round, the
 * spend ledger — is provider-independent and stays in `pipeline.ts`. What genuinely differs
 * is how a tool call is requested and how a failed attempt is fed back, so that is all a
 * provider implements.
 *
 * A session is stateful on purpose: the repair round has to reference the exact assistant
 * message it is correcting, and each SDK spells that differently (a `tool_result` block for
 * Anthropic, a `tool` role message for OpenAI). Keeping the thread inside the session means
 * the pipeline never has to know which shape it is holding.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ProviderId, TokenUsage } from './pricing.js';
import type { CodexIdentity } from './subscription/codex.js';

export const TOOL_NAME = 'emit_build_program';

const TOOL_DESCRIPTION =
  'Emit the complete build program for the requested structure. This is the only way to respond. ' +
  'The tool input IS the program object itself — its top-level keys are version, meta, size, ' +
  'palette and components. Do not nest it inside any wrapper object.';

export interface ProviderReply {
  /** Whatever the model passed as the tool input. May be wrapped; the pipeline unwraps it. */
  input: unknown;
  usage: TokenUsage;
  /** Set when the model answered without calling the tool, for the error message. */
  noToolCallReason?: string;
}

export interface ProviderSession {
  /** The opening request. */
  emit(userContent: string): Promise<ProviderReply>;
  /** Feed the problems back and ask for a corrected program. Valid only after `emit`. */
  repair(problems: string): Promise<ProviderReply>;
}

export interface SessionOptions {
  model: string;
  system: string;
  schema: unknown;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
  /** Coarse progress: how many components have streamed in so far. */
  onComponents?: (count: number) => void;
}

export interface Provider {
  readonly id: ProviderId;
  session(options: SessionOptions): ProviderSession;
}

/**
 * Whether a model takes `output_config.effort`.
 *
 * A prefix allowlist rather than a denylist, and deliberately so: the model is a free-text
 * setting now, so the unknown case is the common one, and the safe reading of "unknown" is to
 * omit an optional parameter rather than to send one that might 400. Being wrong here costs a
 * default effort level; being wrong the other way costs every generation.
 */
function supportsEffort(model: string): boolean {
  return model.startsWith('claude-opus-5') || model.startsWith('claude-sonnet-5');
}

/** Count components as their JSON streams in, so a UI can show assembly rather than a spinner. */
function countComponents(partialJson: string): number {
  return (partialJson.match(/"type"\s*:/g) ?? []).length;
}

// --- Anthropic ----------------------------------------------------------------------------

class AnthropicSession implements ProviderSession {
  private readonly messages: Anthropic.MessageParam[] = [];
  private lastToolUseId: string | null = null;

  constructor(
    private readonly client: Anthropic,
    private readonly options: SessionOptions,
  ) {}

  async emit(userContent: string): Promise<ProviderReply> {
    this.messages.push({ role: 'user', content: userContent });
    return this.call();
  }

  async repair(problems: string): Promise<ProviderReply> {
    if (!this.lastToolUseId) throw new Error('repair() called before emit()');
    this.messages.push({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: this.lastToolUseId, content: problems, is_error: true },
      ],
    });
    return this.call();
  }

  private async call(): Promise<ProviderReply> {
    const stream = this.client.messages.stream(
      {
        model: this.options.model,
        max_tokens: this.options.maxTokens,
        // Marking the system prompt cacheable is the single biggest cost lever here: it is
        // identical on every generation, so after the first call it bills at a tenth.
        system: [{ type: 'text', text: this.options.system, cache_control: { type: 'ephemeral' } }],
        // Only where it is accepted. `output_config` is an adaptive-thinking feature, and a
        // model without it rejects the whole request with a 400 rather than ignoring the
        // field — which turned typing a model name into the settings box into a way to break
        // generation with an error that names a parameter nobody chose.
        ...(supportsEffort(this.options.model)
          ? { output_config: { effort: this.options.effort ?? 'medium' } }
          : {}),
        tools: [
          {
            name: TOOL_NAME,
            description: TOOL_DESCRIPTION,
            input_schema: this.options.schema as Anthropic.Tool.InputSchema,
            // NOT strict: group children are components, a circular `$ref` that strict tool
            // use rejects outright. ajv and the expander enforce it on our side instead.
          },
        ],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: this.messages,
      },
      this.options.signal ? { signal: this.options.signal } : undefined,
    );

    let seen = 0;
    stream.on('inputJson', (partial: string) => {
      const count = countComponents(partial);
      if (count > seen) {
        seen = count;
        this.options.onComponents?.(count);
      }
    });

    const message = await stream.finalMessage();
    // Kept so the repair round can attach its tool_result to this exact assistant turn.
    this.messages.push({ role: 'assistant', content: message.content });

    const toolUse = message.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === TOOL_NAME,
    );
    this.lastToolUseId = toolUse?.id ?? this.lastToolUseId;

    return {
      input: toolUse?.input,
      usage: message.usage,
      noToolCallReason: toolUse ? undefined : `stop_reason: ${message.stop_reason}`,
    };
  }
}

export function anthropicProvider(apiKey: string): Provider {
  const client = new Anthropic({ apiKey });
  return {
    id: 'anthropic',
    session: (options) => new AnthropicSession(client, options),
  };
}

/**
 * Claude Code's pinned CLI version, and the beta flags that go with it.
 *
 * A subscription token is only honoured for requests that identify themselves as Claude Code:
 * `oauth-2025-04-20` is the flag that says "this Authorization header is an OAuth token, not
 * a key", and the user-agent and `x-app` are what community Anthropic gateways gate on. The
 * version pin is cosmetic to Anthropic and load-bearing to those gateways.
 */
const CLAUDE_CODE_VERSION = '2.1.75';
const CLAUDE_CODE_BETA = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'fine-grained-tool-streaming-2025-05-14',
  'interleaved-thinking-2025-05-14',
].join(',');

/**
 * The same Anthropic wire, paid for by a subscription instead of a key.
 *
 * The session is `AnthropicSession` unchanged, and that is the whole point: the endpoint, the
 * Messages API, the tool call, the streaming and the repair round are identical, and the only
 * thing that differs is who is billed. Abstracting anything else would have been inventing a
 * difference that is not there.
 *
 * `authToken` rather than `apiKey`, and this is the one detail that has to be exactly right:
 * the SDK sends `Authorization: Bearer` for the former and `x-api-key` for the latter, and
 * Anthropic validates `x-api-key` whenever the header is *present*. A placeholder key
 * alongside a valid bearer token does not get ignored — it gets rejected, and the request
 * fails with "invalid x-api-key" while carrying a perfectly good credential. So the key is
 * left unset and only the bearer goes on the wire.
 *
 * The token is fetched per session rather than held, because it is refreshed behind our back:
 * see `subscription/claudeCode.ts`.
 */
export function claudeCodeProvider(getToken: () => Promise<string>): Provider {
  return {
    id: 'claude-code',
    session: (options) => {
      // Built lazily, once, on the first call of the session: the repair round has to run
      // against the same client, and asking for a token before anyone has asked for a
      // generation would read the credential store on every page load.
      let client: Promise<Anthropic> | null = null;
      const clientFor = () => {
        client ??= getToken().then(
          (authToken) =>
            new Anthropic({
              authToken,
              // Explicit, not merely omitted: the SDK otherwise falls back to
              // ANTHROPIC_API_KEY from the environment, and a deployment that has both a key
              // and a subscription would send the key alongside the bearer and 401.
              apiKey: null,
              defaultHeaders: {
                'anthropic-beta': CLAUDE_CODE_BETA,
                'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}`,
                'x-app': 'cli',
              },
            }),
        );
        return client;
      };

      let inner: ProviderSession | null = null;
      const sessionFor = async () => (inner ??= new AnthropicSession(await clientFor(), options));

      return {
        emit: async (userContent) => (await sessionFor()).emit(userContent),
        repair: async (problems) => (await sessionFor()).repair(problems),
      };
    },
  };
}

// --- OpenAI -------------------------------------------------------------------------------

class OpenAiSession implements ProviderSession {
  private readonly messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  private lastToolCallId: string | null = null;

  constructor(
    private readonly client: OpenAI,
    private readonly options: SessionOptions,
  ) {
    this.messages.push({ role: 'system', content: options.system });
  }

  async emit(userContent: string): Promise<ProviderReply> {
    this.messages.push({ role: 'user', content: userContent });
    return this.call();
  }

  async repair(problems: string): Promise<ProviderReply> {
    if (!this.lastToolCallId) throw new Error('repair() called before emit()');
    // OpenAI feeds a failed tool call back as a `tool` role message keyed by call id — the
    // same idea as Anthropic's tool_result block, spelled differently.
    this.messages.push({ role: 'tool', tool_call_id: this.lastToolCallId, content: problems });
    return this.call();
  }

  private async call(): Promise<ProviderReply> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.options.model,
        max_completion_tokens: this.options.maxTokens,
        tools: [
          {
            type: 'function',
            function: {
              name: TOOL_NAME,
              description: TOOL_DESCRIPTION,
              parameters: this.options.schema as Record<string, unknown>,
              // Same reason as Anthropic: structured-output mode rejects the circular `$ref`
              // that `group` needs.
              strict: false,
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: TOOL_NAME } },
        stream: true,
        stream_options: { include_usage: true },
        messages: this.messages,
      },
      this.options.signal ? { signal: this.options.signal } : undefined,
    );

    let argsJson = '';
    let callId: string | null = null;
    let seen = 0;
    let usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      // Usage arrives on its own final chunk when include_usage is set.
      if (chunk.usage) {
        usage = {
          input_tokens: chunk.usage.prompt_tokens,
          output_tokens: chunk.usage.completion_tokens,
          // OpenAI reports cached prompt tokens as a subset of prompt_tokens rather than a
          // separate bucket, so they are recorded here for pricing without being subtracted.
          cache_read_input_tokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }

      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const call = choice.delta?.tool_calls?.[0];
      if (!call) continue;
      if (call.id) callId = call.id;
      if (call.function?.arguments) {
        argsJson += call.function.arguments;
        const count = countComponents(argsJson);
        if (count > seen) {
          seen = count;
          this.options.onComponents?.(count);
        }
      }
    }

    if (!callId || !argsJson) {
      return { input: undefined, usage, noToolCallReason: `finish_reason: ${finishReason ?? 'unknown'}` };
    }

    this.lastToolCallId = callId;
    this.messages.push({
      role: 'assistant',
      tool_calls: [{ id: callId, type: 'function', function: { name: TOOL_NAME, arguments: argsJson } }],
    });

    // Arguments arrive as a JSON string. A malformed one is not fatal: the pipeline's
    // unwrapping already handles a program that arrived stringified, and the repair round
    // exists for exactly this.
    let input: unknown;
    try {
      input = JSON.parse(argsJson);
    } catch {
      input = argsJson;
    }

    return { input, usage };
  }
}

export function openAiProvider(apiKey: string): Provider {
  const client = new OpenAI({ apiKey });
  return {
    id: 'openai',
    session: (options) => new OpenAiSession(client, options),
  };
}


// --- Codex / ChatGPT subscription -----------------------------------------------------------

/**
 * Where a ChatGPT subscription's Codex calls go.
 *
 * Not `api.openai.com`: a subscription token is not an API key and the metered API will not
 * accept one. The CLI talks to the ChatGPT backend instead, which speaks the **Responses**
 * API rather than Chat Completions — a different request shape, which is why this cannot
 * simply reuse `OpenAiSession` the way the Claude Code provider reuses `AnthropicSession`.
 *
 * Overridable, and that is not hypothetical: this endpoint belongs to a client, not to a
 * published API, so it can move. A setting means a moved endpoint is a config change rather
 * than a release.
 */
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/**
 * The Responses API, driven for one forced tool call.
 *
 * Three things differ from Chat Completions and each fails loudly if missed:
 *
 *   - The system prompt is `instructions` at the top level, **not** a message in `input`.
 *     Strict Responses endpoints reject a request that carries a system-role entry in `input`
 *     while leaving `instructions` empty.
 *   - A tool is flat — `{ type, name, parameters }` — rather than nested under `function`.
 *   - The reply is an output *array*, and the tool call is an item in it with its arguments
 *     as a JSON string, rather than a `tool_calls` array hanging off a message.
 *
 * The repair round threads by `previous_response_id` instead of resending the conversation:
 * the backend already has the turn, and re-uploading a rejected 40kB program to ask for a fix
 * would be paying twice for the same context.
 */
class CodexSession implements ProviderSession {
  private previousResponseId: string | null = null;
  private lastCallId: string | null = null;

  constructor(
    private readonly client: OpenAI,
    private readonly options: SessionOptions,
  ) {}

  async emit(userContent: string): Promise<ProviderReply> {
    return this.call([{ role: 'user', content: userContent }]);
  }

  async repair(problems: string): Promise<ProviderReply> {
    if (!this.lastCallId) throw new Error('repair() called before emit()');
    // The Responses equivalent of Anthropic's `tool_result` block: an output item answering
    // the call by id, which is what lets the model see what it got wrong.
    return this.call([{ type: 'function_call_output', call_id: this.lastCallId, output: problems }]);
  }

  private async call(input: unknown[]): Promise<ProviderReply> {
    const stream = await this.client.responses.create(
      {
        model: this.options.model,
        instructions: this.options.system,
        input: input as never,
        max_output_tokens: this.options.maxTokens,
        tools: [
          {
            type: 'function',
            name: TOOL_NAME,
            description: TOOL_DESCRIPTION,
            parameters: this.options.schema as Record<string, unknown>,
            // Same reason as both other providers: `group` children are components, a
            // circular `$ref` that strict mode rejects outright.
            strict: false,
          },
        ],
        tool_choice: { type: 'function', name: TOOL_NAME },
        ...(this.previousResponseId ? { previous_response_id: this.previousResponseId } : {}),
        stream: true,
      } as never,
      this.options.signal ? { signal: this.options.signal } : undefined,
    );

    let argsJson = '';
    let seen = 0;
    let usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
    let status: string | null = null;

    // Double cast: the overload picked for a hand-built `as never` params object returns the
    // non-streaming shape, and `stream: true` is what actually decides. The event shape is
    // narrowed by `CodexStreamEvent` below rather than trusted.
    for await (const raw of stream as unknown as AsyncIterable<unknown>) {
      const event = raw as CodexStreamEvent;

      if (event.type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
        argsJson += event.delta;
        const count = countComponents(argsJson);
        if (count > seen) {
          seen = count;
          this.options.onComponents?.(count);
        }
        continue;
      }

      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
        this.lastCallId = event.item.call_id ?? event.item.id ?? this.lastCallId;
        continue;
      }

      // The terminal events carry the id the next turn threads from, and the usage.
      if (event.response?.id) this.previousResponseId = event.response.id;
      if (event.response?.status) status = event.response.status;
      if (event.response?.usage) {
        usage = {
          input_tokens: event.response.usage.input_tokens ?? 0,
          output_tokens: event.response.usage.output_tokens ?? 0,
          cache_read_input_tokens: event.response.usage.input_tokens_details?.cached_tokens ?? 0,
        };
      }
    }

    if (!argsJson) {
      return { input: undefined, usage, noToolCallReason: `status: ${status ?? 'unknown'}` };
    }

    // Arguments arrive as a JSON string. A malformed one is not fatal: the pipeline's
    // unwrapping already copes with a stringified program, and the repair round exists for
    // exactly this.
    let parsed: unknown;
    try {
      parsed = JSON.parse(argsJson);
    } catch {
      parsed = argsJson;
    }
    return { input: parsed, usage };
  }
}

/** The subset of the Responses stream this reads. Narrowed by hand because the shape is the */
/** ChatGPT backend's rather than the published SDK's, and only these fields are load-bearing. */
interface CodexStreamEvent {
  type?: string;
  delta?: string;
  item?: { type?: string; call_id?: string; id?: string };
  response?: {
    id?: string;
    status?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };
}

/**
 * Codex, on a ChatGPT subscription.
 *
 * The identity is read per session for the same reason the Claude Code token is: the `codex`
 * CLI owns the credential and refreshes it on its own schedule, so a client built once from
 * one would go on presenting a stale token until this process restarted.
 */
export function codexProvider(
  getIdentity: () => Promise<CodexIdentity>,
  baseUrl = CODEX_BASE_URL,
): Provider {
  return {
    id: 'codex',
    session: (options) => {
      let client: Promise<OpenAI> | null = null;
      const clientFor = () => {
        client ??= getIdentity().then(
          (identity) =>
            new OpenAI({
              apiKey: identity.accessToken,
              baseURL: baseUrl,
              defaultHeaders: {
                // Which subscription to bill. Without it the backend cannot attribute the
                // call and refuses it.
                ...(identity.accountId ? { 'chatgpt-account-id': identity.accountId } : {}),
                originator: 'codex_cli_ts',
              },
            }),
        );
        return client;
      };

      let inner: ProviderSession | null = null;
      const sessionFor = async () => (inner ??= new CodexSession(await clientFor(), options));

      return {
        emit: async (userContent) => (await sessionFor()).emit(userContent),
        repair: async (problems) => (await sessionFor()).repair(problems),
      };
    },
  };
}


export function providerFor(id: ProviderId, apiKey: string): Provider {
  return id === 'openai' ? openAiProvider(apiKey) : anthropicProvider(apiKey);
}
