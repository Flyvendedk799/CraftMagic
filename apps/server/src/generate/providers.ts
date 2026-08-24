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
        output_config: { effort: this.options.effort ?? 'medium' },
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

export function providerFor(id: ProviderId, apiKey: string): Provider {
  return id === 'openai' ? openAiProvider(apiKey) : anthropicProvider(apiKey);
}
