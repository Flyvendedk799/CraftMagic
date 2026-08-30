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
import { CLAUDE_CODE_SYSTEM, type CodexIdentity } from '@flyvendedk799/ai-auth';

export const TOOL_NAME = 'emit_build_program';

const TOOL_DESCRIPTION =
  'Emit the complete build program for the requested structure. ' +
  'The tool input IS the program object itself — its top-level keys are version, meta, size, ' +
  'palette and components. Do not nest it inside any wrapper object.';

/** The diff-refine tool, offered only on refine turns (when `SessionOptions.patchSchema` is set). */
export const PATCH_TOOL_NAME = 'edit_build_program';

const PATCH_TOOL_DESCRIPTION =
  'Edit the existing build program with a short list of ops, addressed to component ids. ' +
  'Prefer this for targeted changes — everything the ops do not touch is preserved exactly. ' +
  `For a sweeping redesign, call ${TOOL_NAME} with the complete program instead.`;

export interface ProviderReply {
  /** Whatever the model passed as the tool input. May be wrapped; the pipeline unwraps it. */
  input: unknown;
  usage: TokenUsage;
  /** Which tool the input came from. Absent when only one tool was on offer. */
  tool?: string;
  /** Set when the model answered without calling the tool, for the error message. */
  noToolCallReason?: string;
}

/**
 * A picture the model is asked to build from.
 *
 * Base64 rather than a URL: the picture is a crop made in the browser a moment ago and has no
 * address anywhere, and giving a provider a URL it would have to fetch is a way of asking it
 * to reach a machine it cannot see.
 */
export interface ProviderImage {
  /** Base64 payload, with no data-URL prefix. */
  data: string;
  /** `image/png`, `image/jpeg`, `image/webp` or `image/gif`. */
  mediaType: string;
}

export interface ProviderSession {
  /** The opening request. A picture, when given, is what the words are about. */
  emit(userContent: string, image?: ProviderImage): Promise<ProviderReply>;
  /** Feed the problems back and ask for a corrected program. Valid only after `emit`. */
  repair(problems: string): Promise<ProviderReply>;
}

export interface SessionOptions {
  model: string;
  system: string;
  /**
   * A system block placed ahead of `system`, when the credential requires one.
   *
   * A Claude Code subscription token has to open with the CLI's own identity sentence or
   * Anthropic refuses Opus and Sonnet — with a 429 naming a rate limit the plan is nowhere
   * near. Haiku is exempt, which is what makes the bug so good at hiding: the cheap model you
   * reach for to test with is the one model that does not need this.
   *
   * Its own field rather than something the caller prepends to `system`, because it has to be
   * its own *block*. Concatenating it onto the front of the prompt is refused just the same.
   */
  systemPrefix?: string;
  schema: unknown;
  /**
   * When set, a second tool — `edit_build_program`, taking this schema — is offered beside
   * the emit tool and the model chooses. Set on refine turns only: a diff against nothing is
   * meaningless, and forcing the emit tool everywhere else keeps first generations simple.
   */
  patchSchema?: unknown;
  /**
   * Mark the user turn as a prompt-cache breakpoint (Anthropic only; the others cache on
   * their own). Worth it exactly when the turn is large and will be resent — a refine carries
   * the whole existing program, and the repair round resends the entire conversation.
   */
  cacheUserContent?: boolean;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
  /** Coarse progress: how many components have streamed in so far. */
  onComponents?: (count: number) => void;
  /**
   * The raw tool-call JSON accumulated so far, on every delta.
   *
   * Unthrottled and unparsed on purpose: what to make of a prefix — and how often — is the
   * pipeline's decision, and the sessions' only job is to not lose the stream. This is what
   * feeds the live 3D preview; `onComponents` remains the cheap count for anything that
   * only wants a number.
   */
  onPartial?: (partialJson: string) => void;
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
  /**
   * Every `tool_use` id in the last assistant turn, not just the one we read.
   *
   * The API's rule is total: a message following a turn that made tool calls must answer
   * *all* of them, in that one message. Answering only the call we cared about is a 400 —
   *
   *   messages.2: `tool_use` ids were found without `tool_result` blocks immediately after
   *
   * — which is a strange thing to be told when your tool was invoked correctly and you replied
   * to it. Holding one id was fine for as long as the model returned one block, and became a
   * failed generation the moment it returned four.
   */
  private lastToolUseIds: string[] = [];

  constructor(
    private readonly client: Anthropic,
    private readonly options: SessionOptions,
  ) {}

  async emit(userContent: string, image?: ProviderImage): Promise<ProviderReply> {
    // A refine's user turn carries the whole existing program, and the repair round resends
    // the conversation — so the pipeline asks for a cache breakpoint on it. On an ordinary
    // generation the turn is a sentence and a marker would waste one of the four breakpoints
    // a request is allowed.
    const text: Anthropic.TextBlockParam = {
      type: 'text',
      text: userContent,
      ...(this.options.cacheUserContent ? { cache_control: { type: 'ephemeral' as const } } : {}),
    };
    this.messages.push({
      role: 'user',
      content: image
        ? [
            // The picture first: a model reads the instructions knowing what they are about,
            // and Anthropic's own guidance is that an image ahead of its prompt does better.
            {
              type: 'image',
              source: { type: 'base64', media_type: image.mediaType as 'image/png', data: image.data },
            },
            text,
          ]
        : this.options.cacheUserContent
          ? [text]
          : userContent,
    });
    return this.call();
  }

  async repair(problems: string): Promise<ProviderReply> {
    // Still a misuse check, but on the right thing. It used to test the tool id, which
    // conflated "nobody has called emit()" with "the model answered in prose" — the second
    // is a normal outcome the branch below handles.
    if (this.messages.length === 0) throw new Error('repair() called before emit()');
    const [answered, ...alsoCalled] = this.lastToolUseIds;

    // No tool call to answer — the model replied in prose. A tool_result would be invalid
    // here, so the problems go back as an ordinary message.
    if (answered === undefined) {
      this.messages.push({ role: 'user', content: problems });
      return this.call();
    }

    this.messages.push({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: answered, content: problems, is_error: true },
        // The rest get an answer too, because the API requires one, and an honest one: their
        // output was never looked at. Silently dropping them is the 400.
        ...alsoCalled.map((id) => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: 'Not read — only the first program in a turn is used. Emit exactly one.',
          is_error: true,
        })),
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
        // identical on every generation, so after the first call it bills at a tenth. Any
        // identity block in front of it stays uncached: one sentence is below the cache
        // minimum, and each marker spends one of the four breakpoints a request is allowed.
        system: [
          ...(this.options.systemPrefix
            ? [{ type: 'text' as const, text: this.options.systemPrefix }]
            : []),
          { type: 'text' as const, text: this.options.system, cache_control: { type: 'ephemeral' as const } },
        ],
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
          ...(this.options.patchSchema
            ? [
                {
                  name: PATCH_TOOL_NAME,
                  description: PATCH_TOOL_DESCRIPTION,
                  input_schema: this.options.patchSchema as Anthropic.Tool.InputSchema,
                },
              ]
            : []),
        ],
        // One call per turn. The program is a single object, so a second copy of it is never
        // what anyone wanted — and a turn with several calls in it is what produced the 400
        // above. Asking for one is better than coping with four. With the patch tool on
        // offer the choice widens to "any" — a tool call is still required, but which of the
        // two is the model's decision, which is the whole point of offering both.
        tool_choice: this.options.patchSchema
          ? { type: 'any', disable_parallel_tool_use: true }
          : { type: 'tool', name: TOOL_NAME, disable_parallel_tool_use: true },
        messages: this.messages,
      },
      this.options.signal ? { signal: this.options.signal } : undefined,
    );

    let seen = 0;
    stream.on('inputJson', (partial: string) => {
      this.options.onPartial?.(partial);
      const count = countComponents(partial);
      if (count > seen) {
        seen = count;
        this.options.onComponents?.(count);
      }
    });

    const message = await stream.finalMessage();
    // Kept so the repair round can attach its tool_result to this exact assistant turn.
    this.messages.push({ role: 'assistant', content: message.content });

    // Every id, including calls to tools we never registered: the rule is about the ids in
    // the turn, not about the ones we find interesting.
    const allToolUse = message.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    this.lastToolUseIds = allToolUse.map((block) => block.id);

    const toolUse = allToolUse.find(
      (block) => block.name === TOOL_NAME || block.name === PATCH_TOOL_NAME,
    );

    return {
      input: toolUse?.input,
      usage: message.usage,
      ...(toolUse ? { tool: toolUse.name } : {}),
      noToolCallReason: toolUse ? undefined : `stop_reason: ${message.stop_reason}`,
    };
  }
}

/**
 * @param client Injectable so the session's message bookkeeping can be tested without a
 *   network. The shape of what we send is exactly what a live call hides behind a 400.
 */
export function anthropicProvider(
  apiKey: string,
  client: Anthropic = new Anthropic({
    apiKey,
    // Finer tool-JSON deltas, so the live preview assembles smoothly instead of in bursts.
    // The subscription provider already sends this flag; the plain key path gets it here.
    defaultHeaders: { 'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14' },
  }),
): Provider {
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
 * see `ClaudeCodeCredential` in `@flyvendedk799/ai-auth`.
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

      // A promise, assigned synchronously — the same shape `clientFor` above uses, and for the
      // same reason. Holding the resolved session instead means the `??=` has to await inside
      // its own right-hand side, so two concurrent callers both find it unset, both build a
      // session, and one of them is then talking to a thread the other is not. The pipeline
      // calls emit and repair strictly in sequence so it could not happen today; it is written
      // this way so that it cannot start happening when something else calls in.
      let inner: Promise<ProviderSession> | null = null;
      const sessionFor = () =>
        (inner ??= clientFor().then(
          // The identity block belongs to the *credential*, not to the caller's prompt, so it
          // is attached here — the one place that knows this call is paid for by a plan.
          (client) => new AnthropicSession(client, { ...options, systemPrefix: CLAUDE_CODE_SYSTEM }),
        ));

      return {
        emit: async (userContent, image) => (await sessionFor()).emit(userContent, image),
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

  async emit(userContent: string, image?: ProviderImage): Promise<ProviderReply> {
    this.messages.push({
      role: 'user',
      content: image
        ? [
            { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } },
            { type: 'text', text: userContent },
          ]
        : userContent,
    });
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
          ...(this.options.patchSchema
            ? [
                {
                  type: 'function' as const,
                  function: {
                    name: PATCH_TOOL_NAME,
                    description: PATCH_TOOL_DESCRIPTION,
                    parameters: this.options.patchSchema as Record<string, unknown>,
                    strict: false,
                  },
                },
              ]
            : []),
        ],
        // Same shape as the Anthropic choice: forced onto the one tool normally, "some tool,
        // your pick" when the patch tool is also on offer.
        tool_choice: this.options.patchSchema
          ? ('required' as const)
          : { type: 'function' as const, function: { name: TOOL_NAME } },
        stream: true,
        stream_options: { include_usage: true },
        messages: this.messages,
      },
      this.options.signal ? { signal: this.options.signal } : undefined,
    );

    let argsJson = '';
    let callId: string | null = null;
    let calledTool: string | null = null;
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
      if (call.function?.name) calledTool = call.function.name;
      if (call.function?.arguments) {
        argsJson += call.function.arguments;
        this.options.onPartial?.(argsJson);
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
    const toolName = calledTool ?? TOOL_NAME;
    this.messages.push({
      role: 'assistant',
      tool_calls: [{ id: callId, type: 'function', function: { name: toolName, arguments: argsJson } }],
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

    return { input, usage, tool: toolName };
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

  async emit(userContent: string, image?: ProviderImage): Promise<ProviderReply> {
    if (!image) return this.call([{ role: 'user', content: userContent }]);
    return this.call([
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: `data:${image.mediaType};base64,${image.data}` },
          { type: 'input_text', text: userContent },
        ],
      },
    ]);
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
          ...(this.options.patchSchema
            ? [
                {
                  type: 'function' as const,
                  name: PATCH_TOOL_NAME,
                  description: PATCH_TOOL_DESCRIPTION,
                  parameters: this.options.patchSchema as Record<string, unknown>,
                  strict: false,
                },
              ]
            : []),
        ],
        tool_choice: this.options.patchSchema ? 'required' : { type: 'function', name: TOOL_NAME },
        ...(this.previousResponseId ? { previous_response_id: this.previousResponseId } : {}),
        stream: true,
      } as never,
      this.options.signal ? { signal: this.options.signal } : undefined,
    );

    let argsJson = '';
    let calledTool: string | null = null;
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
        this.options.onPartial?.(argsJson);
        const count = countComponents(argsJson);
        if (count > seen) {
          seen = count;
          this.options.onComponents?.(count);
        }
        continue;
      }

      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
        this.lastCallId = event.item.call_id ?? event.item.id ?? this.lastCallId;
        calledTool = event.item.name ?? calledTool;
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
    return { input: parsed, usage, tool: calledTool ?? TOOL_NAME };
  }
}

/** The subset of the Responses stream this reads. Narrowed by hand because the shape is the */
/** ChatGPT backend's rather than the published SDK's, and only these fields are load-bearing. */
interface CodexStreamEvent {
  type?: string;
  delta?: string;
  item?: { type?: string; call_id?: string; id?: string; name?: string };
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

      // A promise, assigned synchronously — the same shape `clientFor` above uses, and for the
      // same reason. Holding the resolved session instead means the `??=` has to await inside
      // its own right-hand side, so two concurrent callers both find it unset, both build a
      // session, and one of them is then talking to a thread the other is not. The pipeline
      // calls emit and repair strictly in sequence so it could not happen today; it is written
      // this way so that it cannot start happening when something else calls in.
      let inner: Promise<ProviderSession> | null = null;
      const sessionFor = () =>
        (inner ??= clientFor().then((client) => new CodexSession(client, options)));

      return {
        emit: async (userContent, image) => (await sessionFor()).emit(userContent, image),
        repair: async (problems) => (await sessionFor()).repair(problems),
      };
    },
  };
}


export function providerFor(id: ProviderId, apiKey: string): Provider {
  return id === 'openai' ? openAiProvider(apiKey) : anthropicProvider(apiKey);
}
